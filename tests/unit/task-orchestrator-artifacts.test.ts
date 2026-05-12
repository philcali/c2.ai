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
} from '../../src/interfaces/operator-interface.js';
import type {
  IAgentConnector,
  ExecutionArtifact,
  ConnectedAgent,
  CapabilityRequirements,
  AgentEvent,
  DispatchResult,
} from '../../src/interfaces/agent-connector.js';
import type { CodingTaskSubmission } from '../../src/interfaces/task-orchestrator.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub OperatorInterface for testing. */
function createMockOperatorInterface(): IOperatorInterface {
  return {
    handleConnection: vi.fn(),
    broadcastEvent: vi.fn(),
  };
}

/**
 * Stub AgentConnector that succeeds on dispatch and captures the event handler.
 * This avoids needing a real AgentCP session.
 */
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

describe('TaskOrchestrator — Artifact Storage and Querying (Task 7.1)', () => {
  let auditLog: AuditLog;
  let policyEngine: PolicyEngine;
  let memoryStore: MemoryStore;
  let discoveryRegistry: AgentDiscoveryRegistry;
  let mcpGateway: MCPGateway;
  let operatorInterface: IOperatorInterface;
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

    // Add a wildcard allow policy for all agents to write/read task namespaces.
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
  // Artifact retention configuration
  // ----------------------------------------------------------------

  describe('artifact retention configuration', () => {
    it('should default artifactRetentionMs to 30 days', () => {
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(orchestrator.getArtifactRetentionMs()).toBe(thirtyDaysMs);
    });

    it('should accept a custom artifactRetentionMs', () => {
      const customOrchestrator = new TaskOrchestrator({
        agentConnector: mockConnector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        artifactRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      });
      expect(customOrchestrator.getArtifactRetentionMs()).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  // ----------------------------------------------------------------
  // Artifact storage in Memory_Store
  // ----------------------------------------------------------------

  describe('artifact storage in Memory_Store on step completion', () => {
    it('should persist artifacts to Memory_Store when a step is advanced to completed', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
        type: 'diff',
      });
      step.artifacts.push(artifact);

      // Manually transition step to review (simulating agent completion).
      step.status = 'review';
      step.updatedAt = new Date();

      // Advance the task — this should persist artifacts.
      await orchestrator.advanceTask(task.id, 'operator-1');

      // Verify artifact was stored in Memory_Store.
      const entries = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
        tags: [`task:${task.id}`],
      });

      expect(entries.length).toBeGreaterThanOrEqual(1);
      const storedArtifact = entries.find(
        (e) => (e.value as ExecutionArtifact).id === artifact.id,
      );
      expect(storedArtifact).toBeDefined();
      expect((storedArtifact!.value as ExecutionArtifact).type).toBe('diff');
    });

    it('should persist artifacts with correct tags', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'art-tagged',
        taskId: task.id,
        stepId: step.id,
        type: 'terminal_output',
        data: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '' },
      });
      step.artifacts.push(artifact);
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.advanceTask(task.id, 'operator-1');

      // Query by specific tags.
      const byType = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
        tags: [`type:terminal_output`],
      });
      expect(byType.length).toBeGreaterThanOrEqual(1);

      const byStep = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
        tags: [`step:${step.id}`],
      });
      expect(byStep.length).toBeGreaterThanOrEqual(1);
    });

    it('should persist artifacts on task cancellation', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
        type: 'error',
        data: { code: 'BUILD_FAILURE', message: 'Build failed' },
      });
      step.artifacts.push(artifact);

      await orchestrator.cancelTask(task.id, 'No longer needed', 'operator-1');

      // Verify artifact was persisted.
      const entries = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
        tags: [`task:${task.id}`],
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should persist artifacts on step interrupt (transition to review)', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
        type: 'tool_invocation',
        data: { toolName: 'readFile', params: { path: 'src/index.ts' }, result: 'content' },
      });
      step.artifacts.push(artifact);

      await orchestrator.interruptStep(task.id, 'operator-1');

      // Verify artifact was persisted.
      const entries = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
        tags: [`task:${task.id}`],
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should persist artifacts via handleAgentEvent when agent reports step_result', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'agent-artifact',
        taskId: task.id,
        stepId: step.id,
        type: 'diff',
      });

      // Simulate agent sending a step_result event.
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

      // Give async persistence a tick to complete.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify artifact was persisted to Memory_Store.
      const entries = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
        tags: [`task:${task.id}`],
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const stored = entries.find(
        (e) => (e.value as ExecutionArtifact).id === 'agent-artifact',
      );
      expect(stored).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // queryArtifacts with Memory_Store integration
  // ----------------------------------------------------------------

  describe('queryArtifacts with Memory_Store integration', () => {
    it('should return in-memory artifacts from task steps', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      const step = task.steps[0];

      const artifact1 = makeArtifact({ id: 'a1', taskId: task.id, stepId: step.id, type: 'diff' });
      const artifact2 = makeArtifact({ id: 'a2', taskId: task.id, stepId: step.id, type: 'terminal_output' });
      step.artifacts.push(artifact1, artifact2);

      const results = await orchestrator.queryArtifacts({ taskId: task.id });
      expect(results.length).toBe(2);
      expect(results.map((a) => a.id)).toContain('a1');
      expect(results.map((a) => a.id)).toContain('a2');
    });

    it('should filter artifacts by stepId', async () => {
      const task = await orchestrator.createTask(
        makeSubmission({
          steps: [
            { instructions: 'Step 1', executionMode: 'agent' },
            { instructions: 'Step 2', executionMode: 'agent' },
          ],
        }),
      );

      const step1 = task.steps[0];
      const step2 = task.steps[1];

      step1.artifacts.push(makeArtifact({ id: 's1-a1', taskId: task.id, stepId: step1.id }));
      step2.artifacts.push(makeArtifact({ id: 's2-a1', taskId: task.id, stepId: step2.id }));

      const results = await orchestrator.queryArtifacts({
        taskId: task.id,
        stepId: step1.id,
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('s1-a1');
    });

    it('should filter artifacts by type', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      const step = task.steps[0];

      step.artifacts.push(
        makeArtifact({ id: 'diff-1', taskId: task.id, stepId: step.id, type: 'diff' }),
        makeArtifact({
          id: 'term-1',
          taskId: task.id,
          stepId: step.id,
          type: 'terminal_output',
          data: { command: 'npm test', exitCode: 0, stdout: '', stderr: '' },
        }),
      );

      const results = await orchestrator.queryArtifacts({
        taskId: task.id,
        type: 'terminal_output',
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('term-1');
    });

    it('should filter artifacts by time range', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      const step = task.steps[0];

      const oldDate = new Date('2023-01-01');
      const recentDate = new Date('2024-06-15');

      step.artifacts.push(
        makeArtifact({ id: 'old', taskId: task.id, stepId: step.id, timestamp: oldDate }),
        makeArtifact({ id: 'recent', taskId: task.id, stepId: step.id, timestamp: recentDate }),
      );

      const results = await orchestrator.queryArtifacts({
        taskId: task.id,
        timeRange: { start: new Date('2024-01-01'), end: new Date('2025-01-01') },
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('recent');
    });

    it('should return empty array for non-existent task', async () => {
      const results = await orchestrator.queryArtifacts({ taskId: 'non-existent' });
      expect(results).toEqual([]);
    });

    it('should deduplicate artifacts from in-memory and Memory_Store', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'dedup-artifact',
        taskId: task.id,
        stepId: step.id,
        type: 'diff',
      });
      step.artifacts.push(artifact);

      // Also persist the same artifact to Memory_Store directly.
      await memoryStore.write(
        'system',
        `task:${task.id}`,
        `artifact:${artifact.id}`,
        artifact,
        [`type:diff`, `step:${step.id}`, `task:${task.id}`],
      );

      const results = await orchestrator.queryArtifacts({ taskId: task.id });
      // Should not have duplicates.
      const ids = results.map((a) => a.id);
      const uniqueIds = new Set(ids);
      expect(ids.length).toBe(uniqueIds.size);
    });

    it('should return Memory_Store artifacts even when task is not in memory', async () => {
      // Simulate a scenario where artifacts exist in Memory_Store but the task
      // is no longer in the orchestrator's in-memory map (e.g., after restart).
      const taskId = 'orphaned-task-id';
      const artifact = makeArtifact({
        id: 'orphaned-artifact',
        taskId,
        stepId: 'step-orphaned',
        type: 'terminal_output',
        data: { command: 'npm test', exitCode: 0, stdout: 'pass', stderr: '' },
      });

      await memoryStore.write(
        'system',
        `task:${taskId}`,
        `artifact:${artifact.id}`,
        artifact,
        [`type:terminal_output`, `step:step-orphaned`, `task:${taskId}`],
      );

      const results = await orchestrator.queryArtifacts({ taskId });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('orphaned-artifact');
    });
  });

  // ----------------------------------------------------------------
  // Artifact types: diff, terminal_output, tool_invocation, error
  // ----------------------------------------------------------------

  describe('captures all artifact types', () => {
    it('should store diff artifacts with before/after content', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const diffArtifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
        type: 'diff',
        data: {
          filePath: 'src/main.ts',
          beforeContent: 'const x = 1;',
          afterContent: 'const x = 2;',
        },
      });
      step.artifacts.push(diffArtifact);
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.advanceTask(task.id, 'operator-1');

      const results = await orchestrator.queryArtifacts({
        taskId: task.id,
        type: 'diff',
      });
      expect(results.length).toBe(1);
      const data = results[0].data as { filePath: string; beforeContent: string; afterContent: string };
      expect(data.filePath).toBe('src/main.ts');
      expect(data.beforeContent).toBe('const x = 1;');
      expect(data.afterContent).toBe('const x = 2;');
    });

    it('should store terminal output artifacts with command, exit code, stdout, stderr', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const termArtifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
        type: 'terminal_output',
        data: {
          command: 'npm run build',
          exitCode: 1,
          stdout: 'Building...',
          stderr: 'Error: module not found',
        },
      });
      step.artifacts.push(termArtifact);
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.advanceTask(task.id, 'operator-1');

      const results = await orchestrator.queryArtifacts({
        taskId: task.id,
        type: 'terminal_output',
      });
      expect(results.length).toBe(1);
      const data = results[0].data as { command: string; exitCode: number; stdout: string; stderr: string };
      expect(data.command).toBe('npm run build');
      expect(data.exitCode).toBe(1);
      expect(data.stdout).toBe('Building...');
      expect(data.stderr).toBe('Error: module not found');
    });

    it('should store tool invocation artifacts', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const toolArtifact = makeArtifact({
        taskId: task.id,
        stepId: step.id,
        type: 'tool_invocation',
        data: {
          toolName: 'writeFile',
          params: { path: 'src/new.ts', content: 'export {}' },
          result: { success: true },
        },
      });
      step.artifacts.push(toolArtifact);
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.advanceTask(task.id, 'operator-1');

      const results = await orchestrator.queryArtifacts({
        taskId: task.id,
        type: 'tool_invocation',
      });
      expect(results.length).toBe(1);
      const data = results[0].data as { toolName: string; params: unknown; result: unknown };
      expect(data.toolName).toBe('writeFile');
    });
  });

  // ----------------------------------------------------------------
  // Memory_Store namespace convention
  // ----------------------------------------------------------------

  describe('Memory_Store namespace and key conventions', () => {
    it('should use task:{taskId} namespace and artifact:{artifactId} key', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'convention-test-artifact',
        taskId: task.id,
        stepId: step.id,
      });
      step.artifacts.push(artifact);
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.advanceTask(task.id, 'operator-1');

      // Read directly from Memory_Store using the expected namespace/key.
      const readResult = await memoryStore.read(
        'system',
        `task:${task.id}`,
        `artifact:convention-test-artifact`,
      );
      expect(readResult.found).toBe(true);
      expect((readResult.entry!.value as ExecutionArtifact).id).toBe('convention-test-artifact');
    });
  });

  // ----------------------------------------------------------------
  // Retention policy
  // ----------------------------------------------------------------

  describe('artifact retention on task completion/cancellation', () => {
    it('should retain artifacts in Memory_Store after task completion', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'retained-artifact',
        taskId: task.id,
        stepId: step.id,
      });
      step.artifacts.push(artifact);
      step.status = 'review';
      step.updatedAt = new Date();

      await orchestrator.advanceTask(task.id, 'operator-1');

      // Task should be completed now.
      const completedTask = orchestrator.getTask(task.id);
      expect(completedTask?.status).toBe('completed');

      // Artifacts should still be in Memory_Store.
      const entries = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should retain artifacts in Memory_Store after task cancellation', async () => {
      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const step = task.steps[0];
      const artifact = makeArtifact({
        id: 'canceled-artifact',
        taskId: task.id,
        stepId: step.id,
      });
      step.artifacts.push(artifact);

      await orchestrator.cancelTask(task.id, 'Canceled by operator', 'operator-1');

      // Artifacts should still be in Memory_Store.
      const entries = await memoryStore.query('system', {
        namespace: `task:${task.id}`,
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });
  });
});
