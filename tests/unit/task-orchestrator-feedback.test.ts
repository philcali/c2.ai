import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  ExecutionArtifact,
  ConnectedAgent,
  AgentEvent,
  DispatchResult,
  TaskContext,
} from '../../src/interfaces/agent-connector.js';
import type { CodingTaskSubmission } from '../../src/interfaces/task-orchestrator.js';
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

function makeArtifact(overrides: Partial<ExecutionArtifact> = {}): ExecutionArtifact {
  return {
    id: overrides.id ?? `artifact-${Math.random().toString(36).slice(2, 10)}`,
    taskId: overrides.taskId ?? 'task-1',
    stepId: overrides.stepId ?? 'step-1',
    type: overrides.type ?? 'diff',
    timestamp: overrides.timestamp ?? new Date(),
    data: overrides.data ?? {
      filePath: 'src/index.ts',
      beforeContent: 'old',
      afterContent: 'new',
    },
  };
}

function makeSubmission(overrides: Partial<CodingTaskSubmission> = {}): CodingTaskSubmission {
  return {
    operatorId: 'operator-1',
    steps: [
      { instructions: 'Implement the feature', executionMode: 'agent' as const },
    ],
    agentId: 'agent-alpha',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TaskOrchestrator — Operator Feedback Loop (Task 7.5)', () => {
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

    policyEngine.addPolicy({
      id: 'allow-all-task-write',
      version: 1,
      agentId: '*',
      operations: ['write', 'read'],
      resources: ['memory:task:*'],
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

  // ----------------------------------------------------------------
  // Req 6.1: Present artifacts to operator when step transitions to review
  // ----------------------------------------------------------------

  describe('presenting artifacts on review transition (Req 6.1)', () => {
    it('should broadcast step_review to operator when agent completes a step', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'review-artifact',
        taskId: task.id,
        stepId: step.id,
      });

      // Simulate agent completing the step via event handler.
      const handler = getEventHandler();
      expect(handler).toBeDefined();

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact,
          success: true,
        },
      });

      // Verify broadcastEvent was called with step_review.
      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<[EventChannel, SystemEvent]>;
      const reviewBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'step_review',
      );

      expect(reviewBroadcast).toBeDefined();
      expect(reviewBroadcast![0]).toBe(`task:${task.id}`);
      const eventData = reviewBroadcast![1].data as {
        taskId: string;
        stepId: string;
        artifacts: ExecutionArtifact[];
      };
      expect(eventData.taskId).toBe(task.id);
      expect(eventData.stepId).toBe(step.id);
      expect(eventData.artifacts.length).toBe(1);
      expect(eventData.artifacts[0].id).toBe('review-artifact');
    });

    it('should broadcast step_review to operator when step is interrupted', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
      });
      step.artifacts.push(artifact);

      await orchestrator.interruptStep(task.id, 'operator-1');

      // Verify broadcastEvent was called with step_review.
      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<[EventChannel, SystemEvent]>;
      const reviewBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'step_review',
      );

      expect(reviewBroadcast).toBeDefined();
      expect(reviewBroadcast![0]).toBe(`task:${task.id}`);
      const eventData = reviewBroadcast![1].data as {
        taskId: string;
        stepId: string;
        artifacts: ExecutionArtifact[];
        reason: string;
      };
      expect(eventData.taskId).toBe(task.id);
      expect(eventData.stepId).toBe(step.id);
      expect(eventData.artifacts.length).toBe(1);
      expect(eventData.reason).toBe('Operator interrupt');
    });

    it('should broadcast step_failed to operator when agent reports failure', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const errorArtifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
        type: 'error',
        data: { code: 'BUILD_FAIL', message: 'Build failed' },
      });

      const handler = getEventHandler();
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: errorArtifact,
          success: false,
          error: 'Build failed',
        },
      });

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<[EventChannel, SystemEvent]>;
      const failBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'step_failed',
      );

      expect(failBroadcast).toBeDefined();
      expect(failBroadcast![0]).toBe(`task:${task.id}`);
      const eventData = failBroadcast![1].data as {
        taskId: string;
        stepId: string;
        artifacts: ExecutionArtifact[];
        error: string;
      };
      expect(eventData.taskId).toBe(task.id);
      expect(eventData.stepId).toBe(step.id);
      expect(eventData.error).toBe('Build failed');
    });

    it('should include the task-specific channel in the broadcast', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      step.artifacts.push(makeArtifact({ taskId: task.id, stepId: step.id }));

      await orchestrator.interruptStep(task.id, 'operator-1');

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<[EventChannel, SystemEvent]>;
      const reviewBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'step_review',
      );

      expect(reviewBroadcast).toBeDefined();
      // Channel should be task:{taskId}
      expect(reviewBroadcast![0]).toBe(`task:${task.id}`);
      // The event's channel field should also match
      expect(reviewBroadcast![1].channel).toBe(`task:${task.id}`);
    });
  });

  // ----------------------------------------------------------------
  // Req 6.3: Feedback history per step
  // ----------------------------------------------------------------

  describe('feedback history recording (Req 6.3)', () => {
    it('should record feedback with content, reviewer ID, and timestamp on retry', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.retryStep(task.id, 'Fix the null check', 'operator-1');

      expect(step.feedbackHistory.length).toBe(1);
      const entry = step.feedbackHistory[0];
      expect(entry.content).toBe('Fix the null check');
      expect(entry.operatorId).toBe('operator-1');
      expect(entry.stepId).toBe(step.id);
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    it('should preserve chronological order across multiple retries', async () => {
      const task = await orchestrator.createTask(makeSubmission({
        steps: [{ instructions: 'Do work', executionMode: 'agent' }],
      }));
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // First retry
      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'First feedback', 'operator-1');

      // Second retry — step is now executing, transition to review again
      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Second feedback', 'operator-2');

      // Third retry
      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Third feedback', 'operator-1');

      expect(step.feedbackHistory.length).toBe(3);
      expect(step.feedbackHistory[0].content).toBe('First feedback');
      expect(step.feedbackHistory[1].content).toBe('Second feedback');
      expect(step.feedbackHistory[2].content).toBe('Third feedback');

      // Verify chronological order
      for (let i = 1; i < step.feedbackHistory.length; i++) {
        expect(step.feedbackHistory[i].timestamp.getTime())
          .toBeGreaterThanOrEqual(step.feedbackHistory[i - 1].timestamp.getTime());
      }
    });

    it('should assign unique IDs to each feedback entry', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Two retries
      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Feedback A', 'operator-1');

      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Feedback B', 'operator-1');

      expect(step.feedbackHistory.length).toBe(2);
      expect(step.feedbackHistory[0].id).not.toBe(step.feedbackHistory[1].id);
    });

    it('should record different reviewer IDs for different operators', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Feedback from op1', 'operator-1');

      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Feedback from op2', 'operator-2');

      expect(step.feedbackHistory[0].operatorId).toBe('operator-1');
      expect(step.feedbackHistory[1].operatorId).toBe('operator-2');
    });
  });

  // ----------------------------------------------------------------
  // Req 6.4: All prior artifacts and feedback in Task_Context on retry
  // ----------------------------------------------------------------

  describe('prior artifacts and feedback in retry context (Req 6.4)', () => {
    it('should include all feedback entries in Task_Context on retry', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // First retry
      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Fix the bug', 'operator-1');

      // Second retry — context should include both feedback entries
      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Still broken', 'operator-1');

      // The third dispatch call (initial + 2 retries) should have both feedback entries
      expect(dispatchStepMock).toHaveBeenCalledTimes(3);
      const context: TaskContext = dispatchStepMock.mock.calls[2][1];
      expect(context.operatorFeedback).toBeDefined();
      expect(context.operatorFeedback!.length).toBe(2);
      expect(context.operatorFeedback![0].content).toBe('Fix the bug');
      expect(context.operatorFeedback![1].content).toBe('Still broken');
    });

    it('should include current step artifacts as priorStepArtifacts on retry', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'prior-art',
        taskId: task.id,
        stepId: step.id,
        type: 'diff',
      });
      step.artifacts.push(artifact);

      step.status = 'review';
      step.updatedAt = new Date();
      await orchestrator.retryStep(task.id, 'Try again', 'operator-1');

      // The retry dispatch should include the artifact from the prior attempt
      expect(dispatchStepMock).toHaveBeenCalledTimes(2);
      const context: TaskContext = dispatchStepMock.mock.calls[1][1];
      expect(context.priorStepArtifacts).toBeDefined();
      expect(context.priorStepArtifacts!.some((a) => a.id === 'prior-art')).toBe(true);
    });

    it('should include both prior step artifacts and current step artifacts on retry of step 2', async () => {
      const task = await orchestrator.createTask(makeSubmission({
        steps: [
          { instructions: 'Step 1', executionMode: 'agent' },
          { instructions: 'Step 2', executionMode: 'agent' },
        ],
      }));

      // Dispatch and complete step 1
      await orchestrator.dispatchCurrentStep(task.id);
      const step1 = task.steps[0];
      step1.artifacts.push(makeArtifact({
        id: 'step1-art',
        taskId: task.id,
        stepId: step1.id,
      }));
      step1.status = 'review';
      step1.updatedAt = new Date();

      // Advance to step 2
      await orchestrator.advanceTask(task.id, 'operator-1');

      // Add artifact to step 2 and transition to review
      const step2 = task.steps[1];
      step2.artifacts.push(makeArtifact({
        id: 'step2-art',
        taskId: task.id,
        stepId: step2.id,
      }));
      step2.status = 'review';
      step2.updatedAt = new Date();

      // Retry step 2
      await orchestrator.retryStep(task.id, 'Redo step 2', 'operator-1');

      // The retry dispatch should include artifacts from both step 1 and step 2
      const lastCall = dispatchStepMock.mock.calls[dispatchStepMock.mock.calls.length - 1];
      const context: TaskContext = lastCall[1];
      expect(context.priorStepArtifacts).toBeDefined();
      const artIds = context.priorStepArtifacts!.map((a) => a.id);
      expect(artIds).toContain('step1-art');
      expect(artIds).toContain('step2-art');
    });
  });

  // ----------------------------------------------------------------
  // Req 6.5: Configurable max retry cycles
  // ----------------------------------------------------------------

  describe('configurable max retry cycles (Req 6.5)', () => {
    it('should default max retries to 3', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Retry 3 times (should succeed)
      for (let i = 0; i < 3; i++) {
        step.status = 'review';
        step.updatedAt = new Date();
        await orchestrator.retryStep(task.id, `Retry ${i + 1}`, 'operator-1');
      }

      expect(step.retryCount).toBe(3);

      // 4th retry should fail with retry limit exceeded
      step.status = 'review';
      step.updatedAt = new Date();
      await expect(
        orchestrator.retryStep(task.id, 'One more try', 'operator-1'),
      ).rejects.toThrow(/maximum retry limit of 3/);
    });

    it('should accept a custom max retries value', async () => {
      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        maxRetries: 1,
      });

      const task = await customOrchestrator.createTask(makeSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // First retry should succeed
      step.status = 'review';
      step.updatedAt = new Date();
      await customOrchestrator.retryStep(task.id, 'First retry', 'operator-1');

      expect(step.retryCount).toBe(1);

      // Second retry should fail
      step.status = 'review';
      step.updatedAt = new Date();
      await expect(
        customOrchestrator.retryStep(task.id, 'Second retry', 'operator-1'),
      ).rejects.toThrow(/maximum retry limit of 1/);
    });

    it('should transition step to failed when retry limit is exceeded', async () => {
      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        maxRetries: 1,
      });

      const task = await customOrchestrator.createTask(makeSubmission());
      await customOrchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // First retry
      step.status = 'review';
      step.updatedAt = new Date();
      await customOrchestrator.retryStep(task.id, 'Retry 1', 'operator-1');

      // Second retry — should exceed limit and transition to failed
      step.status = 'review';
      step.updatedAt = new Date();
      try {
        await customOrchestrator.retryStep(task.id, 'Retry 2', 'operator-1');
      } catch {
        // Expected
      }

      expect(step.status).toBe('failed');
    });

    it('should emit step_status_change event when retry limit is exceeded', async () => {
      const events: Array<{ type: string; data: unknown }> = [];
      orchestrator.onTaskEvent((event) => {
        events.push({ type: event.type, data: event.data });
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Exhaust retries
      for (let i = 0; i < 3; i++) {
        step.status = 'review';
        step.updatedAt = new Date();
        await orchestrator.retryStep(task.id, `Retry ${i + 1}`, 'operator-1');
      }

      // Trigger retry limit exceeded
      step.status = 'review';
      step.updatedAt = new Date();
      try {
        await orchestrator.retryStep(task.id, 'Too many', 'operator-1');
      } catch {
        // Expected
      }

      const failEvent = events.find(
        (e) =>
          e.type === 'step_status_change' &&
          (e.data as { newStatus: string }).newStatus === 'failed' &&
          (e.data as { reason?: string }).reason === 'Retry limit exceeded',
      );
      expect(failEvent).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // Retry from failed status
  // ----------------------------------------------------------------

  describe('retry from failed status', () => {
    it('should allow retry from failed status with feedback', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Simulate agent failure via event handler
      const handler = getEventHandler();
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          success: false,
          error: 'Build failed',
        },
      });

      expect(step.status).toBe('failed');

      // Retry from failed status
      await orchestrator.retryStep(task.id, 'Try a different approach', 'operator-1');

      expect(step.feedbackHistory.length).toBe(1);
      expect(step.feedbackHistory[0].content).toBe('Try a different approach');
      expect(step.retryCount).toBe(1);
      // Step should now be executing (dispatched)
      expect(step.status).toBe('executing');
    });

    it('should include feedback in context when retrying from failed status', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];

      // Simulate failure
      const handler = getEventHandler();
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          success: false,
          error: 'Test failed',
        },
      });

      // Retry from failed
      await orchestrator.retryStep(task.id, 'Fix the test', 'operator-1');

      // The retry dispatch should include the feedback
      const lastCall = dispatchStepMock.mock.calls[dispatchStepMock.mock.calls.length - 1];
      const context: TaskContext = lastCall[1];
      expect(context.operatorFeedback).toBeDefined();
      expect(context.operatorFeedback!.length).toBe(1);
      expect(context.operatorFeedback![0].content).toBe('Fix the test');
    });
  });

  // ----------------------------------------------------------------
  // Feedback emits feedback_added event
  // ----------------------------------------------------------------

  describe('feedback_added event emission', () => {
    it('should emit feedback_added event when feedback is recorded', async () => {
      const events: Array<{ type: string; taskId: string; stepId?: string }> = [];
      orchestrator.onTaskEvent((event) => {
        events.push({
          type: event.type,
          taskId: event.taskId,
          stepId: event.stepId,
        });
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.retryStep(task.id, 'Some feedback', 'operator-1');

      const feedbackEvent = events.find((e) => e.type === 'feedback_added');
      expect(feedbackEvent).toBeDefined();
      expect(feedbackEvent!.taskId).toBe(task.id);
      expect(feedbackEvent!.stepId).toBe(step.id);
    });
  });

  // ----------------------------------------------------------------
  // Audit logging for retry actions
  // ----------------------------------------------------------------

  describe('audit logging for feedback and retry', () => {
    it('should record operator_retry in audit log with feedback content', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.retryStep(task.id, 'Please fix the bug', 'operator-1');

      const auditEntries = await auditLog.query({
        eventType: 'coding_task',
      });

      const retryEntry = auditEntries.find(
        (e) => e.operation === 'operator_retry',
      );
      expect(retryEntry).toBeDefined();
      expect(retryEntry!.operatorId).toBe('operator-1');
      expect(retryEntry!.details.taskId).toBe(task.id);
      expect(retryEntry!.details.stepId).toBe(step.id);
      expect(retryEntry!.details.feedback).toBe('Please fix the bug');
      expect(retryEntry!.details.retryCount).toBe(1);
    });
  });
});
