import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { OrchestrationSessionManager } from '../../src/subsystems/orchestration-session-manager.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { arbitraryStructuredIntent } from '../generators/structured-intent.generator.js';
import { arbitraryWorkspaceContext } from '../generators/workspace-context.generator.js';
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

/**
 * Create a mock IntentResolver.
 */
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

/**
 * Create a mock WorkspaceResolver that returns a predictable workspace.
 */
function createMockWorkspaceResolver(workspace?: WorkspaceContext): IWorkspaceResolver {
  const defaultWorkspace: WorkspaceContext = workspace ?? {
    id: 'ws-mock',
    repositoryUrl: 'https://github.com/test/repo',
    localPath: '/tmp/c2-workspaces/github.com/test/repo',
    branch: 'main',
    defaultBranch: 'main',
    environment: {},
    lastUsedAt: new Date(),
    createdAt: new Date(),
  };

  return {
    async resolve() {
      return defaultWorkspace;
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

/**
 * Create a mock AgentSpawner that returns a predictable spawn result.
 */
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

/**
 * Create a mock TaskPlanner that returns a simple plan.
 */
function createMockTaskPlanner(): ITaskPlannerMinimal {
  return {
    async generatePlan(context: PlanningContext): Promise<GeneratedPlan> {
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
  };
}

/**
 * Create a mock OperatorInterface that records broadcast events.
 */
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

/**
 * Create a full test stack for the OrchestrationSessionManager.
 */
function createTestStack(options?: {
  denyAutonomous?: boolean;
  workspaceResolver?: IWorkspaceResolver;
  agentSpawner?: IAgentSpawner;
  taskPlanner?: ITaskPlannerMinimal;
}) {
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const operatorInterface = createMockOperatorInterface();

  // If denyAutonomous is set, add a deny policy for autonomous sessions.
  if (options?.denyAutonomous) {
    policyEngine.addPolicy({
      id: 'guardrail-deny-all',
      version: 1,
      agentId: '*',
      operations: ['autonomous_session'],
      resources: ['*'],
      conditions: [],
      effect: 'deny',
    });
  }

  const manager = new OrchestrationSessionManager({
    intentResolver: createMockIntentResolver(),
    workspaceResolver: options?.workspaceResolver ?? createMockWorkspaceResolver(),
    agentSpawner: options?.agentSpawner ?? createMockAgentSpawner(),
    taskPlanner: options?.taskPlanner ?? createMockTaskPlanner(),
    policyEngine,
    auditLog,
    operatorInterface,
  });

  return { manager, auditLog, policyEngine, operatorInterface };
}

/**
 * The valid state transitions as defined in the design document.
 */
const VALID_TRANSITIONS: Record<OrchestrationState, OrchestrationState[]> = {
  intent_received: ['resolving_workspace', 'pending_approval', 'failed'],
  pending_approval: ['resolving_workspace', 'failed'],
  resolving_workspace: ['spawning_agent', 'failed'],
  spawning_agent: ['planning_task', 'failed'],
  planning_task: ['executing', 'failed'],
  executing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Orchestration Session Manager Property Tests', () => {
  // --------------------------------------------------------------------------
  // Property 11: Orchestration state machine validity
  //
  // State transitions only follow valid edges:
  //   intent_received → resolving_workspace → spawning_agent → planning_task
  //   → executing → completed|failed
  // with pending_approval reachable from intent_received and resumable to
  // resolving_workspace, and failed reachable from any non-terminal state.
  //
  // Feature: intent-driven-orchestration, Property 11: Orchestration state machine validity
  // Validates: Requirements 6.1, 6.5
  // --------------------------------------------------------------------------
  describe('Property 11: Orchestration state machine validity', () => {
    it('advancing a session through the full lifecycle only produces valid transitions', async () => {
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

            // Create session — starts at intent_received.
            const session = await manager.createSession(intent, operatorId);
            expect(session.state).toBe('intent_received');

            const transitions: Array<{ from: OrchestrationState; to: OrchestrationState }> = [];

            // Advance through the full lifecycle.
            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              const prevState = current.state;
              current = await manager.advance(current.id);
              transitions.push({ from: prevState, to: current.state });
            }

            // Property assertion: every transition must be in the valid set.
            for (const t of transitions) {
              const validTargets = VALID_TRANSITIONS[t.from];
              expect(validTargets).toContain(t.to);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('platform event sessions transition to pending_approval when guardrails deny', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'platform_event' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          async (intent, operatorId) => {
            const { manager } = createTestStack({ denyAutonomous: true });

            const session = await manager.createSession(intent, operatorId);

            // Property assertion: session should be in pending_approval.
            expect(session.state).toBe('pending_approval');

            // Verify this is a valid transition from intent_received.
            expect(VALID_TRANSITIONS['intent_received']).toContain('pending_approval');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('approved sessions transition from pending_approval to resolving_workspace', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'platform_event' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.uuid(),
          async (intent, operatorId, approverId) => {
            const { manager } = createTestStack({ denyAutonomous: true });

            const session = await manager.createSession(intent, operatorId);
            expect(session.state).toBe('pending_approval');

            // Approve the session.
            const approved = await manager.approve(session.id, approverId);

            // Property assertion: valid transition from pending_approval.
            expect(approved.state).toBe('resolving_workspace');
            expect(VALID_TRANSITIONS['pending_approval']).toContain('resolving_workspace');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('cancelling from any non-terminal state transitions to failed', async () => {
      const nonTerminalStates: OrchestrationState[] = [
        'intent_received',
        'pending_approval',
        'resolving_workspace',
        'spawning_agent',
        'planning_task',
        'executing',
      ];

      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.constantFrom(...nonTerminalStates),
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
          async (intent, operatorId, targetState, reason) => {
            const { manager } = createTestStack({ denyAutonomous: true });

            // Create session.
            const session = await manager.createSession(intent, operatorId);

            // Advance to the target state if needed.
            let current = session;

            // For pending_approval, we need a platform_event intent with deny policy.
            if (targetState === 'pending_approval') {
              // Already created with denyAutonomous but intent is operator type.
              // Create a new one with platform_event type.
              const platformIntent = { ...intent, sourceType: 'platform_event' as const };
              current = await manager.createSession(platformIntent, operatorId);
              expect(current.state).toBe('pending_approval');
            } else if (targetState === 'intent_received') {
              // Already at intent_received — use a non-denied session.
              const { manager: mgr2 } = createTestStack();
              current = await mgr2.createSession(intent, operatorId);
              expect(current.state).toBe('intent_received');

              // Cancel from intent_received.
              await mgr2.cancel(current.id, reason, operatorId);
              const cancelled = mgr2.getSession(current.id);
              expect(cancelled!.state).toBe('failed');
              expect(cancelled!.failureReason).toBe(reason);
              expect(VALID_TRANSITIONS[targetState]).toContain('failed');
              return;
            } else {
              // For other states, advance through the lifecycle.
              const { manager: mgr2 } = createTestStack();
              current = await mgr2.createSession(intent, operatorId);

              const stateOrder: OrchestrationState[] = [
                'intent_received',
                'resolving_workspace',
                'spawning_agent',
                'planning_task',
                'executing',
              ];
              const targetIdx = stateOrder.indexOf(targetState);

              for (let i = 0; i < targetIdx; i++) {
                current = await mgr2.advance(current.id);
              }

              expect(current.state).toBe(targetState);

              // Cancel from this state.
              await mgr2.cancel(current.id, reason, operatorId);
              const cancelled = mgr2.getSession(current.id);
              expect(cancelled!.state).toBe('failed');
              expect(cancelled!.failureReason).toBe(reason);
              expect(VALID_TRANSITIONS[targetState]).toContain('failed');
              return;
            }

            // Cancel from pending_approval.
            await manager.cancel(current.id, reason, operatorId);
            const cancelled = manager.getSession(current.id);
            expect(cancelled!.state).toBe('failed');
            expect(cancelled!.failureReason).toBe(reason);
            expect(VALID_TRANSITIONS[targetState]).toContain('failed');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('cannot advance a session in a terminal state', async () => {
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

            // Create and advance to completed.
            const session = await manager.createSession(intent, operatorId);
            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              current = await manager.advance(current.id);
            }

            // Attempting to advance from a terminal state should throw.
            await expect(manager.advance(current.id)).rejects.toThrow(
              /terminal state/,
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('cannot cancel a session in a terminal state', async () => {
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

            // Create and advance to completed.
            const session = await manager.createSession(intent, operatorId);
            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              current = await manager.advance(current.id);
            }

            // Attempting to cancel from a terminal state should throw.
            await expect(
              manager.cancel(current.id, 'test', operatorId),
            ).rejects.toThrow(/terminal state/);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('the normal lifecycle follows the exact sequence: intent_received → resolving_workspace → spawning_agent → planning_task → executing → completed', async () => {
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
            const states: OrchestrationState[] = [session.state];

            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              current = await manager.advance(current.id);
              states.push(current.state);
            }

            // Property assertion: the exact expected sequence.
            expect(states).toEqual([
              'intent_received',
              'resolving_workspace',
              'spawning_agent',
              'planning_task',
              'executing',
              'completed',
            ]);
          },
        ),
        { numRuns: 100 },
      );
    });
  });


  // --------------------------------------------------------------------------
  // Property 15: Orchestration session history completeness
  //
  // For any session reaching a terminal state, the history contains ordered
  // OrchestrationEvent entries covering every state transition.
  //
  // Feature: intent-driven-orchestration, Property 15: Orchestration session history completeness
  // Validates: Requirements 9.1, 9.3
  // --------------------------------------------------------------------------
  describe('Property 15: Orchestration session history completeness', () => {
    it('completed session history contains ordered events covering every state transition', async () => {
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

            // Create and advance to completion.
            const session = await manager.createSession(intent, operatorId);
            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              current = await manager.advance(current.id);
            }

            // Get the history.
            const history = await manager.getHistory(session.id);

            // Property assertions:
            // 1. History is non-empty for a completed session.
            expect(history.length).toBeGreaterThan(0);

            // 2. Each event has valid fields.
            for (const event of history) {
              expect(event.sessionId).toBe(session.id);
              expect(event.timestamp).toBeInstanceOf(Date);
              expect(event.fromState).toBeTruthy();
              expect(event.toState).toBeTruthy();
            }

            // 3. Events are ordered by timestamp (non-decreasing).
            for (let i = 1; i < history.length; i++) {
              expect(history[i].timestamp.getTime()).toBeGreaterThanOrEqual(
                history[i - 1].timestamp.getTime(),
              );
            }

            // 4. The chain is continuous: each event's toState matches the next event's fromState.
            for (let i = 1; i < history.length; i++) {
              expect(history[i].fromState).toBe(history[i - 1].toState);
            }

            // 5. The first event starts from intent_received.
            expect(history[0].fromState).toBe('intent_received');

            // 6. The last event ends at the terminal state.
            expect(history[history.length - 1].toState).toBe(current.state);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('failed session (via cancel) history contains the failure transition', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'operator' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
          fc.integer({ min: 0, max: 3 }),
          async (intent, operatorId, reason, advanceCount) => {
            const { manager } = createTestStack();

            // Create session and advance a few steps.
            const session = await manager.createSession(intent, operatorId);
            let current = session;
            for (let i = 0; i < advanceCount; i++) {
              if (current.state === 'completed' || current.state === 'failed') break;
              current = await manager.advance(current.id);
            }

            // Cancel if not already terminal.
            if (current.state !== 'completed' && current.state !== 'failed') {
              const stateBeforeCancel = current.state;
              await manager.cancel(current.id, reason, operatorId);

              // Get the history.
              const history = await manager.getHistory(session.id);

              // Property assertions:
              // 1. History is non-empty.
              expect(history.length).toBeGreaterThan(0);

              // 2. The last event transitions to 'failed'.
              const lastEvent = history[history.length - 1];
              expect(lastEvent.toState).toBe('failed');
              expect(lastEvent.fromState).toBe(stateBeforeCancel);

              // 3. The chain is continuous.
              for (let i = 1; i < history.length; i++) {
                expect(history[i].fromState).toBe(history[i - 1].toState);
              }

              // 4. First event starts from intent_received.
              expect(history[0].fromState).toBe('intent_received');
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('session with pending_approval → approval → completion has complete history', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryStructuredIntent().map((intent) => ({
            ...intent,
            sourceType: 'platform_event' as const,
            repository: 'test/repo',
          })),
          fc.uuid(),
          fc.uuid(),
          async (intent, operatorId, approverId) => {
            const { manager } = createTestStack({ denyAutonomous: true });

            // Create session — should go to pending_approval.
            const session = await manager.createSession(intent, operatorId);
            expect(session.state).toBe('pending_approval');

            // Approve.
            await manager.approve(session.id, approverId);

            // Advance to completion.
            let current = manager.getSession(session.id)!;
            while (current.state !== 'completed' && current.state !== 'failed') {
              current = await manager.advance(current.id);
            }

            // Get the history.
            const history = await manager.getHistory(session.id);

            // Property assertions:
            // 1. History covers the full path including pending_approval.
            expect(history.length).toBeGreaterThanOrEqual(6); // intent_received → pending_approval → resolving_workspace → spawning_agent → planning_task → executing → completed

            // 2. The chain is continuous.
            for (let i = 1; i < history.length; i++) {
              expect(history[i].fromState).toBe(history[i - 1].toState);
            }

            // 3. First event starts from intent_received.
            expect(history[0].fromState).toBe('intent_received');

            // 4. pending_approval appears in the chain.
            const hasPendingApproval = history.some(
              (e) => e.toState === 'pending_approval' || e.fromState === 'pending_approval',
            );
            expect(hasPendingApproval).toBe(true);

            // 5. Last event ends at terminal state.
            expect(history[history.length - 1].toState).toBe(current.state);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('onSessionEvent handler receives all transition events', async () => {
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

            // Register an event handler.
            const receivedEvents: OrchestrationEvent[] = [];
            manager.onSessionEvent((event) => {
              receivedEvents.push(event);
            });

            // Create and advance to completion.
            const session = await manager.createSession(intent, operatorId);
            let current = session;
            while (current.state !== 'completed' && current.state !== 'failed') {
              current = await manager.advance(current.id);
            }

            // Get the history.
            const history = await manager.getHistory(session.id);

            // Property assertion: handler received the same events as history.
            const sessionEvents = receivedEvents.filter(
              (e) => e.sessionId === session.id,
            );
            expect(sessionEvents.length).toBe(history.length);

            for (let i = 0; i < history.length; i++) {
              expect(sessionEvents[i].fromState).toBe(history[i].fromState);
              expect(sessionEvents[i].toState).toBe(history[i].toState);
              expect(sessionEvents[i].sessionId).toBe(history[i].sessionId);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
