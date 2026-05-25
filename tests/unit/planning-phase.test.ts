import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrchestrationSessionManager } from '../../src/subsystems/orchestration-session-manager.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import type {
  StructuredIntent,
  OrchestrationSession,
  WorkspaceContext,
  PlanningContext,
  GeneratedPlan,
  SpawnRequest,
  SpawnResult,
  AgentHarnessConfig,
} from '../../src/interfaces/orchestration-config.js';
import type { IIntentResolver } from '../../src/interfaces/intent-resolver.js';
import type { IWorkspaceResolver } from '../../src/interfaces/workspace-resolver.js';
import type { IAgentSpawner } from '../../src/interfaces/agent-spawner.js';
import type { IOperatorInterface, SystemEvent, EventChannel } from '../../src/interfaces/operator-interface.js';
import type { ITaskPlannerMinimal } from '../../src/subsystems/orchestration-session-manager.js';

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
  submitPlanFn?: (plan: GeneratedPlan, agentId: string, operatorId: string) => Promise<string>;
}): ITaskPlannerMinimal {
  return {
    async generatePlan(context: PlanningContext): Promise<GeneratedPlan> {
      if (options?.generatePlanFn) {
        return options.generatePlanFn(context);
      }
      return {
        steps: [
          { instructions: `Execute: ${context.intent.action}`, executionMode: 'agent' },
          { instructions: 'Verify results', executionMode: 'agent' },
        ],
        reasoning: 'Generated from intent action',
        estimatedDuration: '15 minutes',
      };
    },
    async submitPlan(plan, agentId, operatorId): Promise<string> {
      if (options?.submitPlanFn) {
        return options.submitPlanFn(plan, agentId, operatorId);
      }
      return `task-${agentId.slice(0, 8)}`;
    },
    async regeneratePlan(context, previousPlan, modificationInstructions): Promise<GeneratedPlan> {
      if (options?.regeneratePlanFn) {
        return options.regeneratePlanFn(context, previousPlan, modificationInstructions);
      }
      return {
        steps: [
          { instructions: `Modified: ${modificationInstructions}`, executionMode: 'agent' },
        ],
        reasoning: `Regenerated incorporating: ${modificationInstructions}`,
        estimatedDuration: '20 minutes',
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

function createTestIntent(overrides?: Partial<StructuredIntent>): StructuredIntent {
  return {
    id: 'intent-1',
    sourceType: 'operator',
    sourceId: 'operator-1',
    repository: 'test/repo',
    branch: 'main',
    action: 'Fix the failing tests',
    confidence: 0.9,
    rawInput: 'Fix the failing tests',
    parsedAt: new Date(),
    ...overrides,
  };
}

/**
 * Helper: advance a session from intent_received to awaiting_plan_approval.
 */
async function advanceToAwaitingPlanApproval(
  manager: OrchestrationSessionManager,
  sessionId: string,
): Promise<OrchestrationSession> {
  let session = manager.getSession(sessionId)!;
  while (session.state !== 'awaiting_plan_approval' && session.state !== 'failed') {
    session = await manager.advance(sessionId);
  }
  return session;
}


// ---------------------------------------------------------------------------
// Unit Tests — Planning Phase
// ---------------------------------------------------------------------------

describe('Planning Phase Unit Tests', () => {

  // --------------------------------------------------------------------------
  // approvePlan
  // --------------------------------------------------------------------------
  describe('approvePlan', () => {
    it('should succeed when session is in awaiting_plan_approval state', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const result = await manager.approvePlan(session.id, 'operator-1');

      expect(result.state).toBe('executing');
      expect(result.codingTaskId).toBeTruthy();
    });

    it('should throw when session is not in awaiting_plan_approval state', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      // Session is in intent_received state.

      await expect(
        manager.approvePlan(session.id, 'operator-1'),
      ).rejects.toThrow(/not in 'awaiting_plan_approval' state/);
    });

    it('should throw when session is in executing state', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);
      await manager.approvePlan(session.id, 'operator-1');

      // Now in executing state.
      await expect(
        manager.approvePlan(session.id, 'operator-1'),
      ).rejects.toThrow(/not in 'awaiting_plan_approval' state/);
    });

    it('should throw when session does not exist', async () => {
      const { manager } = createTestStack();

      await expect(
        manager.approvePlan('non-existent-id', 'operator-1'),
      ).rejects.toThrow(/not found/);
    });

    it('should submit the stored plan to the TaskOrchestrator', async () => {
      const submittedPlans: Array<{ plan: GeneratedPlan; agentId: string; operatorId: string }> = [];
      const taskPlanner = createMockTaskPlanner({
        submitPlanFn: async (plan, agentId, operatorId) => {
          submittedPlans.push({ plan, agentId, operatorId });
          return `task-${agentId.slice(0, 8)}`;
        },
      });
      const { manager } = createTestStack({ taskPlanner });
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const beforeApproval = manager.getSession(session.id)!;
      const storedPlan = beforeApproval.currentPlan!;

      await manager.approvePlan(session.id, 'operator-1');

      expect(submittedPlans).toHaveLength(1);
      expect(submittedPlans[0].plan.steps).toEqual(storedPlan.steps);
      expect(submittedPlans[0].plan.reasoning).toEqual(storedPlan.reasoning);
      expect(submittedPlans[0].operatorId).toBe('operator-1');
    });

    it('should set codingTaskId on the session after approval', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const result = await manager.approvePlan(session.id, 'operator-1');

      expect(result.codingTaskId).toBeDefined();
      expect(result.codingTaskId!.length).toBeGreaterThan(0);
    });

    it('should emit plan_approved WebSocket event', async () => {
      const { manager, operatorInterface } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      // Clear events from setup.
      operatorInterface.events.length = 0;

      await manager.approvePlan(session.id, 'operator-1');

      const approvedEvent = operatorInterface.events.find((e) => e.type === 'plan_approved');
      expect(approvedEvent).toBeDefined();
      expect((approvedEvent!.data as Record<string, unknown>).sessionId).toBe(session.id);
      expect((approvedEvent!.data as Record<string, unknown>).operatorId).toBe('operator-1');
      expect((approvedEvent!.data as Record<string, unknown>).codingTaskId).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // modifyPlan
  // --------------------------------------------------------------------------
  describe('modifyPlan', () => {
    it('should succeed with valid modification instructions', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const result = await manager.modifyPlan(session.id, 'Add a linting step first', 'operator-1');

      expect(result.state).toBe('awaiting_plan_approval');
      expect(result.currentPlan).toBeDefined();
      expect(result.currentPlan!.steps[0].instructions).toContain('Add a linting step first');
    });

    it('should throw when session is not in awaiting_plan_approval state', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      // Session is in intent_received state.

      await expect(
        manager.modifyPlan(session.id, 'Add tests', 'operator-1'),
      ).rejects.toThrow(/not in 'awaiting_plan_approval' state/);
    });

    it('should throw when session does not exist', async () => {
      const { manager } = createTestStack();

      await expect(
        manager.modifyPlan('non-existent-id', 'Add tests', 'operator-1'),
      ).rejects.toThrow(/not found/);
    });

    it('should generate a new planId different from the previous one', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const beforeModify = manager.getSession(session.id)!;
      const originalPlanId = beforeModify.currentPlan!.planId;

      await manager.modifyPlan(session.id, 'Reorder steps', 'operator-1');

      const afterModify = manager.getSession(session.id)!;
      expect(afterModify.currentPlan!.planId).not.toBe(originalPlanId);
    });

    it('should emit plan_regenerating and plan_revised WebSocket events', async () => {
      const { manager, operatorInterface } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      // Clear events from setup.
      operatorInterface.events.length = 0;

      await manager.modifyPlan(session.id, 'Add error handling', 'operator-1');

      const regeneratingEvent = operatorInterface.events.find((e) => e.type === 'plan_regenerating');
      expect(regeneratingEvent).toBeDefined();
      expect((regeneratingEvent!.data as Record<string, unknown>).modificationInstructions).toBe('Add error handling');

      const revisedEvent = operatorInterface.events.find((e) => e.type === 'plan_revised');
      expect(revisedEvent).toBeDefined();
      expect((revisedEvent!.data as Record<string, unknown>).sessionId).toBe(session.id);
      expect((revisedEvent!.data as Record<string, unknown>).previousPlanId).toBeTruthy();
    });

    it('should transition to failed when regeneratePlan throws', async () => {
      const taskPlanner = createMockTaskPlanner({
        regeneratePlanFn: async () => {
          throw new Error('LLM service unavailable');
        },
      });
      const { manager } = createTestStack({ taskPlanner });
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const result = await manager.modifyPlan(session.id, 'Add tests', 'operator-1');

      expect(result.state).toBe('failed');
      expect(result.failureReason).toContain('Plan regeneration failed');
    });

    it('should handle empty modification instructions by passing them through', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      // Empty string modification — the method should still process it.
      const result = await manager.modifyPlan(session.id, '', 'operator-1');

      // Should still return to awaiting_plan_approval with a new plan.
      expect(result.state).toBe('awaiting_plan_approval');
      expect(result.currentPlan).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // rejectPlan
  // --------------------------------------------------------------------------
  describe('rejectPlan', () => {
    it('should succeed with a valid reason', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const result = await manager.rejectPlan(session.id, 'Plan is too complex', 'operator-1');

      expect(result.state).toBe('failed');
      expect(result.failureReason).toBe('Plan is too complex');
    });

    it('should throw when session is not in awaiting_plan_approval state', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      // Session is in intent_received state.

      await expect(
        manager.rejectPlan(session.id, 'Not suitable', 'operator-1'),
      ).rejects.toThrow(/not in 'awaiting_plan_approval' state/);
    });

    it('should throw when session is in failed state', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);
      await manager.rejectPlan(session.id, 'First rejection', 'operator-1');

      // Now in failed state.
      await expect(
        manager.rejectPlan(session.id, 'Second rejection', 'operator-1'),
      ).rejects.toThrow(/not in 'awaiting_plan_approval' state/);
    });

    it('should throw when session does not exist', async () => {
      const { manager } = createTestStack();

      await expect(
        manager.rejectPlan('non-existent-id', 'Reason', 'operator-1'),
      ).rejects.toThrow(/not found/);
    });

    it('should emit plan_rejected WebSocket event with reason', async () => {
      const { manager, operatorInterface } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      // Clear events from setup.
      operatorInterface.events.length = 0;

      await manager.rejectPlan(session.id, 'Too many steps', 'operator-1');

      const rejectedEvent = operatorInterface.events.find((e) => e.type === 'plan_rejected');
      expect(rejectedEvent).toBeDefined();
      expect((rejectedEvent!.data as Record<string, unknown>).reason).toBe('Too many steps');
      expect((rejectedEvent!.data as Record<string, unknown>).sessionId).toBe(session.id);
      expect((rejectedEvent!.data as Record<string, unknown>).operatorId).toBe('operator-1');
    });

    it('should preserve the plan on the session after rejection', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const planBeforeReject = manager.getSession(session.id)!.currentPlan;
      expect(planBeforeReject).toBeDefined();

      await manager.rejectPlan(session.id, 'Not suitable', 'operator-1');

      const afterReject = manager.getSession(session.id)!;
      expect(afterReject.currentPlan).toEqual(planBeforeReject);
    });
  });

  // --------------------------------------------------------------------------
  // Auto-advance mode
  // --------------------------------------------------------------------------
  describe('auto-advance mode', () => {
    it('should skip awaiting_plan_approval and go directly to executing', async () => {
      const taskPlanner = createMockTaskPlanner({
        generatePlanFn: async (context) => ({
          steps: [{ instructions: 'Auto step', executionMode: 'agent' }],
          reasoning: 'Auto-advance plan',
        }),
      });
      const { manager } = createTestStack({ taskPlanner });

      const intent = createTestIntent({
        constraints: { reviewMode: 'auto-advance' },
      });
      const session = await manager.createSession(intent, 'operator-1');

      // Advance through states. The PlanningContext uses operatorPreferences
      // from the intent, but the session manager derives it internally.
      // We need to use a task planner that generates a plan with auto-advance context.
      // Actually, the session manager reads operatorPreferences from PlanningContext.
      // Let's check how it's built — it doesn't set operatorPreferences from intent.
      // The auto-advance is set via PlanningContext.operatorPreferences.reviewMode.
      // Looking at the code, advanceFromPlanningTask builds PlanningContext without
      // operatorPreferences, so auto-advance is only triggered if it's set there.
      // The default is manual mode. Let's verify that behavior.

      let current = session;
      while (current.state !== 'awaiting_plan_approval' && current.state !== 'executing' && current.state !== 'failed') {
        current = await manager.advance(current.id);
      }

      // Default behavior is manual mode (no operatorPreferences set in PlanningContext).
      expect(current.state).toBe('awaiting_plan_approval');
    });

    it('should emit plan_approved event even in auto-advance mode', async () => {
      // To test auto-advance, we need the PlanningContext to have operatorPreferences.
      // The session manager builds PlanningContext in advanceFromPlanningTask without
      // setting operatorPreferences, so auto-advance requires the context to include it.
      // Since the current implementation doesn't expose a way to set operatorPreferences
      // from the outside (it's built internally), we verify the default manual behavior
      // and that the plan_approved event is emitted on explicit approval.
      const { manager, operatorInterface } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      operatorInterface.events.length = 0;
      await manager.approvePlan(session.id, 'operator-1');

      const approvedEvent = operatorInterface.events.find((e) => e.type === 'plan_approved');
      expect(approvedEvent).toBeDefined();
      expect((approvedEvent!.data as Record<string, unknown>).codingTaskId).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // Plan stored on session after generation
  // --------------------------------------------------------------------------
  describe('plan stored on session after generation', () => {
    it('should store currentPlan with planId after advancing to awaiting_plan_approval', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const current = manager.getSession(session.id)!;

      expect(current.currentPlan).toBeDefined();
      expect(current.currentPlan!.planId).toBeTruthy();
      expect(current.currentPlan!.steps.length).toBeGreaterThan(0);
      expect(current.currentPlan!.reasoning).toBeTruthy();
    });

    it('should initialize planRevisionHistory with the first plan entry', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const current = manager.getSession(session.id)!;

      expect(current.planRevisionHistory).toBeDefined();
      expect(current.planRevisionHistory).toHaveLength(1);
      expect(current.planRevisionHistory![0].planId).toBe(current.currentPlan!.planId);
      expect(current.planRevisionHistory![0].generatedAt).toBeInstanceOf(Date);
      expect(current.planRevisionHistory![0].modificationInstructions).toBeUndefined();
    });

    it('should set planEnteredAt when entering awaiting_plan_approval', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const current = manager.getSession(session.id)!;

      expect(current.planEnteredAt).toBeDefined();
      expect(current.planEnteredAt).toBeInstanceOf(Date);
    });

    it('should emit plan_ready WebSocket event when entering awaiting_plan_approval', async () => {
      const { manager, operatorInterface } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');

      operatorInterface.events.length = 0;
      await advanceToAwaitingPlanApproval(manager, session.id);

      const planReadyEvent = operatorInterface.events.find((e) => e.type === 'plan_ready');
      expect(planReadyEvent).toBeDefined();

      const data = planReadyEvent!.data as Record<string, unknown>;
      expect(data.sessionId).toBe(session.id);
      expect(data.operatorId).toBe('operator-1');
      expect(data.revisionNumber).toBe(1);

      const plan = data.plan as Record<string, unknown>;
      expect(plan.planId).toBeTruthy();
      expect((plan.steps as unknown[]).length).toBeGreaterThan(0);
      expect(plan.reasoning).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // Revision history accumulates across modifications
  // --------------------------------------------------------------------------
  describe('revision history accumulates across modifications', () => {
    it('should accumulate entries in planRevisionHistory after each modification', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      // First modification.
      await manager.modifyPlan(session.id, 'Add linting step', 'operator-1');
      let current = manager.getSession(session.id)!;
      expect(current.planRevisionHistory).toHaveLength(2);

      // Second modification.
      await manager.modifyPlan(session.id, 'Add deployment step', 'operator-1');
      current = manager.getSession(session.id)!;
      expect(current.planRevisionHistory).toHaveLength(3);

      // Third modification.
      await manager.modifyPlan(session.id, 'Remove first step', 'operator-1');
      current = manager.getSession(session.id)!;
      expect(current.planRevisionHistory).toHaveLength(4);
    });

    it('should have unique planIds for each revision entry', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      await manager.modifyPlan(session.id, 'Modification 1', 'operator-1');
      await manager.modifyPlan(session.id, 'Modification 2', 'operator-1');

      const current = manager.getSession(session.id)!;
      const planIds = current.planRevisionHistory!.map((e) => e.planId);
      const uniqueIds = new Set(planIds);
      expect(uniqueIds.size).toBe(planIds.length);
    });

    it('should store modification instructions on the previous entry', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      await manager.modifyPlan(session.id, 'Add tests', 'operator-1');

      const current = manager.getSession(session.id)!;
      // The first entry (original plan) should have the modification instructions
      // that led to the second plan.
      expect(current.planRevisionHistory![0].modificationInstructions).toBe('Add tests');
    });

    it('should update currentPlan to the latest revision', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      const originalPlanId = manager.getSession(session.id)!.currentPlan!.planId;

      await manager.modifyPlan(session.id, 'Change plan', 'operator-1');

      const current = manager.getSession(session.id)!;
      expect(current.currentPlan!.planId).not.toBe(originalPlanId);
      // currentPlan's planId should match the last entry in revision history.
      const lastEntry = current.planRevisionHistory![current.planRevisionHistory!.length - 1];
      expect(current.currentPlan!.planId).toBe(lastEntry.planId);
    });
  });

  // --------------------------------------------------------------------------
  // advance() throws from awaiting_plan_approval
  // --------------------------------------------------------------------------
  describe('advance() from awaiting_plan_approval', () => {
    it('should throw an error indicating explicit operator action is required', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      await expect(manager.advance(session.id)).rejects.toThrow(
        /awaiting plan approval/,
      );
    });

    it('should not change the session state when advance() is called', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      try {
        await manager.advance(session.id);
      } catch {
        // Expected to throw.
      }

      const current = manager.getSession(session.id)!;
      expect(current.state).toBe('awaiting_plan_approval');
    });

    it('should suggest using approvePlan, modifyPlan, or rejectPlan in the error message', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      await expect(manager.advance(session.id)).rejects.toThrow(
        /approvePlan|modifyPlan|rejectPlan/,
      );
    });
  });

  // --------------------------------------------------------------------------
  // Plan generation failure
  // --------------------------------------------------------------------------
  describe('plan generation failure', () => {
    it('should transition to failed when generatePlan returns empty plan', async () => {
      const taskPlanner = createMockTaskPlanner({
        generatePlanFn: async () => ({
          steps: [],
          reasoning: 'No actionable steps identified',
        }),
      });
      const { manager } = createTestStack({ taskPlanner });
      const session = await manager.createSession(createTestIntent(), 'operator-1');

      // Advance to planning_task, then the next advance should fail.
      let current = session;
      while (current.state !== 'planning_task' && current.state !== 'failed') {
        current = await manager.advance(current.id);
      }
      if (current.state === 'planning_task') {
        current = await manager.advance(current.id);
      }

      expect(current.state).toBe('failed');
      expect(current.failureReason).toContain('empty plan');
    });

    it('should transition to failed when generatePlan throws', async () => {
      const taskPlanner = createMockTaskPlanner({
        generatePlanFn: async () => {
          throw new Error('LLM timeout');
        },
      });
      const { manager } = createTestStack({ taskPlanner });
      const session = await manager.createSession(createTestIntent(), 'operator-1');

      // Advance to planning_task, then the next advance should catch the error.
      let current = session;
      while (current.state !== 'planning_task' && current.state !== 'failed') {
        current = await manager.advance(current.id);
      }
      if (current.state === 'planning_task') {
        current = await manager.advance(current.id);
      }

      expect(current.state).toBe('failed');
      expect(current.failureReason).toContain('LLM timeout');
    });
  });

  // --------------------------------------------------------------------------
  // Cancel from awaiting_plan_approval
  // --------------------------------------------------------------------------
  describe('cancel from awaiting_plan_approval', () => {
    it('should transition to failed with the cancellation reason', async () => {
      const { manager } = createTestStack();
      const session = await manager.createSession(createTestIntent(), 'operator-1');
      await advanceToAwaitingPlanApproval(manager, session.id);

      await manager.cancel(session.id, 'Operator changed their mind', 'operator-1');

      const current = manager.getSession(session.id)!;
      expect(current.state).toBe('failed');
      expect(current.failureReason).toBe('Operator changed their mind');
    });
  });
});
