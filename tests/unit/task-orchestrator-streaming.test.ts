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
} from '../../src/interfaces/agent-connector.js';
import type {
  CodingTaskSubmission,
  TaskEvent,
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
} {
  let eventHandler: ((event: AgentEvent) => void) | undefined;

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
    dispatchStep: vi.fn().mockResolvedValue({
      success: true,
    } satisfies DispatchResult),
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

describe('TaskOrchestrator — Real-Time Artifact Streaming and Buffering (Task 7.7)', () => {
  let auditLog: AuditLog;
  let policyEngine: PolicyEngine;
  let memoryStore: MemoryStore;
  let discoveryRegistry: AgentDiscoveryRegistry;
  let mcpGateway: MCPGateway;
  let operatorInterface: ReturnType<typeof createMockOperatorInterface>;
  let mockConnector: IAgentConnector;
  let getEventHandler: () => ((event: AgentEvent) => void) | undefined;
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
  // Req 8.1: Real-time artifact streaming via broadcastEvent
  // ----------------------------------------------------------------

  describe('real-time artifact streaming (Req 8.1)', () => {
    it('should stream a single artifact to operator via broadcastEvent on task channel', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'stream-art-1',
        taskId: task.id,
        stepId: step.id,
      });

      const handler = getEventHandler();
      expect(handler).toBeDefined();

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: { artifact },
      });

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const artifactBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'artifact_stream',
      );

      expect(artifactBroadcast).toBeDefined();
      expect(artifactBroadcast![0]).toBe(`task:${task.id}`);
      const eventData = artifactBroadcast![1].data as { artifact: ExecutionArtifact };
      expect(eventData.artifact.id).toBe('stream-art-1');
    });

    it('should stream multiple artifacts individually as they arrive', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      // Send first artifact
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'art-1', taskId: task.id, stepId: step.id }),
        },
      });

      // Send second artifact
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'art-2', taskId: task.id, stepId: step.id }),
        },
      });

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const artifactBroadcasts = broadcastCalls.filter(
        (call) => call[1].type === 'artifact_stream',
      );

      expect(artifactBroadcasts.length).toBe(2);
      expect(
        (artifactBroadcasts[0][1].data as { artifact: ExecutionArtifact }).artifact.id,
      ).toBe('art-1');
      expect(
        (artifactBroadcasts[1][1].data as { artifact: ExecutionArtifact }).artifact.id,
      ).toBe('art-2');
    });

    it('should stream each artifact in a batch individually via broadcastEvent', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      // Send a batch of artifacts
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifacts: [
            makeArtifact({ id: 'batch-1', taskId: task.id, stepId: step.id }),
            makeArtifact({ id: 'batch-2', taskId: task.id, stepId: step.id }),
            makeArtifact({ id: 'batch-3', taskId: task.id, stepId: step.id }),
          ],
        },
      });

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const artifactBroadcasts = broadcastCalls.filter(
        (call) => call[1].type === 'artifact_stream',
      );

      expect(artifactBroadcasts.length).toBe(3);
      const ids = artifactBroadcasts.map(
        (call) => (call[1].data as { artifact: ExecutionArtifact }).artifact.id,
      );
      expect(ids).toContain('batch-1');
      expect(ids).toContain('batch-2');
      expect(ids).toContain('batch-3');
    });
  });

  // ----------------------------------------------------------------
  // Req 8.2: Task-specific channel and step status broadcasts
  // ----------------------------------------------------------------

  describe('task-specific channel (Req 8.2)', () => {
    it('should use task:{taskId} channel pattern for artifact streaming', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ taskId: task.id, stepId: step.id }),
        },
      });

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const artifactBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'artifact_stream',
      );

      expect(artifactBroadcast).toBeDefined();
      expect(artifactBroadcast![0]).toBe(`task:${task.id}`);
      expect(artifactBroadcast![1].channel).toBe(`task:${task.id}`);
    });

    it('should broadcast step status changes on task channel', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const broadcastCalls = operatorInterface.broadcastEvent.mock.calls as Array<
        [EventChannel, SystemEvent]
      >;
      const statusBroadcast = broadcastCalls.find(
        (call) => call[1].type === 'step_status_change',
      );

      expect(statusBroadcast).toBeDefined();
      expect(statusBroadcast![0]).toBe(`task:${task.id}`);
      const eventData = statusBroadcast![1].data as {
        taskId: string;
        stepId: string;
        newStatus: string;
      };
      expect(eventData.taskId).toBe(task.id);
      expect(eventData.newStatus).toBe('executing');
    });
  });

  // ----------------------------------------------------------------
  // Req 8.4: Artifact buffering for late-joining operators
  // ----------------------------------------------------------------

  describe('artifact buffering for late-joining operators (Req 8.4)', () => {
    it('should accumulate artifacts in the buffer as they arrive', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'buf-1', taskId: task.id, stepId: step.id }),
        },
      });

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'buf-2', taskId: task.id, stepId: step.id }),
        },
      });

      const buffer = orchestrator.getArtifactBuffer(task.id);
      expect(buffer.length).toBe(2);
      expect(buffer[0].id).toBe('buf-1');
      expect(buffer[1].id).toBe('buf-2');
    });

    it('should return full artifact history for late-joining operator via getArtifactBuffer', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      // Simulate 3 artifacts arriving over time
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'late-1', taskId: task.id, stepId: step.id }),
        },
      });

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'late-2', taskId: task.id, stepId: step.id }),
        },
      });

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'late-3', taskId: task.id, stepId: step.id }),
        },
      });

      // Late-joining operator retrieves full history
      const buffer = orchestrator.getArtifactBuffer(task.id);
      expect(buffer.length).toBe(3);
      expect(buffer.map((a) => a.id)).toEqual(['late-1', 'late-2', 'late-3']);
    });

    it('should buffer batch artifacts from a single event', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifacts: [
            makeArtifact({ id: 'batch-a', taskId: task.id, stepId: step.id }),
            makeArtifact({ id: 'batch-b', taskId: task.id, stepId: step.id }),
          ],
        },
      });

      const buffer = orchestrator.getArtifactBuffer(task.id);
      expect(buffer.length).toBe(2);
      expect(buffer.map((a) => a.id)).toEqual(['batch-a', 'batch-b']);
    });

    it('should return empty array for a task with no buffered artifacts', () => {
      const buffer = orchestrator.getArtifactBuffer('non-existent-task');
      expect(buffer).toEqual([]);
    });

    it('should return a copy of the buffer (not a reference)', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'copy-test', taskId: task.id, stepId: step.id }),
        },
      });

      const buffer1 = orchestrator.getArtifactBuffer(task.id);
      const buffer2 = orchestrator.getArtifactBuffer(task.id);

      // Should be equal but not the same reference
      expect(buffer1).toEqual(buffer2);
      expect(buffer1).not.toBe(buffer2);

      // Mutating the returned array should not affect the internal buffer
      buffer1.push(makeArtifact({ id: 'injected' }));
      const buffer3 = orchestrator.getArtifactBuffer(task.id);
      expect(buffer3.length).toBe(1);
    });
  });

  // ----------------------------------------------------------------
  // Buffer cleanup on terminal states
  // ----------------------------------------------------------------

  describe('buffer cleanup on terminal states', () => {
    it('should clear the buffer when a task completes', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      // Add artifacts to buffer
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'pre-complete', taskId: task.id, stepId: step.id }),
        },
      });

      expect(orchestrator.getArtifactBuffer(task.id).length).toBe(1);

      // Complete the step via agent event
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: { success: true },
      });

      // Advance the task (step is now in review)
      await orchestrator.advanceTask(task.id, 'operator-1');

      // Task should be completed (single step)
      const completedTask = orchestrator.getTask(task.id);
      expect(completedTask?.status).toBe('completed');

      // Buffer should be cleared
      expect(orchestrator.getArtifactBuffer(task.id)).toEqual([]);
    });

    it('should clear the buffer when a task is canceled', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      // Add artifacts to buffer
      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'pre-cancel', taskId: task.id, stepId: step.id }),
        },
      });

      expect(orchestrator.getArtifactBuffer(task.id).length).toBe(1);

      // Cancel the task
      await orchestrator.cancelTask(task.id, 'No longer needed', 'operator-1');

      // Buffer should be cleared
      expect(orchestrator.getArtifactBuffer(task.id)).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // onTaskEvent handler
  // ----------------------------------------------------------------

  describe('onTaskEvent handler for task event subscriptions', () => {
    it('should receive artifact_received events when artifacts arrive', async () => {
      const events: TaskEvent[] = [];
      orchestrator.onTaskEvent((event) => events.push(event));

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const handler = getEventHandler();

      handler!({
        type: 'step_result',
        agentId: 'agent-alpha',
        timestamp: new Date(),
        data: {
          artifact: makeArtifact({ id: 'event-art', taskId: task.id, stepId: step.id }),
        },
      });

      const artifactEvents = events.filter((e) => e.type === 'artifact_received');
      expect(artifactEvents.length).toBe(1);
      expect(artifactEvents[0].taskId).toBe(task.id);
      expect(artifactEvents[0].stepId).toBe(step.id);
      expect((artifactEvents[0].data as { artifactId: string }).artifactId).toBe('event-art');
    });

    it('should receive step_status_change events on step transitions', async () => {
      const events: TaskEvent[] = [];
      orchestrator.onTaskEvent((event) => events.push(event));

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const stepStatusEvents = events.filter((e) => e.type === 'step_status_change');
      expect(stepStatusEvents.length).toBeGreaterThanOrEqual(1);

      const executingEvent = stepStatusEvents.find(
        (e) => (e.data as { newStatus: string }).newStatus === 'executing',
      );
      expect(executingEvent).toBeDefined();
      expect(executingEvent!.taskId).toBe(task.id);
    });

    it('should receive events from multiple registered handlers', async () => {
      const events1: TaskEvent[] = [];
      const events2: TaskEvent[] = [];
      orchestrator.onTaskEvent((event) => events1.push(event));
      orchestrator.onTaskEvent((event) => events2.push(event));

      const task = await orchestrator.createTask(makeSubmission());

      // Both handlers should receive the task_created event
      expect(events1.some((e) => e.type === 'task_created')).toBe(true);
      expect(events2.some((e) => e.type === 'task_created')).toBe(true);
    });

    it('should not throw if a handler throws an error', async () => {
      orchestrator.onTaskEvent(() => {
        throw new Error('Handler error');
      });

      // Should not throw
      await expect(orchestrator.createTask(makeSubmission())).resolves.toBeDefined();
    });
  });
});
