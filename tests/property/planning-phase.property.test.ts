import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { OrchestrationSessionManager } from '../../src/subsystems/orchestration-session-manager.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { arbitraryStructuredIntent } from '../generators/structured-intent.generator.js';
import { arbitraryPlanModification } from '../generators/plan.generator.js';
import type {
  StructuredIntent,
  OrchestrationSession,
  OrchestrationState,
  OrchestrationEvent,
  WorkspaceContext,
  PlanningContext,
  GeneratedPlan,
  SpawnRequest,
  SpawnResult,
} from '../../src/interfaces/orchestration-config.js';
import type { IIntentResolver } from '../../src/interfaces/intent-resolver.js';
import type { IWorkspaceResolver } from '../../src/interfaces/workspace-resolver.js';
import type { IAgentSpawner } from '../../src/interfaces/agent-spawner.js';
import type { IOperatorInterface, SystemEvent, EventChannel } from '../../src/interfaces/operator-interface.js';
import type { ITaskPlannerMinimal } from '../../src/subsystems/orchestration-session-manager.js';
import type { AgentHarnessConfig } from '../../src/interfaces/orchestration-config.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockIntentResolver(): IIntentResolver {
  return {
    async parseIntent(message, operatorId) {
      return {
        id: 'intent-mock',
        sourceType: 'operator',
        sourceId: operatorId,
        action: message,
        confidence: 0.9,
        rawInput: message,
        parsedAt: new Date(),
      };
    },
    async requestClarification(partialIntent, reason) {
      return {
        sessionId: partialIntent.id ?? 'unknown',
        question: `Please clarify: ${reason}`,
        context: reason,
      };
    },
    getConfidenceThreshold() {
      return 0.7;
    },
    setConfidenceThreshold() {},
  };
}

function createMockWorkspaceResolver(): IWorkspaceResolver {
  return {
    async resolve() {
      return {
        id: 'ws-mock',
        repositoryUrl: 'https://github.com/test/repo',
        localPath: '/tmp/c2-workspaces/github.com/test/repo',
        branch: 'main',
        defaultBranch: 'main',
        environment: {},
        lastUsedAt: new Date(),
        createdAt: new Date(),
      };
    },
    async validate() {
      return true;
    },
    normalizeRepoRef(ref) {
      return ref.toLowerCase();
    },
    async listWorkspaces() {
      return [];
    },
    async evict() {},
  };
}

function createMockAgentSpawner(): IAgentSpawner {
  return {
    async spawn(request: SpawnRequest): Promise<SpawnResult> {
      return {
        agentId: `agent-${request.orchestrationSessionId.slice(0, 8)}`,
        sessionId: `session-${request.orchestrationSessionId.slice(0, 8)}`,
        reused: false,
      };
    },
    canSpawn() {
      return { allowed: true };
    },
    getHarnessConfig(): AgentHarnessConfig {
      return {
        command: 'node',
        args: [],
        defaultCapabilities: {},
      };
    },
    setHarnessConfig() {},
  };
}

function createMockTaskPlanner(options?: {
  generatePlanFn?: (context: PlanningContext) => Promise<GeneratedPlan>;
  regeneratePlanFn?: (context: PlanningContext, prev: GeneratedPlan, instructions: string) => Promise<GeneratedPlan>;
}): ITaskPlannerMinimal {
  return {
    async generatePlan(context: PlanningContext): Promise<GeneratedPlan> {
      if (options?.generatePlanFn) {
        return options.generatePlanFn(context);
      }
      return {
        steps: [
          {
            instructions: `Execute: ${context.intent.action}`,
            executionMode: 'agent',
          },
        ],
        reasoning: 'Generated from intent',
      };
    },
    async submitPlan(plan, agentId, operatorId): Promise<string> {
      return `task-${agentId.slice(0, 8)}`;
    },
    async regeneratePlan(context, previousPlan, modificationInstructions): Promise<GeneratedPlan> {
      if (options?.regeneratePlanFn) {
        return options.regeneratePlanFn(context, previousPlan, modificationInstructions);
      }
      return {
        steps: [
          {
            instructions: `Modified: ${modificationInstructions}`,
            executionMode: 'agent',
          },
        ],
        reasoning: 'Regenerated from modification instructions',
      };
    },
  };
}

function createMockOperatorInterface(): IOperatorInterface & { events: SystemEvent[] } {
  const events: SystemEvent[] = [];
  return {
    events,
    handleConnection() {},
    broadcastEvent(channel: EventChannel, event: SystemEvent) {
      events.push(event);
    },
  };
}

function createTestStack(options?: {
  taskPlanner?: ITaskPlannerMinimal;
}) {
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const operatorInterface = createMockOperatorInterface();

  const manager = new OrchestrationSessionManager({
    intentResolver: createMockIntentResolver(),
    workspaceResolver: createMockWorkspaceResolver(),
    agentSpawner: createMockAgentSpawner(),
    taskPlanner: options?.taskPlanner ?? createMockTaskPlanner(),
    policyEngine,
    auditLog,
    operatorInterface,
  });

  return { manager, auditLog, policyEngine, operatorInterface };
}

/**
 * Helper: advance a session from intent_received to awaiting_plan_approval.
 */
async function advanceToAwaitingPlanApproval(
  manager: InstanceType<typeof OrchestrationSessionManager>,
  sessionId: string,
): Promise<OrchestrationSession> {
  let session = manager.getSession(sessionId)!;
  // intent_received → resolving_workspace → spawning_agent → planning_task → awaiting_plan_approval
  while (session.state !== 'awaiting_plan_approval' && session.state !== 'failed') {
    session = await manager.advance(sessionId);
  }
  return session;
}

/**
 * The valid state transitions as defined in the design document.
 */
const VALID_TRANSITIONS: Record<OrchestrationState, OrchestrationState[]> = {
  intent_received: ['resolving_workspace', 'pending_approval', 'failed'],
  pending_approval: ['resolving_workspace', 'failed'],
  resolving_workspace: ['spawning_agent', 'failed'],
  spawning_agent: ['planning_task', 'failed'],
  planning_task: ['awaiting_plan_approval', 'executing', 'failed'],
  awaiting_plan_approval: ['executing', 'planning_task', 'failed'],
  executing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

// ---------------------------------------------------------------------------
// Property Tests — Orchestration Planning Phase
// ---------------------------------------------------------------------------

describe('Orchestration Planning Phase Property Tests', () => {

  // --------------------------------------------------------------------------
  // Property 1: Extended state machine validity
  //
  // For any orchestration session, state transitions SHALL only follow valid
  // edges in the extended state machine graph. The advance() method SHALL NOT
  // transition a session out of awaiting_plan_approval — only explicit operator
  // actions (approvePlan, modifyPlan, rejectPlan, cancel) SHALL move the session
  // from that state.
  //
  // Feature: orchestration-planning-phase, Property 1: Extended state machine validity
  // Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 2.5
  // --------------------------------------------------------------------------
  describe('Property 1: Extended state machine validity', () => {
    it('all transitions from all states follow valid edges including awaiting_plan_approval', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            const transitions: Array<{ from: OrchestrationState; to: OrchestrationState }> = [];

            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              const prevState = current.state;
              if (current.state === 'awaiting_plan_approval') {
                current = await manager.approvePlan(current.id, operatorId);
              } else {
                current = await manager.advance(current.id);
              }
              transitions.push({ from: prevState, to: current.state });
            }

            // Every transition must be in the valid set.
            for (const t of transitions) {
              const validTargets = VALID_TRANSITIONS[t.from];
              expect(validTargets).toContain(t.to);
            }

            // awaiting_plan_approval must appear in the lifecycle (manual mode default).
            const visitedAwaitingPlan = transitions.some(
              (t) => t.to === 'awaiting_plan_approval' || t.from === 'awaiting_plan_approval',
            );
            expect(visitedAwaitingPlan).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('advance() cannot move session out of awaiting_plan_approval', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            const advanced = await advanceToAwaitingPlanApproval(manager, session.id);
            expect(advanced.state).toBe('awaiting_plan_approval');

            // advance() must throw from awaiting_plan_approval.
            await expect(manager.advance(session.id)).rejects.toThrow(
              /awaiting plan approval/,
            );

            // Session state must remain unchanged.
            const afterAttempt = manager.getSession(session.id)!;
            expect(afterAttempt.state).toBe('awaiting_plan_approval');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('only approvePlan, modifyPlan, rejectPlan, cancel can move from awaiting_plan_approval', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.constantFrom('approve', 'modify', 'reject', 'cancel'),
          async (intent, operatorId, action) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            let result: OrchestrationSession;
            switch (action) {
              case 'approve':
                result = await manager.approvePlan(session.id, operatorId);
                expect(result.state).toBe('executing');
                expect(VALID_TRANSITIONS['awaiting_plan_approval']).toContain('executing');
                break;
              case 'modify':
                result = await manager.modifyPlan(session.id, 'Add a test step', operatorId);
                expect(result.state).toBe('awaiting_plan_approval');
                // Modification goes through planning_task and back.
                expect(VALID_TRANSITIONS['awaiting_plan_approval']).toContain('planning_task');
                expect(VALID_TRANSITIONS['planning_task']).toContain('awaiting_plan_approval');
                break;
              case 'reject':
                result = await manager.rejectPlan(session.id, 'Not suitable', operatorId);
                expect(result.state).toBe('failed');
                expect(VALID_TRANSITIONS['awaiting_plan_approval']).toContain('failed');
                break;
              case 'cancel':
                await manager.cancel(session.id, 'Cancelled by operator', operatorId);
                result = manager.getSession(session.id)!;
                expect(result.state).toBe('failed');
                expect(VALID_TRANSITIONS['awaiting_plan_approval']).toContain('failed');
                break;
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('planning_task → awaiting_plan_approval is a valid transition', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            // Advance to planning_task.
            let current = session;
            while (current.state !== 'planning_task' && current.state !== 'failed') {
              current = await manager.advance(current.id);
            }
            expect(current.state).toBe('planning_task');

            // Advance from planning_task should go to awaiting_plan_approval (manual mode).
            current = await manager.advance(current.id);
            expect(current.state).toBe('awaiting_plan_approval');
            expect(VALID_TRANSITIONS['planning_task']).toContain('awaiting_plan_approval');
          },
        ),
        { numRuns: 100 },
      );
    });
  });


  // --------------------------------------------------------------------------
  // Property 3: Plan approval submits and transitions to executing
  //
  // For any session in awaiting_plan_approval with a stored plan, calling
  // approvePlan SHALL submit the stored plan to the TaskOrchestrator, set
  // codingTaskId on the session, and transition the session to executing.
  //
  // Feature: orchestration-planning-phase, Property 3: Plan approval submits and transitions to executing
  // Validates: Requirements 2.1, 2.2
  // --------------------------------------------------------------------------
  describe('Property 3: Plan approval submits and transitions to executing', () => {
    it('approvePlan submits plan and transitions to executing with codingTaskId', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const submittedPlans: Array<{ plan: GeneratedPlan; agentId: string; operatorId: string }> = [];
            const taskPlanner = createMockTaskPlanner();
            const originalSubmitPlan = taskPlanner.submitPlan.bind(taskPlanner);
            taskPlanner.submitPlan = async (plan, agentId, opId) => {
              submittedPlans.push({ plan, agentId, operatorId: opId });
              return originalSubmitPlan(plan, agentId, opId);
            };

            const { manager } = createTestStack({ taskPlanner });

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            // Verify session has a stored plan before approval.
            const beforeApproval = manager.getSession(session.id)!;
            expect(beforeApproval.state).toBe('awaiting_plan_approval');
            expect(beforeApproval.currentPlan).toBeDefined();
            expect(beforeApproval.currentPlan!.planId).toBeTruthy();

            // Approve the plan.
            const approved = await manager.approvePlan(session.id, operatorId);

            // Property assertions:
            // 1. Session transitions to executing.
            expect(approved.state).toBe('executing');

            // 2. codingTaskId is set on the session.
            expect(approved.codingTaskId).toBeTruthy();

            // 3. The plan was submitted to the TaskOrchestrator.
            expect(submittedPlans.length).toBe(1);
            expect(submittedPlans[0].plan.steps).toEqual(beforeApproval.currentPlan!.steps);
            expect(submittedPlans[0].plan.reasoning).toEqual(beforeApproval.currentPlan!.reasoning);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('approvePlan throws when session is not in awaiting_plan_approval', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            // Session is in intent_received, not awaiting_plan_approval.
            expect(session.state).toBe('intent_received');

            await expect(
              manager.approvePlan(session.id, operatorId),
            ).rejects.toThrow(/not in 'awaiting_plan_approval' state/);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('approvePlan throws for non-existent session', async () => {
      await fc.assert(
        fc.asyncProperty(fc.uuid(), fc.uuid(), async (sessionId, operatorId) => {
          const { manager } = createTestStack();

          await expect(
            manager.approvePlan(sessionId, operatorId),
          ).rejects.toThrow(/not found/);
        }),
        { numRuns: 100 },
      );
    });
  });


  // --------------------------------------------------------------------------
  // Property 5: Plan rejection transitions to failed with reason
  //
  // For any session in awaiting_plan_approval and any non-empty rejection reason,
  // calling rejectPlan SHALL transition the session to failed with failureReason
  // equal to the provided reason. Similarly, calling cancel from
  // awaiting_plan_approval SHALL transition to failed with the cancellation reason.
  //
  // Feature: orchestration-planning-phase, Property 5: Plan rejection transitions to failed with reason
  // Validates: Requirements 2.4, 4.5, 4.6
  // --------------------------------------------------------------------------
  describe('Property 5: Plan rejection transitions to failed with reason', () => {
    it('rejectPlan transitions to failed with the provided reason', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
          async (intent, operatorId, reason) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            const beforeReject = manager.getSession(session.id)!;
            expect(beforeReject.state).toBe('awaiting_plan_approval');

            // Reject the plan.
            const rejected = await manager.rejectPlan(session.id, reason, operatorId);

            // Property assertions:
            // 1. Session transitions to failed.
            expect(rejected.state).toBe('failed');

            // 2. failureReason equals the provided reason.
            expect(rejected.failureReason).toBe(reason);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('cancel from awaiting_plan_approval transitions to failed with cancellation reason', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
          async (intent, operatorId, reason) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            const beforeCancel = manager.getSession(session.id)!;
            expect(beforeCancel.state).toBe('awaiting_plan_approval');

            // Cancel the session.
            await manager.cancel(session.id, reason, operatorId);

            // Property assertions:
            const cancelled = manager.getSession(session.id)!;
            // 1. Session transitions to failed.
            expect(cancelled.state).toBe('failed');

            // 2. failureReason equals the provided reason.
            expect(cancelled.failureReason).toBe(reason);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('rejectPlan throws when session is not in awaiting_plan_approval', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (intent, operatorId, reason) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            // Session is in intent_received.
            expect(session.state).toBe('intent_received');

            await expect(
              manager.rejectPlan(session.id, reason, operatorId),
            ).rejects.toThrow(/not in 'awaiting_plan_approval' state/);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('rejectPlan preserves the plan on the session after rejection', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (intent, operatorId, reason) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            const beforeReject = manager.getSession(session.id)!;
            const planBeforeReject = beforeReject.currentPlan;
            expect(planBeforeReject).toBeDefined();

            await manager.rejectPlan(session.id, reason, operatorId);

            // Plan remains accessible after rejection.
            const afterReject = manager.getSession(session.id)!;
            expect(afterReject.currentPlan).toEqual(planBeforeReject);
          },
        ),
        { numRuns: 100 },
      );
    });
  });


  // --------------------------------------------------------------------------
  // Property 8: Plan persistence on session
  //
  // For any session that generates a plan, currentPlan is populated with unique
  // planId. Plan remains accessible via getSession() after terminal state.
  // planRevisionHistory contains entry for every plan generated.
  //
  // Feature: orchestration-planning-phase, Property 8: Plan persistence on session
  // Validates: Requirements 5.1, 5.3, 5.4, 1.5
  // --------------------------------------------------------------------------
  describe('Property 8: Plan persistence on session', () => {
    it('currentPlan is populated with unique planId after plan generation', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            const current = manager.getSession(session.id)!;

            // Property assertions:
            // 1. currentPlan is populated.
            expect(current.currentPlan).toBeDefined();

            // 2. planId is a non-empty string.
            expect(current.currentPlan!.planId).toBeTruthy();
            expect(typeof current.currentPlan!.planId).toBe('string');

            // 3. Plan has steps and reasoning.
            expect(current.currentPlan!.steps.length).toBeGreaterThan(0);
            expect(current.currentPlan!.reasoning).toBeTruthy();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('plan remains accessible via getSession() after terminal state (completed)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            // Advance to completion.
            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              if (current.state === 'awaiting_plan_approval') {
                current = await manager.approvePlan(current.id, operatorId);
              } else {
                current = await manager.advance(current.id);
              }
            }

            // Property assertion: plan is still accessible after terminal state.
            const terminal = manager.getSession(session.id)!;
            expect(terminal.state).toBe('completed');
            expect(terminal.currentPlan).toBeDefined();
            expect(terminal.currentPlan!.planId).toBeTruthy();
            expect(terminal.currentPlan!.steps.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('plan remains accessible via getSession() after terminal state (failed via rejection)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (intent, operatorId, reason) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);
            await manager.rejectPlan(session.id, reason, operatorId);

            // Property assertion: plan is still accessible after failed state.
            const terminal = manager.getSession(session.id)!;
            expect(terminal.state).toBe('failed');
            expect(terminal.currentPlan).toBeDefined();
            expect(terminal.currentPlan!.planId).toBeTruthy();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('planRevisionHistory contains entry for every plan generated', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.integer({ min: 0, max: 3 }),
          async (intent, operatorId, modificationCount) => {
            const { manager } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            // Perform modifications.
            for (let i = 0; i < modificationCount; i++) {
              await manager.modifyPlan(session.id, `Modification ${i + 1}`, operatorId);
            }

            const current = manager.getSession(session.id)!;

            // Property assertions:
            // 1. planRevisionHistory is defined.
            expect(current.planRevisionHistory).toBeDefined();

            // 2. History contains exactly (1 initial + modificationCount) entries.
            const expectedEntries = 1 + modificationCount;
            expect(current.planRevisionHistory!.length).toBe(expectedEntries);

            // 3. Each entry has a unique planId.
            const planIds = current.planRevisionHistory!.map((e) => e.planId);
            const uniquePlanIds = new Set(planIds);
            expect(uniquePlanIds.size).toBe(expectedEntries);

            // 4. Each entry has a generatedAt date.
            for (const entry of current.planRevisionHistory!) {
              expect(entry.generatedAt).toBeInstanceOf(Date);
            }

            // 5. The currentPlan's planId matches the last entry's planId.
            expect(current.currentPlan!.planId).toBe(
              current.planRevisionHistory![current.planRevisionHistory!.length - 1].planId,
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('planId is unique across different sessions', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            arbitraryStructuredIntent().map((intent) => ({
              ...intent,
              sourceType: 'operator' as const,
              repository: 'test/repo',
            })),
            { minLength: 2, maxLength: 5 },
          ),
          fc.uuid(),
          async (intents, operatorId) => {
            const { manager } = createTestStack();

            const planIds: string[] = [];
            for (const intent of intents) {
              const session = await manager.createSession(intent, operatorId);
              await advanceToAwaitingPlanApproval(manager, session.id);
              const s = manager.getSession(session.id)!;
              planIds.push(s.currentPlan!.planId);
            }

            // All planIds should be unique.
            const uniqueIds = new Set(planIds);
            expect(uniqueIds.size).toBe(planIds.length);
          },
        ),
        { numRuns: 100 },
      );
    });
  });


  // --------------------------------------------------------------------------
  // Property 9: Plan lifecycle WebSocket events contain required fields
  //
  // All plan events include sessionId, timestamp, operatorId.
  // plan_ready and plan_revised events include full plan payload.
  //
  // Feature: orchestration-planning-phase, Property 9: Plan lifecycle WebSocket events contain required fields
  // Validates: Requirements 1.3, 8.1, 8.3, 8.6
  // --------------------------------------------------------------------------
  describe('Property 9: Plan lifecycle WebSocket events contain required fields', () => {
    it('plan_ready event includes sessionId, timestamp, operatorId, and full plan payload', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager, operatorInterface } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            // Find the plan_ready event.
            const planReadyEvents = operatorInterface.events.filter(
              (e) => e.type === 'plan_ready',
            );
            expect(planReadyEvents.length).toBe(1);

            const event = planReadyEvents[0];
            const data = event.data as Record<string, unknown>;

            // Property assertions:
            // 1. Event includes sessionId.
            expect(data.sessionId).toBe(session.id);

            // 2. Event includes timestamp.
            expect(event.timestamp).toBeInstanceOf(Date);

            // 3. Event includes operatorId.
            expect(data.operatorId).toBe(operatorId);

            // 4. Event includes full plan payload.
            const plan = data.plan as Record<string, unknown>;
            expect(plan).toBeDefined();
            expect(plan.planId).toBeTruthy();
            expect(Array.isArray(plan.steps)).toBe(true);
            expect((plan.steps as unknown[]).length).toBeGreaterThan(0);
            expect(plan.reasoning).toBeTruthy();

            // 5. Each step has instructions and executionMode.
            for (const step of plan.steps as Array<Record<string, unknown>>) {
              expect(step.instructions).toBeTruthy();
              expect(step.executionMode).toBeTruthy();
            }

            // 6. Event includes revisionNumber.
            expect(data.revisionNumber).toBe(1);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('plan_approved event includes sessionId, timestamp, operatorId, and codingTaskId', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager, operatorInterface } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);
            await manager.approvePlan(session.id, operatorId);

            // Find the plan_approved event.
            const planApprovedEvents = operatorInterface.events.filter(
              (e) => e.type === 'plan_approved',
            );
            expect(planApprovedEvents.length).toBe(1);

            const event = planApprovedEvents[0];
            const data = event.data as Record<string, unknown>;

            // Property assertions:
            expect(data.sessionId).toBe(session.id);
            expect(event.timestamp).toBeInstanceOf(Date);
            expect(data.operatorId).toBe(operatorId);
            expect(data.codingTaskId).toBeTruthy();
            expect(data.planId).toBeTruthy();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('plan_rejected event includes sessionId, timestamp, operatorId, and reason', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (intent, operatorId, reason) => {
            const { manager, operatorInterface } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);
            await manager.rejectPlan(session.id, reason, operatorId);

            // Find the plan_rejected event.
            const planRejectedEvents = operatorInterface.events.filter(
              (e) => e.type === 'plan_rejected',
            );
            expect(planRejectedEvents.length).toBe(1);

            const event = planRejectedEvents[0];
            const data = event.data as Record<string, unknown>;

            // Property assertions:
            expect(data.sessionId).toBe(session.id);
            expect(event.timestamp).toBeInstanceOf(Date);
            expect(data.operatorId).toBe(operatorId);
            expect(data.reason).toBe(reason);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('plan_revised event includes sessionId, timestamp, operatorId, full plan payload, revisionNumber, and previousPlanId', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          arbitraryPlanModification(),
          async (intent, operatorId, modification) => {
            const { manager, operatorInterface } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);

            // Get the initial planId before modification.
            const beforeModify = manager.getSession(session.id)!;
            const initialPlanId = beforeModify.currentPlan!.planId;

            // Modify the plan.
            await manager.modifyPlan(session.id, modification, operatorId);

            // Find the plan_revised event.
            const planRevisedEvents = operatorInterface.events.filter(
              (e) => e.type === 'plan_revised',
            );
            expect(planRevisedEvents.length).toBe(1);

            const event = planRevisedEvents[0];
            const data = event.data as Record<string, unknown>;

            // Property assertions:
            // 1. Required fields.
            expect(data.sessionId).toBe(session.id);
            expect(event.timestamp).toBeInstanceOf(Date);
            expect(data.operatorId).toBe(operatorId);

            // 2. Full plan payload.
            const plan = data.plan as Record<string, unknown>;
            expect(plan).toBeDefined();
            expect(plan.planId).toBeTruthy();
            expect(Array.isArray(plan.steps)).toBe(true);
            expect((plan.steps as unknown[]).length).toBeGreaterThan(0);
            expect(plan.reasoning).toBeTruthy();

            // 3. Revision number (should be 2 after one modification).
            expect(data.revisionNumber).toBe(2);

            // 4. Previous plan ID.
            expect(data.previousPlanId).toBe(initialPlanId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('plan_regenerating event includes sessionId, operatorId, and modificationInstructions', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          arbitraryPlanModification(),
          async (intent, operatorId, modification) => {
            const { manager, operatorInterface } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);
            await manager.modifyPlan(session.id, modification, operatorId);

            // Find the plan_regenerating event.
            const planRegeneratingEvents = operatorInterface.events.filter(
              (e) => e.type === 'plan_regenerating',
            );
            expect(planRegeneratingEvents.length).toBe(1);

            const event = planRegeneratingEvents[0];
            const data = event.data as Record<string, unknown>;

            // Property assertions:
            expect(data.sessionId).toBe(session.id);
            expect(event.timestamp).toBeInstanceOf(Date);
            expect(data.operatorId).toBe(operatorId);
            expect(data.modificationInstructions).toBe(modification);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('all plan lifecycle events have valid channel format', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager, operatorInterface } = createTestStack();

            const session = await manager.createSession(intent, operatorId);
            await advanceToAwaitingPlanApproval(manager, session.id);
            await manager.modifyPlan(session.id, 'Add tests', operatorId);
            await manager.approvePlan(session.id, operatorId);

            // All plan-related events should have the correct channel.
            const planEventTypes = ['plan_ready', 'plan_regenerating', 'plan_revised', 'plan_approved'];
            const planEvents = operatorInterface.events.filter((e) =>
              planEventTypes.includes(e.type),
            );

            expect(planEvents.length).toBeGreaterThan(0);
            for (const event of planEvents) {
              expect(event.channel).toBe(`session:${session.id}`);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
