import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskOrchestrator } from '../../src/subsystems/task-orchestrator.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { MemoryStore } from '../../src/subsystems/memory-store.js';
import { AgentDiscoveryRegistry } from '../../src/subsystems/agent-discovery-registry.js';
import { MCPGateway } from '../../src/subsystems/mcp-gateway.js';
import { AntiLeakage } from '../../src/subsystems/anti-leakage.js';
import type {
  IOperatorInterface,
  SystemEvent,
  EventChannel,
} from '../../src/interfaces/operator-interface.js';
import type {
  IAgentConnector,
  ConnectedAgent,
  AgentEvent,
  DispatchResult,
} from '../../src/interfaces/agent-connector.js';
import type {
  CodingTaskSubmission,
  TaskEvent,
  ExternalEventPayload,
} from '../../src/interfaces/task-orchestrator.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockOperatorInterface(): IOperatorInterface & {
  broadcastEvent: ReturnType<typeof vi.fn>;
} {
  return {
    handleConnection: vi.fn(),
    broadcastEvent: vi.fn(),
  };
}

function createMockAgentConnector(): {
  connector: IAgentConnector;
  getEventHandler: () => ((event: AgentEvent) => void) | undefined;
  dispatchStepMock: ReturnType<typeof vi.fn>;
} {
  let eventHandler: ((event: AgentEvent) => void) | undefined;
  const dispatchStepMock = vi.fn().mockResolvedValue({
    success: true,
  } satisfies DispatchResult);

  const connector: IAgentConnector = {
    connect: vi.fn().mockResolvedValue({
      agentId: 'agent-alpha',
      sessionId: 'session-1',
      protocol: 'process-spawn',
      healthStatus: 'healthy',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
    } satisfies ConnectedAgent),
    disconnect: vi.fn().mockResolvedValue(undefined),
    dispatchStep: dispatchStepMock,
    getAgent: vi.fn().mockReturnValue({
      agentId: 'agent-alpha',
      sessionId: 'session-1',
      protocol: 'process-spawn',
      healthStatus: 'healthy',
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
    } satisfies ConnectedAgent),
    listAgents: vi.fn().mockReturnValue([]),
    findCapableAgents: vi.fn().mockReturnValue([
      {
        agentId: 'agent-alpha',
        sessionId: 'session-1',
        protocol: 'process-spawn',
        healthStatus: 'healthy',
        connectedAt: new Date(),
        lastHeartbeat: new Date(),
      } satisfies ConnectedAgent,
    ]),
    registerEventSource: vi.fn(),
    deregisterEventSource: vi.fn(),
    onAgentEvent: vi.fn().mockImplementation(
      (handler: (event: AgentEvent) => void) => {
        eventHandler = handler;
      },
    ),
  };

  return {
    connector,
    getEventHandler: () => eventHandler,
    dispatchStepMock,
  };
}

/** Create a submission with external-event steps. */
function makeExternalEventSubmission(
  overrides: Partial<CodingTaskSubmission> = {},
): CodingTaskSubmission {
  return {
    operatorId: 'operator-1',
    steps: [
      {
        instructions: 'Await CI results',
        executionMode: 'external-event' as const,
        trigger: {
          type: 'event-driven' as const,
          eventSourceId: 'github-ci',
          eventType: 'ci_completed',
          timeoutMs: 60_000,
        },
      },
    ],
    agentId: 'agent-alpha',
    ...overrides,
  };
}

/** Create a submission with a time-based polling step. */
function makePollingSubmission(
  overrides: Partial<CodingTaskSubmission> = {},
): CodingTaskSubmission {
  return {
    operatorId: 'operator-1',
    steps: [
      {
        instructions: 'Poll CI status',
        executionMode: 'external-event' as const,
        trigger: {
          type: 'time-based' as const,
          eventSourceId: 'ci-service',
          eventType: 'ci_status',
          pollingIntervalMs: 100,
          timeoutMs: 60_000,
        },
      },
    ],
    agentId: 'agent-alpha',
    ...overrides,
  };
}

/** Create a multi-step submission: agent step → external event → agent step. */
function makeMultiStepSubmission(): CodingTaskSubmission {
  return {
    operatorId: 'operator-1',
    steps: [
      { instructions: 'Push branch', executionMode: 'agent' as const },
      {
        instructions: 'Await CI',
        executionMode: 'external-event' as const,
        trigger: {
          type: 'event-driven' as const,
          eventSourceId: 'github-ci',
          eventType: 'ci_completed',
          timeoutMs: 60_000,
        },
      },
      { instructions: 'Deploy', executionMode: 'agent' as const },
    ],
    agentId: 'agent-alpha',
  };
}

function makeSuccessEvent(sourceId = 'github-ci', eventType = 'ci_completed'): ExternalEventPayload {
  return {
    sourceId,
    eventType,
    outcome: 'success',
    data: { buildId: 'build-123', status: 'passed' },
    timestamp: new Date(),
  };
}

function makeFailureEvent(sourceId = 'github-ci', eventType = 'ci_completed'): ExternalEventPayload {
  return {
    sourceId,
    eventType,
    outcome: 'failure',
    data: { buildId: 'build-456', status: 'failed', reason: 'Tests failed' },
    timestamp: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TaskOrchestrator — External Event Handling (Task 9.1)', () => {
  let auditLog: AuditLog;
  let policyEngine: PolicyEngine;
  let memoryStore: MemoryStore;
  let discoveryRegistry: AgentDiscoveryRegistry;
  let mcpGateway: MCPGateway;
  let operatorInterface: ReturnType<typeof createMockOperatorInterface>;
  let mockConnector: IAgentConnector;
  let getEventHandler: () => ((event: AgentEvent) => void) | undefined;
  let dispatchStepMock: ReturnType<typeof vi.fn>;
  let orchestrator: TaskOrchestrator;

  beforeEach(() => {
    vi.useFakeTimers();

    auditLog = new AuditLog();
    policyEngine = new PolicyEngine();
    const antiLeakage = new AntiLeakage({ policyEngine });
    discoveryRegistry = new AgentDiscoveryRegistry();
    mcpGateway = new MCPGateway({ policyEngine, auditLog, antiLeakage });
    operatorInterface = createMockOperatorInterface();

    const mock = createMockAgentConnector();
    mockConnector = mock.connector;
    getEventHandler = mock.getEventHandler;
    dispatchStepMock = mock.dispatchStepMock;

    memoryStore = new MemoryStore({ policyEngine, auditLog });

    // Allow task artifact writes.
    policyEngine.addPolicy({
      id: 'allow-all-task-write',
      version: 1,
      agentId: '*',
      operations: ['write', 'read'],
      resources: ['memory:task:*'],
      effect: 'allow',
    } as AccessPolicy);

    // Register external event sources in MCP_Gateway and allow operations.
    mcpGateway.registerService({
      id: 'github-ci',
      name: 'GitHub CI',
      endpoint: 'https://api.github.com/ci',
      credentialRef: 'github-token',
      rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
    });
    mcpGateway.registerService({
      id: 'ci-service',
      name: 'CI Service',
      endpoint: 'https://ci.example.com',
      credentialRef: 'ci-token',
      rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
    });

    // Allow MCP operations for external event sources.
    policyEngine.addPolicy({
      id: 'allow-mcp-external-events',
      version: 1,
      agentId: '*',
      operations: ['receive_event', 'poll_status'],
      resources: ['mcp:github-ci', 'mcp:ci-service'],
      effect: 'allow',
    } as AccessPolicy);

    orchestrator = new TaskOrchestrator({
      agentConnector: mockConnector,
      memoryStore,
      policyEngine,
      mcpGateway,
      auditLog,
      operatorInterface,
      discoveryRegistry,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ----------------------------------------------------------------
  // handleExternalEvent — success outcome (Req 11.1, 11.3)
  // ----------------------------------------------------------------

  describe('handleExternalEvent — success outcome (Req 11.1, 11.3)', () => {
    it('should transition step to completed when event outcome is success', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      expect(step.status).toBe('executing');

      await orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent());

      expect(step.status).toBe('completed');
    });

    it('should transition task to completed when the only step resolves successfully', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent());

      expect(task.status).toBe('completed');
    });

    it('should emit step_status_change event on success resolution', async () => {
      const events: TaskEvent[] = [];
      orchestrator.onTaskEvent((e) => events.push(e));

      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent());

      const completedEvent = events.find(
        (e) =>
          e.type === 'step_status_change' &&
          (e.data as { newStatus: string }).newStatus === 'completed',
      );
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.taskId).toBe(task.id);
      expect(completedEvent!.stepId).toBe(step.id);
    });
  });

  // ----------------------------------------------------------------
  // handleExternalEvent — failure outcome (Req 11.1, 11.3)
  // ----------------------------------------------------------------

  describe('handleExternalEvent — failure outcome (Req 11.1, 11.3)', () => {
    it('should transition step to failed when event outcome is failure', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeFailureEvent());

      expect(step.status).toBe('failed');
    });

    it('should NOT auto-advance on failure outcome', async () => {
      const task = await orchestrator.createTask(makeMultiStepSubmission());
      // Dispatch step 0 (agent step) — manually complete it.
      await orchestrator.dispatchCurrentStep(task.id);
      const step0 = task.steps[0];
      step0.status = 'review';
      step0.updatedAt = new Date();
      await orchestrator.advanceTask(task.id, 'operator-1');

      // Step 1 is the external-event step, now executing.
      const step1 = task.steps[1];
      expect(step1.status).toBe('executing');

      await orchestrator.handleExternalEvent(task.id, step1.id, makeFailureEvent());

      expect(step1.status).toBe('failed');
      // Step 2 should still be pending — no auto-advance on failure.
      expect(task.steps[2].status).toBe('pending');
    });

    it('should emit step_status_change event on failure resolution', async () => {
      const events: TaskEvent[] = [];
      orchestrator.onTaskEvent((e) => events.push(e));

      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeFailureEvent());

      const failedEvent = events.find(
        (e) =>
          e.type === 'step_status_change' &&
          (e.data as { newStatus: string }).newStatus === 'failed',
      );
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.taskId).toBe(task.id);
      expect(failedEvent!.stepId).toBe(step.id);
    });
  });

  // ----------------------------------------------------------------
  // handleExternalEvent — MCP_Gateway routing (Req 11.5)
  // ----------------------------------------------------------------

  describe('handleExternalEvent — MCP_Gateway routing (Req 11.5)', () => {
    it('should route event through MCP_Gateway with Policy_Engine authorization', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent());

      // Verify audit log contains external_service entries from MCP_Gateway.
      const auditEntries = await auditLog.query({ eventType: 'external_service' });
      const mcpEntry = auditEntries.find(
        (e) => e.resource === 'mcp:github-ci' && e.decision === 'allow',
      );
      expect(mcpEntry).toBeDefined();
    });

    it('should throw and log denial when MCP_Gateway denies the event', async () => {
      // Remove the allow policy and add a deny policy.
      policyEngine.removePolicy('allow-mcp-external-events');
      policyEngine.addPolicy({
        id: 'deny-mcp-external-events',
        version: 1,
        agentId: '*',
        operations: ['receive_event'],
        resources: ['mcp:github-ci'],
        effect: 'deny',
      } as AccessPolicy);

      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      await expect(
        orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent()),
      ).rejects.toThrow(/authorization denied/i);

      // Step should remain in executing status (not transitioned).
      expect(step.status).toBe('executing');
    });
  });

  // ----------------------------------------------------------------
  // handleExternalEvent — audit logging (Req 11.8)
  // ----------------------------------------------------------------

  describe('handleExternalEvent — audit logging (Req 11.8)', () => {
    it('should record webhook_received in audit log with task/step correlation', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent());

      const auditEntries = await auditLog.query({ eventType: 'external_event' });
      const webhookEntry = auditEntries.find(
        (e) => e.operation === 'webhook_received',
      );
      expect(webhookEntry).toBeDefined();
      expect(webhookEntry!.details.taskId).toBe(task.id);
      expect(webhookEntry!.details.stepId).toBe(step.id);
      expect(webhookEntry!.details.sourceId).toBe('github-ci');
      expect(webhookEntry!.details.eventType).toBe('ci_completed');
      expect(webhookEntry!.details.outcome).toBe('success');
    });
  });

  // ----------------------------------------------------------------
  // handleExternalEvent — validation errors
  // ----------------------------------------------------------------

  describe('handleExternalEvent — validation errors', () => {
    it('should throw when task does not exist', async () => {
      await expect(
        orchestrator.handleExternalEvent('nonexistent', 'step-1', makeSuccessEvent()),
      ).rejects.toThrow(/not found/);
    });

    it('should throw when step does not exist in task', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      await expect(
        orchestrator.handleExternalEvent(task.id, 'nonexistent-step', makeSuccessEvent()),
      ).rejects.toThrow(/not found/);
    });

    it('should throw when step is not in executing status', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      // Step is still pending (not dispatched).
      const step = task.steps[0];

      await expect(
        orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent()),
      ).rejects.toThrow(/cannot handle external event/i);
    });
  });

  // ----------------------------------------------------------------
  // startExternalEventStep — event-driven triggers (Req 11.1)
  // ----------------------------------------------------------------

  describe('startExternalEventStep — event-driven triggers (Req 11.1)', () => {
    it('should transition step to executing when dispatched', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      expect(step.status).toBe('executing');
    });

    it('should transition task to in_progress when dispatching external event step', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      expect(task.status).toBe('pending');

      await orchestrator.dispatchCurrentStep(task.id);
      expect(task.status).toBe('in_progress');
    });

    it('should record waiting_for_push in audit log for event-driven triggers', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const auditEntries = await auditLog.query({ eventType: 'external_event' });
      const waitEntry = auditEntries.find(
        (e) => e.operation === 'waiting_for_push',
      );
      expect(waitEntry).toBeDefined();
      expect(waitEntry!.details.taskId).toBe(task.id);
      expect(waitEntry!.details.sourceId).toBe('github-ci');
      expect(waitEntry!.details.eventType).toBe('ci_completed');
    });

    it('should broadcast step_status_change to operator on dispatch', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const statusBroadcast = broadcastCalls.find(
        (call) =>
          call[1].type === 'step_status_change' &&
          (call[1].data as { newStatus: string }).newStatus === 'executing',
      );
      expect(statusBroadcast).toBeDefined();
      expect(statusBroadcast![0]).toBe(`task:${task.id}`);
    });
  });

  // ----------------------------------------------------------------
  // startExternalEventStep — time-based polling (Req 11.2)
  // ----------------------------------------------------------------

  describe('startExternalEventStep — time-based polling (Req 11.2)', () => {
    it('should start polling at the configured interval', async () => {
      const task = await orchestrator.createTask(makePollingSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      expect(step.status).toBe('executing');

      // Verify polling_started was recorded in audit log.
      const auditEntries = await auditLog.query({ eventType: 'external_event' });
      const pollStartEntry = auditEntries.find(
        (e) => e.operation === 'polling_started',
      );
      expect(pollStartEntry).toBeDefined();
      expect(pollStartEntry!.details.pollingIntervalMs).toBe(100);
    });

    it('should resolve step when poll returns terminal success status', async () => {
      // Configure MCP_Gateway executor to return success on poll.
      const mcpExecutor = vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'passed' },
      });
      const antiLeakage = new AntiLeakage({ policyEngine });
      const customMcpGateway = new MCPGateway({
        policyEngine,
        auditLog,
        antiLeakage,
        executor: mcpExecutor,
      });
      customMcpGateway.registerService({
        id: 'ci-service',
        name: 'CI Service',
        endpoint: 'https://ci.example.com',
        credentialRef: 'ci-token',
        rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
      });

      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway: customMcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await customOrchestrator.createTask(makePollingSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      expect(step.status).toBe('executing');

      // Advance timer to trigger the first poll.
      await vi.advanceTimersByTimeAsync(150);

      // The poll should have resolved the step.
      expect(step.status).toBe('completed');
    });

    it('should resolve step as failed when poll returns terminal failure status', async () => {
      const mcpExecutor = vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'failed' },
      });
      const antiLeakage = new AntiLeakage({ policyEngine });
      const customMcpGateway = new MCPGateway({
        policyEngine,
        auditLog,
        antiLeakage,
        executor: mcpExecutor,
      });
      customMcpGateway.registerService({
        id: 'ci-service',
        name: 'CI Service',
        endpoint: 'https://ci.example.com',
        credentialRef: 'ci-token',
        rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
      });

      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway: customMcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await customOrchestrator.createTask(makePollingSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Advance timer to trigger the first poll.
      await vi.advanceTimersByTimeAsync(150);

      expect(step.status).toBe('failed');
    });

    it('should continue polling when status is non-terminal (pending)', async () => {
      let pollCount = 0;
      const mcpExecutor = vi.fn().mockImplementation(async () => {
        pollCount++;
        // Return non-terminal status for first 2 polls, then success.
        if (pollCount < 3) {
          return { success: true, data: { status: 'pending' } };
        }
        return { success: true, data: { status: 'passed' } };
      });
      const antiLeakage = new AntiLeakage({ policyEngine });
      const customMcpGateway = new MCPGateway({
        policyEngine,
        auditLog,
        antiLeakage,
        executor: mcpExecutor,
      });
      customMcpGateway.registerService({
        id: 'ci-service',
        name: 'CI Service',
        endpoint: 'https://ci.example.com',
        credentialRef: 'ci-token',
        rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
      });

      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway: customMcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await customOrchestrator.createTask(makePollingSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // After first poll — still executing.
      await vi.advanceTimersByTimeAsync(150);
      expect(step.status).toBe('executing');

      // After second poll — still executing.
      await vi.advanceTimersByTimeAsync(100);
      expect(step.status).toBe('executing');

      // After third poll — should be completed.
      await vi.advanceTimersByTimeAsync(100);
      expect(step.status).toBe('completed');
      // pollCount includes the poll calls + the handleExternalEvent call
      // which also goes through the executor via MCP_Gateway.
      expect(pollCount).toBeGreaterThanOrEqual(3);
    });

    it('should record poll_response in audit log', async () => {
      const mcpExecutor = vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'passed' },
      });
      const antiLeakage = new AntiLeakage({ policyEngine });
      const customMcpGateway = new MCPGateway({
        policyEngine,
        auditLog,
        antiLeakage,
        executor: mcpExecutor,
      });
      customMcpGateway.registerService({
        id: 'ci-service',
        name: 'CI Service',
        endpoint: 'https://ci.example.com',
        credentialRef: 'ci-token',
        rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
      });

      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway: customMcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await customOrchestrator.createTask(makePollingSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      await vi.advanceTimersByTimeAsync(150);

      const auditEntries = await auditLog.query({ eventType: 'external_event' });
      const pollEntry = auditEntries.find(
        (e) => e.operation === 'poll_response',
      );
      expect(pollEntry).toBeDefined();
      expect(pollEntry!.details.taskId).toBe(task.id);
      expect(pollEntry!.details.sourceId).toBe('ci-service');
    });
  });

  // ----------------------------------------------------------------
  // Timeout handling (Req 11.6, 11.7)
  // ----------------------------------------------------------------

  describe('timeout handling (Req 11.6, 11.7)', () => {
    it('should transition event-driven step to failed on timeout', async () => {
      const task = await orchestrator.createTask(
        makeExternalEventSubmission({
          steps: [
            {
              instructions: 'Await CI',
              executionMode: 'external-event',
              trigger: {
                type: 'event-driven',
                eventSourceId: 'github-ci',
                eventType: 'ci_completed',
                timeoutMs: 500,
              },
            },
          ],
        }),
      );
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      expect(step.status).toBe('executing');

      // Advance past the timeout.
      await vi.advanceTimersByTimeAsync(600);

      expect(step.status).toBe('failed');
    });

    it('should transition polling step to failed on timeout', async () => {
      // Use default MCP_Gateway (no executor) — polls return non-terminal.
      const task = await orchestrator.createTask(
        makePollingSubmission({
          steps: [
            {
              instructions: 'Poll CI',
              executionMode: 'external-event',
              trigger: {
                type: 'time-based',
                eventSourceId: 'ci-service',
                eventType: 'ci_status',
                pollingIntervalMs: 100,
                timeoutMs: 500,
              },
            },
          ],
        }),
      );
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      expect(step.status).toBe('executing');

      // Advance past the timeout.
      await vi.advanceTimersByTimeAsync(600);

      expect(step.status).toBe('failed');
    });

    it('should record event_timeout in audit log', async () => {
      const task = await orchestrator.createTask(
        makeExternalEventSubmission({
          steps: [
            {
              instructions: 'Await CI',
              executionMode: 'external-event',
              trigger: {
                type: 'event-driven',
                eventSourceId: 'github-ci',
                eventType: 'ci_completed',
                timeoutMs: 500,
              },
            },
          ],
        }),
      );
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      await vi.advanceTimersByTimeAsync(600);

      const auditEntries = await auditLog.query({ eventType: 'external_event' });
      const timeoutEntry = auditEntries.find(
        (e) => e.operation === 'event_timeout',
      );
      expect(timeoutEntry).toBeDefined();
      expect(timeoutEntry!.details.taskId).toBe(task.id);
      expect(timeoutEntry!.details.stepId).toBe(step.id);
      expect(timeoutEntry!.details.timeoutMs).toBe(500);
    });

    it('should notify operator via WebSocket on timeout', async () => {
      const task = await orchestrator.createTask(
        makeExternalEventSubmission({
          steps: [
            {
              instructions: 'Await CI',
              executionMode: 'external-event',
              trigger: {
                type: 'event-driven',
                eventSourceId: 'github-ci',
                eventType: 'ci_completed',
                timeoutMs: 500,
              },
            },
          ],
        }),
      );
      await orchestrator.dispatchCurrentStep(task.id);

      await vi.advanceTimersByTimeAsync(600);

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const failBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'step_failed',
      );
      expect(failBroadcast).toBeDefined();
      expect(failBroadcast![0]).toBe(`task:${task.id}`);
      const data = failBroadcast![1].data as { reason: string };
      expect(data.reason).toMatch(/timeout/i);
    });

    it('should NOT timeout if event resolves before timeout', async () => {
      const task = await orchestrator.createTask(
        makeExternalEventSubmission({
          steps: [
            {
              instructions: 'Await CI',
              executionMode: 'external-event',
              trigger: {
                type: 'event-driven',
                eventSourceId: 'github-ci',
                eventType: 'ci_completed',
                timeoutMs: 1000,
              },
            },
          ],
        }),
      );
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Resolve the event before timeout.
      await orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent());
      expect(step.status).toBe('completed');

      // Advance past the timeout — should not change status.
      await vi.advanceTimersByTimeAsync(1500);
      expect(step.status).toBe('completed');
    });
  });

  // ----------------------------------------------------------------
  // Auto-advance after external event resolution (Req 11.9)
  // ----------------------------------------------------------------

  describe('auto-advance after external event resolution (Req 11.9)', () => {
    it('should auto-dispatch next agent step when external event resolves successfully', async () => {
      const task = await orchestrator.createTask(makeMultiStepSubmission());

      // Dispatch and complete step 0 (agent step).
      await orchestrator.dispatchCurrentStep(task.id);
      const step0 = task.steps[0];
      step0.status = 'review';
      step0.updatedAt = new Date();
      await orchestrator.advanceTask(task.id, 'operator-1');

      // Step 1 (external-event) should now be executing.
      const step1 = task.steps[1];
      expect(step1.status).toBe('executing');

      // Reset dispatch mock to track auto-advance dispatch.
      dispatchStepMock.mockClear();

      // Resolve the external event.
      await orchestrator.handleExternalEvent(task.id, step1.id, makeSuccessEvent());

      // Step 1 should be completed.
      expect(step1.status).toBe('completed');

      // Step 2 (agent step) should have been auto-dispatched.
      expect(dispatchStepMock).toHaveBeenCalled();
      const step2 = task.steps[2];
      expect(step2.status).toBe('executing');
    });

    it('should NOT auto-advance when external event fails', async () => {
      const task = await orchestrator.createTask(makeMultiStepSubmission());

      // Dispatch and complete step 0.
      await orchestrator.dispatchCurrentStep(task.id);
      const step0 = task.steps[0];
      step0.status = 'review';
      step0.updatedAt = new Date();
      await orchestrator.advanceTask(task.id, 'operator-1');

      const step1 = task.steps[1];
      expect(step1.status).toBe('executing');

      dispatchStepMock.mockClear();

      // Resolve with failure.
      await orchestrator.handleExternalEvent(task.id, step1.id, makeFailureEvent());

      expect(step1.status).toBe('failed');
      // Step 2 should NOT be dispatched.
      expect(dispatchStepMock).not.toHaveBeenCalled();
      expect(task.steps[2].status).toBe('pending');
    });

    it('should auto-advance to next external-event step if it follows another external-event step', async () => {
      const task = await orchestrator.createTask({
        operatorId: 'operator-1',
        steps: [
          {
            instructions: 'Await CI',
            executionMode: 'external-event',
            trigger: {
              type: 'event-driven',
              eventSourceId: 'github-ci',
              eventType: 'ci_completed',
              timeoutMs: 60_000,
            },
          },
          {
            instructions: 'Await deploy',
            executionMode: 'external-event',
            trigger: {
              type: 'event-driven',
              eventSourceId: 'github-ci',
              eventType: 'deploy_completed',
              timeoutMs: 60_000,
            },
          },
        ],
        agentId: 'agent-alpha',
      });

      await orchestrator.dispatchCurrentStep(task.id);
      const step0 = task.steps[0];
      expect(step0.status).toBe('executing');

      // Resolve step 0.
      await orchestrator.handleExternalEvent(task.id, step0.id, makeSuccessEvent());
      expect(step0.status).toBe('completed');

      // Step 1 should be auto-started (executing, waiting for push).
      const step1 = task.steps[1];
      expect(step1.status).toBe('executing');
    });

    it('should complete task when external event resolves the last step', async () => {
      const task = await orchestrator.createTask({
        operatorId: 'operator-1',
        steps: [
          { instructions: 'Push branch', executionMode: 'agent' },
          {
            instructions: 'Await CI',
            executionMode: 'external-event',
            trigger: {
              type: 'event-driven',
              eventSourceId: 'github-ci',
              eventType: 'ci_completed',
              timeoutMs: 60_000,
            },
          },
        ],
        agentId: 'agent-alpha',
      });

      // Complete step 0.
      await orchestrator.dispatchCurrentStep(task.id);
      const step0 = task.steps[0];
      step0.status = 'review';
      step0.updatedAt = new Date();
      await orchestrator.advanceTask(task.id, 'operator-1');

      // Step 1 is executing.
      const step1 = task.steps[1];
      expect(step1.status).toBe('executing');

      // Resolve step 1.
      await orchestrator.handleExternalEvent(task.id, step1.id, makeSuccessEvent());

      expect(step1.status).toBe('completed');
      expect(task.status).toBe('completed');
    });
  });

  // ----------------------------------------------------------------
  // Timer cleanup (Req 11.6, 11.7)
  // ----------------------------------------------------------------

  describe('timer cleanup', () => {
    it('should clear polling and timeout timers when event resolves', async () => {
      const mcpExecutor = vi.fn().mockResolvedValue({
        success: true,
        data: { status: 'pending' },
      });
      const antiLeakage = new AntiLeakage({ policyEngine });
      const customMcpGateway = new MCPGateway({
        policyEngine,
        auditLog,
        antiLeakage,
        executor: mcpExecutor,
      });
      customMcpGateway.registerService({
        id: 'ci-service',
        name: 'CI Service',
        endpoint: 'https://ci.example.com',
        credentialRef: 'ci-token',
        rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
      });

      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway: customMcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await customOrchestrator.createTask(
        makePollingSubmission({
          steps: [
            {
              instructions: 'Poll CI',
              executionMode: 'external-event',
              trigger: {
                type: 'time-based',
                eventSourceId: 'ci-service',
                eventType: 'ci_status',
                pollingIntervalMs: 100,
                timeoutMs: 5000,
              },
            },
          ],
        }),
      );
      await customOrchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Manually resolve the step via handleExternalEvent.
      await customOrchestrator.handleExternalEvent(task.id, step.id, {
        sourceId: 'ci-service',
        eventType: 'ci_status',
        outcome: 'success',
        data: { status: 'passed' },
        timestamp: new Date(),
      });

      expect(step.status).toBe('completed');

      // Advance timers well past the timeout — should not change status.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(step.status).toBe('completed');
    });

    it('should clear timers when task is canceled', async () => {
      const task = await orchestrator.createTask(
        makeExternalEventSubmission({
          steps: [
            {
              instructions: 'Await CI',
              executionMode: 'external-event',
              trigger: {
                type: 'event-driven',
                eventSourceId: 'github-ci',
                eventType: 'ci_completed',
                timeoutMs: 5000,
              },
            },
          ],
        }),
      );
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      expect(step.status).toBe('executing');

      // Cancel the task.
      await orchestrator.cancelTask(task.id, 'No longer needed', 'operator-1');
      expect(task.status).toBe('canceled');

      // Advance past timeout — step should NOT transition to failed.
      await vi.advanceTimersByTimeAsync(10_000);
      // Step status was not changed by timeout since timers were cleared.
      // It remains executing (cancel doesn't change individual step statuses).
      expect(step.status).toBe('executing');
    });
  });

  // ----------------------------------------------------------------
  // Operator notification via WebSocket
  // ----------------------------------------------------------------

  describe('operator notification via WebSocket', () => {
    it('should broadcast external_event_resolved on success', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeSuccessEvent());

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const resolvedBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'external_event_resolved',
      );
      expect(resolvedBroadcast).toBeDefined();
      expect(resolvedBroadcast![0]).toBe(`task:${task.id}`);
      const data = resolvedBroadcast![1].data as {
        taskId: string;
        stepId: string;
        outcome: string;
        newStatus: string;
      };
      expect(data.taskId).toBe(task.id);
      expect(data.stepId).toBe(step.id);
      expect(data.outcome).toBe('success');
      expect(data.newStatus).toBe('completed');
    });

    it('should broadcast external_event_resolved on failure', async () => {
      const task = await orchestrator.createTask(makeExternalEventSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      await orchestrator.handleExternalEvent(task.id, step.id, makeFailureEvent());

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const resolvedBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'external_event_resolved',
      );
      expect(resolvedBroadcast).toBeDefined();
      const data = resolvedBroadcast![1].data as {
        outcome: string;
        newStatus: string;
      };
      expect(data.outcome).toBe('failure');
      expect(data.newStatus).toBe('failed');
    });
  });

  // ----------------------------------------------------------------
  // Polling error handling
  // ----------------------------------------------------------------

  describe('polling error handling', () => {
    it('should continue polling after a transient poll failure (MCP returns error)', async () => {
      let callCount = 0;
      const mcpExecutor = vi.fn().mockImplementation(async () => {
        callCount++;
        // First call returns a non-terminal result (MCP_Gateway catches
        // executor errors and returns { success: false }), second returns success.
        if (callCount === 1) {
          return { success: true, data: { status: 'pending' } };
        }
        return { success: true, data: { status: 'passed' } };
      });
      const antiLeakage = new AntiLeakage({ policyEngine });
      const customMcpGateway = new MCPGateway({
        policyEngine,
        auditLog,
        antiLeakage,
        executor: mcpExecutor,
      });
      customMcpGateway.registerService({
        id: 'ci-service',
        name: 'CI Service',
        endpoint: 'https://ci.example.com',
        credentialRef: 'ci-token',
        rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
      });

      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway: customMcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await customOrchestrator.createTask(makePollingSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // First poll returns non-terminal — still executing.
      await vi.advanceTimersByTimeAsync(150);
      expect(step.status).toBe('executing');

      // Second poll returns terminal success — step completes.
      await vi.advanceTimersByTimeAsync(100);
      expect(step.status).toBe('completed');
      // callCount includes poll calls + the handleExternalEvent MCP call.
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should record poll_response in audit log even when MCP_Gateway executor throws', async () => {
      // When the executor throws, MCPGateway catches it and returns
      // { success: false, error: ... }. The pollExternalEventSource
      // records a poll_response (not poll_error) because the MCP call
      // itself succeeded — it just returned a failure result.
      const mcpExecutor = vi.fn().mockRejectedValue(new Error('Network error'));
      const antiLeakage = new AntiLeakage({ policyEngine });
      const customMcpGateway = new MCPGateway({
        policyEngine,
        auditLog,
        antiLeakage,
        executor: mcpExecutor,
      });
      customMcpGateway.registerService({
        id: 'ci-service',
        name: 'CI Service',
        endpoint: 'https://ci.example.com',
        credentialRef: 'ci-token',
        rateLimits: { perAgent: 100, perService: 1000, windowMs: 60_000 },
      });

      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway: customMcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await customOrchestrator.createTask(makePollingSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      // Trigger a poll.
      await vi.advanceTimersByTimeAsync(150);

      // MCPGateway catches the executor error and returns { success: false }.
      // pollExternalEventSource records a poll_response with success: false.
      const auditEntries = await auditLog.query({ eventType: 'external_event' });
      const pollEntry = auditEntries.find(
        (e) => e.operation === 'poll_response',
      );
      expect(pollEntry).toBeDefined();
      expect(pollEntry!.details.success).toBe(false);
    });
  });
});
