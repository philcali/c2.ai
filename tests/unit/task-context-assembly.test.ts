import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskOrchestrator } from '../../src/subsystems/task-orchestrator.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { MemoryStore } from '../../src/subsystems/memory-store.js';
import { AgentDiscoveryRegistry } from '../../src/subsystems/agent-discovery-registry.js';
import { MCPGateway } from '../../src/subsystems/mcp-gateway.js';
import { AntiLeakage } from '../../src/subsystems/anti-leakage.js';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import type {
  IOperatorInterface,
} from '../../src/interfaces/operator-interface.js';
import type {
  IAgentConnector,
  ConnectedAgent,
  AgentEvent,
  DispatchResult,
  TaskContext,
} from '../../src/interfaces/agent-connector.js';
import type { CodingTaskSubmission } from '../../src/interfaces/task-orchestrator.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockOperatorInterface(): IOperatorInterface {
  return {
    handleConnection: vi.fn(),
    broadcastEvent: vi.fn(),
  };
}

function createMockAgentConnector(overrides?: {
  getAgent?: () => ConnectedAgent | undefined;
}): {
  connector: IAgentConnector;
  dispatchStepMock: ReturnType<typeof vi.fn>;
} {
  const dispatchStepMock = vi.fn().mockResolvedValue({
    success: true,
  } satisfies DispatchResult);

  const defaultAgent: ConnectedAgent = {
    agentId: 'agent-alpha',
    sessionId: 'session-1',
    protocol: 'process-spawn',
    healthStatus: 'healthy',
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
  };

  const connector: IAgentConnector = {
    connect: vi.fn().mockResolvedValue(defaultAgent),
    disconnect: vi.fn().mockResolvedValue(undefined),
    dispatchStep: dispatchStepMock,
    getAgent: overrides?.getAgent ?? vi.fn().mockReturnValue(defaultAgent),
    listAgents: vi.fn().mockReturnValue([]),
    findCapableAgents: vi.fn().mockReturnValue([defaultAgent]),
    registerEventSource: vi.fn(),
    deregisterEventSource: vi.fn(),
    onAgentEvent: vi.fn(),
  };

  return { connector, dispatchStepMock };
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

describe('TaskOrchestrator — Task_Context Assembly (Task 7.3)', () => {
  let auditLog: AuditLog;
  let policyEngine: PolicyEngine;
  let memoryStore: MemoryStore;
  let discoveryRegistry: AgentDiscoveryRegistry;
  let mcpGateway: MCPGateway;
  let operatorInterface: IOperatorInterface;
  let sessionManager: SessionManager;

  beforeEach(() => {
    auditLog = new AuditLog();
    policyEngine = new PolicyEngine();
    const antiLeakage = new AntiLeakage({ policyEngine });
    discoveryRegistry = new AgentDiscoveryRegistry();
    mcpGateway = new MCPGateway({ policyEngine, auditLog, antiLeakage });
    operatorInterface = createMockOperatorInterface();
    sessionManager = new SessionManager({
      auditLog,
      policyEngine,
    });
    memoryStore = new MemoryStore({ policyEngine, auditLog });

    // Add wildcard allow policy for task namespaces.
    policyEngine.addPolicy({
      id: 'allow-all-task-write',
      version: 1,
      agentId: '*',
      operations: ['write', 'read'],
      resources: ['memory:task:*'],
      effect: 'allow',
    } as AccessPolicy);
  });

  // ----------------------------------------------------------------
  // maxContextSizeBytes configuration
  // ----------------------------------------------------------------

  describe('maxContextSizeBytes configuration', () => {
    it('should default maxContextSizeBytes to 10 MB', () => {
      const { connector } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });
      expect(orchestrator.getMaxContextSizeBytes()).toBe(10 * 1024 * 1024);
    });

    it('should accept a custom maxContextSizeBytes', () => {
      const { connector } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        maxContextSizeBytes: 5 * 1024 * 1024,
      });
      expect(orchestrator.getMaxContextSizeBytes()).toBe(5 * 1024 * 1024);
    });
  });

  // ----------------------------------------------------------------
  // Context size enforcement (Req 10.6)
  // ----------------------------------------------------------------

  describe('context size enforcement', () => {
    it('should throw when context exceeds maxContextSizeBytes', async () => {
      const { connector } = createMockAgentConnector();
      // Set a very small limit to trigger the error.
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        maxContextSizeBytes: 10, // 10 bytes — will always be exceeded
      });

      const task = await orchestrator.createTask(makeSubmission());
      await expect(orchestrator.dispatchCurrentStep(task.id)).rejects.toThrow(
        /Task_Context size .* exceeds maximum allowed size/,
      );
    });

    it('should include maxContextSizeBytes in the dispatched context', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        maxContextSizeBytes: 50 * 1024 * 1024, // 50 MB — large enough
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      expect(dispatchStepMock).toHaveBeenCalledTimes(1);
      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.maxContextSizeBytes).toBe(50 * 1024 * 1024);
    });

    it('should allow dispatch when context is within size limit', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      expect(dispatchStepMock).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------------
  // Isolation boundary from SessionManager (Req 10.4)
  // ----------------------------------------------------------------

  describe('isolation boundary from SessionManager', () => {
    it('should include isolation boundary from agent session when sessionManager is provided', async () => {
      // Create a session with a known isolation boundary.
      const manifest: AgentManifest = {
        id: 'manifest-1',
        agentIdentity: 'agent-alpha',
        description: 'Test agent',
        memoryNamespaces: [
          { namespace: 'project', access: 'readwrite' },
        ],
        communicationChannels: ['general'],
        mcpOperations: [
          { serviceId: 'github', operations: ['read'] },
        ],
      };

      const session = await sessionManager.createSession(manifest, 'operator-1');

      const { connector, dispatchStepMock } = createMockAgentConnector({
        getAgent: () => ({
          agentId: 'agent-alpha',
          sessionId: session.id,
          protocol: 'process-spawn',
          healthStatus: 'healthy',
          connectedAt: new Date(),
          lastHeartbeat: new Date(),
        }),
      });

      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        sessionManager,
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.isolationBoundary).toBeDefined();
      expect(context.isolationBoundary.allowedNamespaces).toEqual(
        session.isolationBoundary.allowedNamespaces,
      );
      expect(context.isolationBoundary.allowedChannels).toEqual(
        session.isolationBoundary.allowedChannels,
      );
      expect(context.isolationBoundary.allowedServices).toEqual(
        session.isolationBoundary.allowedServices,
      );
    });

    it('should fall back to empty boundary when sessionManager is not provided', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        // No sessionManager
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.isolationBoundary).toEqual({
        allowedNamespaces: [],
        allowedChannels: [],
        allowedServices: [],
      });
    });

    it('should fall back to empty boundary when session is not found', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector({
        getAgent: () => ({
          agentId: 'agent-alpha',
          sessionId: 'non-existent-session',
          protocol: 'process-spawn',
          healthStatus: 'healthy',
          connectedAt: new Date(),
          lastHeartbeat: new Date(),
        }),
      });

      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
        sessionManager,
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.isolationBoundary).toEqual({
        allowedNamespaces: [],
        allowedChannels: [],
        allowedServices: [],
      });
    });
  });

  // ----------------------------------------------------------------
  // File contents inclusion (Req 10.2)
  // ----------------------------------------------------------------

  describe('file contents inclusion with policy check', () => {
    it('should include authorized file contents in context', async () => {
      // Add a policy allowing file reads.
      policyEngine.addPolicy({
        id: 'allow-file-read',
        version: 1,
        agentId: 'agent-alpha',
        operations: ['read'],
        resources: ['file:*'],
        effect: 'allow',
      } as AccessPolicy);

      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [{
          instructions: 'Read and modify files',
          executionMode: 'agent',
          filePaths: ['src/index.ts', 'src/main.ts'],
        }],
      }));

      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.filePaths).toEqual(['src/index.ts', 'src/main.ts']);
      expect(context.fileContents).toBeDefined();
      expect(context.fileContents!['src/index.ts']).toBeDefined();
      expect(context.fileContents!['src/main.ts']).toBeDefined();
    });

    it('should exclude unauthorized file contents from context', async () => {
      // Add a deny policy for file reads.
      policyEngine.addPolicy({
        id: 'deny-file-read',
        version: 1,
        agentId: 'agent-alpha',
        operations: ['read'],
        resources: ['file:*'],
        effect: 'deny',
      } as AccessPolicy);

      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [{
          instructions: 'Read files',
          executionMode: 'agent',
          filePaths: ['src/secret.ts'],
        }],
      }));

      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.filePaths).toEqual(['src/secret.ts']);
      // fileContents should be undefined since the file was denied.
      expect(context.fileContents).toBeUndefined();
    });

    it('should not include fileContents when no filePaths are specified', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.filePaths).toBeUndefined();
      expect(context.fileContents).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // Memory_Store data inclusion (Req 10.3)
  // ----------------------------------------------------------------

  describe('memory data inclusion with policy check', () => {
    it('should include authorized memory data in context', async () => {
      // Add a policy allowing memory reads.
      policyEngine.addPolicy({
        id: 'allow-memory-read',
        version: 1,
        agentId: 'agent-alpha',
        operations: ['read'],
        resources: ['memory:project'],
        effect: 'allow',
      } as AccessPolicy);

      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [{
          instructions: 'Use memory data',
          executionMode: 'agent',
          memoryReferences: [
            { namespace: 'project', key: 'config' },
          ],
        }],
      }));

      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.memoryReferences).toEqual([
        { namespace: 'project', key: 'config' },
      ]);
      expect(context.memoryData).toBeDefined();
      expect(context.memoryData!['project:config']).toBeDefined();
    });

    it('should exclude unauthorized memory data from context', async () => {
      // Add a deny policy for memory reads.
      policyEngine.addPolicy({
        id: 'deny-memory-read',
        version: 1,
        agentId: 'agent-alpha',
        operations: ['read'],
        resources: ['memory:secret'],
        effect: 'deny',
      } as AccessPolicy);

      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [{
          instructions: 'Use memory data',
          executionMode: 'agent',
          memoryReferences: [
            { namespace: 'secret', key: 'api-key' },
          ],
        }],
      }));

      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.memoryReferences).toEqual([
        { namespace: 'secret', key: 'api-key' },
      ]);
      // memoryData should be undefined since the namespace was denied.
      expect(context.memoryData).toBeUndefined();
    });

    it('should not include memoryData when no memoryReferences are specified', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.memoryReferences).toBeUndefined();
      expect(context.memoryData).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // Prior step artifacts and feedback (Req 10.5)
  // ----------------------------------------------------------------

  describe('prior step artifacts and feedback inclusion', () => {
    it('should include all prior step artifacts in context', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [
          { instructions: 'Step 1', executionMode: 'agent' },
          { instructions: 'Step 2', executionMode: 'agent' },
        ],
      }));

      // Dispatch step 1.
      await orchestrator.dispatchCurrentStep(task.id);

      // Add artifacts to step 1 and transition to review.
      const step1 = task.steps[0];
      step1.artifacts.push({
        id: 'art-1',
        taskId: task.id,
        stepId: step1.id,
        type: 'diff',
        timestamp: new Date(),
        data: { filePath: 'a.ts', beforeContent: 'old', afterContent: 'new' },
      });
      step1.status = 'review';
      step1.updatedAt = new Date();

      // Advance to step 2.
      await orchestrator.advanceTask(task.id, 'operator-1');

      // The second dispatch call should include prior artifacts.
      expect(dispatchStepMock).toHaveBeenCalledTimes(2);
      const context: TaskContext = dispatchStepMock.mock.calls[1][1];
      expect(context.priorStepArtifacts).toBeDefined();
      expect(context.priorStepArtifacts!.length).toBe(1);
      expect(context.priorStepArtifacts![0].id).toBe('art-1');
    });

    it('should include all operator feedback in context on retry', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission());
      await orchestrator.dispatchCurrentStep(task.id);

      // Transition step to review.
      const step = task.steps[0];
      step.status = 'review';
      step.updatedAt = new Date();

      // Retry with feedback.
      await orchestrator.retryStep(task.id, 'Please fix the bug', 'operator-1');

      // The retry dispatch should include feedback.
      expect(dispatchStepMock).toHaveBeenCalledTimes(2);
      const context: TaskContext = dispatchStepMock.mock.calls[1][1];
      expect(context.operatorFeedback).toBeDefined();
      expect(context.operatorFeedback!.length).toBe(1);
      expect(context.operatorFeedback![0].content).toBe('Please fix the bug');
    });
  });

  // ----------------------------------------------------------------
  // Step instructions (Req 10.1)
  // ----------------------------------------------------------------

  describe('step instructions inclusion', () => {
    it('should include step instructions verbatim in context', async () => {
      const { connector, dispatchStepMock } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [{
          instructions: 'Implement the login feature with OAuth2',
          executionMode: 'agent',
        }],
      }));

      await orchestrator.dispatchCurrentStep(task.id);

      const context: TaskContext = dispatchStepMock.mock.calls[0][1];
      expect(context.instructions).toBe('Implement the login feature with OAuth2');
    });
  });

  // ----------------------------------------------------------------
  // filePaths and memoryReferences carried through to TaskStep
  // ----------------------------------------------------------------

  describe('TaskStepDefinition fields carried to TaskStep', () => {
    it('should carry filePaths from step definition to task step', async () => {
      const { connector } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [{
          instructions: 'Read files',
          executionMode: 'agent',
          filePaths: ['src/a.ts', 'src/b.ts'],
        }],
      }));

      expect(task.steps[0].filePaths).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('should carry memoryReferences from step definition to task step', async () => {
      const { connector } = createMockAgentConnector();
      const orchestrator = new TaskOrchestrator({
        agentConnector: connector,
        memoryStore,
        policyEngine,
        mcpGateway,
        auditLog,
        operatorInterface,
        discoveryRegistry,
      });

      const task = await orchestrator.createTask(makeSubmission({
        steps: [{
          instructions: 'Use memory',
          executionMode: 'agent',
          memoryReferences: [{ namespace: 'ns', key: 'k' }],
        }],
      }));

      expect(task.steps[0].memoryReferences).toEqual([{ namespace: 'ns', key: 'k' }]);
    });
  });
});
