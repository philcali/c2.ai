import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TaskPlanner } from '../../src/subsystems/task-planner.js';
import type { IMCPGateway, OperationResult, ServiceConfig, ServiceStatus } from '../../src/interfaces/mcp-gateway.js';
import type { ITaskOrchestrator, CodingTask, CodingTaskSubmission, TaskStepDefinition } from '../../src/interfaces/task-orchestrator.js';
import type { IAuditLog, AuditEntry, AuditQuery, AuditFilter } from '../../src/interfaces/audit-log.js';
import type {
  OrchestrationLlmConfig,
  PlanningContext,
  StructuredIntent,
  WorkspaceContext,
  GeneratedPlan,
} from '../../src/interfaces/orchestration-config.js';
import type { CapabilityRequirements } from '../../src/interfaces/agent-connector.js';
import type { ValidationResult } from '../../src/interfaces/manifest-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMCPGateway(): IMCPGateway & { executeOperationMock: ReturnType<typeof vi.fn> } {
  const executeOperationMock = vi.fn<(serviceId: string, operation: string, agentId: string, params: unknown) => Promise<OperationResult>>();
  return {
    registerService: vi.fn() as unknown as (config: ServiceConfig) => ValidationResult,
    unregisterService: vi.fn(),
    executeOperation: executeOperationMock,
    listServices: vi.fn().mockReturnValue([]),
    getServiceStatus: vi.fn().mockReturnValue({ serviceId: 'test', available: true, lastChecked: new Date() } as ServiceStatus),
    executeOperationMock,
  };
}

function createMockTaskOrchestrator(): ITaskOrchestrator & { createTaskMock: ReturnType<typeof vi.fn> } {
  const createTaskMock = vi.fn<(submission: CodingTaskSubmission) => Promise<CodingTask>>();
  createTaskMock.mockImplementation(async (submission: CodingTaskSubmission) => ({
    id: 'task-123',
    operatorId: submission.operatorId,
    status: 'pending',
    assignedAgentId: submission.agentId,
    steps: submission.steps.map((s, i) => ({
      id: `step-${i}`,
      taskId: 'task-123',
      sequenceIndex: i,
      instructions: s.instructions,
      status: 'pending' as const,
      executionMode: s.executionMode,
      trigger: s.trigger,
      filePaths: s.filePaths,
      memoryReferences: s.memoryReferences,
      artifacts: [],
      feedbackHistory: [],
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    currentStepIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  return {
    createTask: createTaskMock,
    dispatchCurrentStep: vi.fn(),
    advanceTask: vi.fn(),
    retryStep: vi.fn(),
    redirectTask: vi.fn(),
    cancelTask: vi.fn(),
    interruptStep: vi.fn(),
    handleExternalEvent: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn().mockReturnValue([]),
    queryArtifacts: vi.fn().mockResolvedValue([]),
    onTaskEvent: vi.fn(),
    createTaskMock,
  };
}

function createMockAuditLog(): IAuditLog & { recordMock: ReturnType<typeof vi.fn> } {
  const recordMock = vi.fn<(entry: AuditEntry) => Promise<void>>().mockResolvedValue(undefined);
  return {
    record: recordMock,
    query: vi.fn().mockResolvedValue([]) as unknown as (query: AuditQuery) => Promise<AuditEntry[]>,
    stream: vi.fn() as unknown as (filter: AuditFilter) => AsyncIterable<AuditEntry>,
    getSequenceNumber: vi.fn().mockReturnValue(0),
    recordMock,
  };
}

function createOrchestrationLlmConfig(overrides?: Partial<OrchestrationLlmConfig>): OrchestrationLlmConfig {
  return {
    provider: 'openai-compatible',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4',
    apiKeyRef: 'openai-key',
    ...overrides,
  };
}

function createStructuredIntent(overrides?: Partial<StructuredIntent>): StructuredIntent {
  return {
    id: 'intent-1',
    sourceType: 'operator',
    sourceId: 'operator-1',
    repository: 'owner/repo',
    branch: 'feature-branch',
    action: 'Fix the failing tests in the auth module',
    confidence: 0.9,
    rawInput: 'Fix the failing tests in the auth module',
    parsedAt: new Date(),
    ...overrides,
  };
}

function createWorkspaceContext(overrides?: Partial<WorkspaceContext>): WorkspaceContext {
  return {
    id: 'ws-1',
    repositoryUrl: 'https://github.com/owner/repo.git',
    localPath: '/workspaces/repo',
    branch: 'feature-branch',
    defaultBranch: 'main',
    environment: { NODE_ENV: 'development' },
    lastUsedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function createCapabilityRequirements(overrides?: Partial<CapabilityRequirements>): CapabilityRequirements {
  return {
    languages: ['typescript'],
    frameworks: ['vitest'],
    tools: ['npm', 'git'],
    ...overrides,
  };
}

function createPlanningContext(overrides?: Partial<PlanningContext>): PlanningContext {
  return {
    intent: createStructuredIntent(),
    workspace: createWorkspaceContext(),
    agentCapabilities: createCapabilityRequirements(),
    ...overrides,
  };
}

/** Build a mock LLM response with the given plan JSON */
function buildLlmResponse(planJson: object): OperationResult {
  return {
    success: true,
    data: {
      choices: [
        {
          message: {
            content: JSON.stringify(planJson),
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TaskPlanner', () => {
  let mcpGateway: ReturnType<typeof createMockMCPGateway>;
  let taskOrchestrator: ReturnType<typeof createMockTaskOrchestrator>;
  let auditLog: ReturnType<typeof createMockAuditLog>;
  let planner: TaskPlanner;

  beforeEach(() => {
    mcpGateway = createMockMCPGateway();
    taskOrchestrator = createMockTaskOrchestrator();
    auditLog = createMockAuditLog();
    planner = new TaskPlanner({
      mcpGateway,
      taskOrchestrator,
      auditLog,
      orchestrationLlmConfig: createOrchestrationLlmConfig(),
    });
  });

  // ----------------------------------------------------------------
  // generatePlan — successful plan generation (Req 4.1)
  // ----------------------------------------------------------------

  describe('generatePlan — successful plan generation', () => {
    it('should generate a plan with steps from LLM response', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            { instructions: 'Run the test suite', executionMode: 'agent' },
            { instructions: 'Fix failing tests', executionMode: 'agent' },
            { instructions: 'Run tests again to verify', executionMode: 'agent' },
          ],
          reasoning: 'First identify failures, then fix, then verify.',
          estimatedDuration: '30 minutes',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[0].instructions).toBe('Run the test suite');
      expect(plan.steps[0].executionMode).toBe('agent');
      expect(plan.steps[1].instructions).toBe('Fix failing tests');
      expect(plan.steps[2].instructions).toBe('Run tests again to verify');
      expect(plan.reasoning).toBe('First identify failures, then fix, then verify.');
      expect(plan.estimatedDuration).toBe('30 minutes');
    });

    it('should route inference through MCP Gateway with correct parameters', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Do something', executionMode: 'agent' }],
          reasoning: 'Simple task.',
        }),
      );

      await planner.generatePlan(createPlanningContext());

      expect(mcpGateway.executeOperationMock).toHaveBeenCalledTimes(1);
      const [agentId, serviceId, operation, params] = mcpGateway.executeOperationMock.mock.calls[0];
      expect(agentId).toBe('__c2_orchestration');
      expect(serviceId).toBe('__orchestration_llm');
      expect(operation).toBe('chat.completions');
      expect(params).toMatchObject({
        model: 'gpt-4',
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });
    });

    it('should include external-event steps with triggers (Req 4.2)', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            { instructions: 'Push branch', executionMode: 'agent' },
            {
              instructions: 'Wait for CI to pass',
              executionMode: 'external-event',
              trigger: {
                type: 'event-driven',
                eventSourceId: 'github-ci',
                eventType: 'ci_completed',
                timeoutMs: 120000,
              },
            },
            { instructions: 'Merge PR', executionMode: 'agent' },
          ],
          reasoning: 'Push, wait for CI, then merge.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[1].executionMode).toBe('external-event');
      expect(plan.steps[1].trigger).toEqual({
        type: 'event-driven',
        eventSourceId: 'github-ci',
        eventType: 'ci_completed',
        timeoutMs: 120000,
      });
    });

    it('should include file paths and memory references in steps', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            {
              instructions: 'Review the auth module',
              executionMode: 'agent',
              filePaths: ['src/auth/index.ts', 'src/auth/login.ts'],
              memoryReferences: [{ namespace: 'project', key: 'auth-config' }],
            },
          ],
          reasoning: 'Focus on auth module files.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps[0].filePaths).toEqual(['src/auth/index.ts', 'src/auth/login.ts']);
      expect(plan.steps[0].memoryReferences).toEqual([{ namespace: 'project', key: 'auth-config' }]);
    });

    it('should record plan generation in audit log', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Do work', executionMode: 'agent' }],
          reasoning: 'Simple plan.',
        }),
      );

      await planner.generatePlan(createPlanningContext());

      expect(auditLog.recordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'coding_task',
          operation: 'plan_generated',
          details: expect.objectContaining({
            intentId: 'intent-1',
            stepCount: 1,
            reasoning: 'Simple plan.',
          }),
        }),
      );
    });

    it('should use custom system prompt when configured', async () => {
      const customPlanner = new TaskPlanner({
        mcpGateway,
        taskOrchestrator,
        auditLog,
        orchestrationLlmConfig: createOrchestrationLlmConfig({
          systemPrompt: 'You are a senior project manager.',
        }),
      });

      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Do work', executionMode: 'agent' }],
          reasoning: 'Plan.',
        }),
      );

      await customPlanner.generatePlan(createPlanningContext());

      const params = mcpGateway.executeOperationMock.mock.calls[0][3] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(params.messages[0].content).toBe('You are a senior project manager.');
    });
  });

  // ----------------------------------------------------------------
  // generatePlan — auto-advance flag propagation (Req 4.5)
  // ----------------------------------------------------------------

  describe('generatePlan — operator preferences', () => {
    it('should include review mode in planning prompt', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Auto step', executionMode: 'agent' }],
          reasoning: 'Auto-advance plan.',
        }),
      );

      const context = createPlanningContext({
        operatorPreferences: { reviewMode: 'auto-advance' },
      });

      await planner.generatePlan(context);

      const params = mcpGateway.executeOperationMock.mock.calls[0][3] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userPrompt = params.messages[1].content;
      expect(userPrompt).toContain('auto-advance');
    });

    it('should respect maxSteps preference by truncating steps', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            { instructions: 'Step 1', executionMode: 'agent' },
            { instructions: 'Step 2', executionMode: 'agent' },
            { instructions: 'Step 3', executionMode: 'agent' },
            { instructions: 'Step 4', executionMode: 'agent' },
            { instructions: 'Step 5', executionMode: 'agent' },
          ],
          reasoning: 'Many steps.',
        }),
      );

      const context = createPlanningContext({
        operatorPreferences: { reviewMode: 'manual', maxSteps: 3 },
      });

      const plan = await planner.generatePlan(context);

      expect(plan.steps).toHaveLength(3);
      expect(plan.steps[0].instructions).toBe('Step 1');
      expect(plan.steps[2].instructions).toBe('Step 3');
    });

    it('should include maxSteps in planning prompt when specified', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Step 1', executionMode: 'agent' }],
          reasoning: 'Limited plan.',
        }),
      );

      const context = createPlanningContext({
        operatorPreferences: { reviewMode: 'manual', maxSteps: 5 },
      });

      await planner.generatePlan(context);

      const params = mcpGateway.executeOperationMock.mock.calls[0][3] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userPrompt = params.messages[1].content;
      expect(userPrompt).toContain('5');
    });
  });

  // ----------------------------------------------------------------
  // generatePlan — empty plan handling
  // ----------------------------------------------------------------

  describe('generatePlan — empty plan handling', () => {
    it('should return empty steps when LLM returns no steps', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [],
          reasoning: 'No actionable steps identified.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(0);
      expect(plan.reasoning).toBe('No actionable steps identified.');
    });

    it('should filter out steps with empty instructions', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            { instructions: '', executionMode: 'agent' },
            { instructions: '   ', executionMode: 'agent' },
            { instructions: 'Valid step', executionMode: 'agent' },
          ],
          reasoning: 'Some steps were empty.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].instructions).toBe('Valid step');
    });

    it('should return empty plan with error reasoning when LLM response has no data', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue({
        success: true,
        data: {
          choices: [{ message: { content: '' } }],
        },
      });

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(0);
      expect(plan.reasoning).toContain('empty LLM response');
    });
  });

  // ----------------------------------------------------------------
  // generatePlan — LLM timeout and invalid responses
  // ----------------------------------------------------------------

  describe('generatePlan — LLM timeout and invalid responses', () => {
    it('should return empty plan when LLM call fails (service unavailable)', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: 'LLM service is down' },
      });

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(0);
      expect(plan.reasoning).toContain('LLM service unavailable');
    });

    it('should return empty plan when LLM returns invalid JSON', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue({
        success: true,
        data: {
          choices: [{ message: { content: 'This is not valid JSON {{{' } }],
        },
      });

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(0);
      expect(plan.reasoning).toContain('malformed LLM response');
    });

    it('should return empty plan when LLM times out (rejected promise)', async () => {
      mcpGateway.executeOperationMock.mockRejectedValue(new Error('Request timeout'));

      await expect(planner.generatePlan(createPlanningContext())).rejects.toThrow('Request timeout');
    });

    it('should handle LLM response with missing steps field gracefully', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue({
        success: true,
        data: {
          choices: [{ message: { content: JSON.stringify({ reasoning: 'No steps field' }) } }],
        },
      });

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(0);
      expect(plan.reasoning).toBe('No steps field');
    });

    it('should handle LLM response with content as direct string', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue({
        success: true,
        data: {
          content: JSON.stringify({
            steps: [{ instructions: 'Direct content step', executionMode: 'agent' }],
            reasoning: 'Direct content format.',
          }),
        },
      });

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].instructions).toBe('Direct content step');
    });

    it('should handle LLM response as raw string data', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue({
        success: true,
        data: JSON.stringify({
          steps: [{ instructions: 'Raw string step', executionMode: 'agent' }],
          reasoning: 'Raw string format.',
        }),
      });

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].instructions).toBe('Raw string step');
    });
  });

  // ----------------------------------------------------------------
  // generatePlan — intent context in prompt (Req 4.3)
  // ----------------------------------------------------------------

  describe('generatePlan — intent context in prompt', () => {
    it('should include issue reference in prompt when present', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Fix issue', executionMode: 'agent' }],
          reasoning: 'Issue-driven plan.',
        }),
      );

      const context = createPlanningContext({
        intent: createStructuredIntent({ issueRef: '#42' }),
      });

      await planner.generatePlan(context);

      const params = mcpGateway.executeOperationMock.mock.calls[0][3] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userPrompt = params.messages[1].content;
      expect(userPrompt).toContain('#42');
    });

    it('should include PR reference in prompt when present', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Address PR feedback', executionMode: 'agent' }],
          reasoning: 'PR-driven plan.',
        }),
      );

      const context = createPlanningContext({
        intent: createStructuredIntent({ prRef: '#15' }),
      });

      await planner.generatePlan(context);

      const params = mcpGateway.executeOperationMock.mock.calls[0][3] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userPrompt = params.messages[1].content;
      expect(userPrompt).toContain('#15');
    });

    it('should include constraints in prompt when present', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [{ instructions: 'Constrained work', executionMode: 'agent' }],
          reasoning: 'Constrained plan.',
        }),
      );

      const context = createPlanningContext({
        intent: createStructuredIntent({ constraints: { noForceP: true, maxFiles: 5 } }),
      });

      await planner.generatePlan(context);

      const params = mcpGateway.executeOperationMock.mock.calls[0][3] as {
        messages: Array<{ role: string; content: string }>;
      };
      const userPrompt = params.messages[1].content;
      expect(userPrompt).toContain('noForceP');
      expect(userPrompt).toContain('maxFiles');
    });
  });

  // ----------------------------------------------------------------
  // submitPlan — plan submission to Task_Orchestrator (Req 4.4)
  // ----------------------------------------------------------------

  describe('submitPlan — plan submission to Task_Orchestrator', () => {
    it('should submit plan to Task_Orchestrator and return task ID', async () => {
      const plan: GeneratedPlan = {
        steps: [
          { instructions: 'Step 1', executionMode: 'agent' },
          { instructions: 'Step 2', executionMode: 'agent' },
        ],
        reasoning: 'Two-step plan.',
      };

      const taskId = await planner.submitPlan(plan, 'agent-alpha', 'operator-1');

      expect(taskId).toBe('task-123');
      expect(taskOrchestrator.createTaskMock).toHaveBeenCalledTimes(1);
      expect(taskOrchestrator.createTaskMock).toHaveBeenCalledWith({
        operatorId: 'operator-1',
        steps: plan.steps,
        agentId: 'agent-alpha',
      });
    });

    it('should pass the correct agent ID to Task_Orchestrator', async () => {
      const plan: GeneratedPlan = {
        steps: [{ instructions: 'Work', executionMode: 'agent' }],
        reasoning: 'Simple.',
      };

      await planner.submitPlan(plan, 'agent-beta', 'operator-2');

      const submission = taskOrchestrator.createTaskMock.mock.calls[0][0] as CodingTaskSubmission;
      expect(submission.agentId).toBe('agent-beta');
      expect(submission.operatorId).toBe('operator-2');
    });

    it('should record plan submission in audit log', async () => {
      const plan: GeneratedPlan = {
        steps: [
          { instructions: 'Step 1', executionMode: 'agent' },
          { instructions: 'Step 2', executionMode: 'agent' },
        ],
        reasoning: 'Two steps.',
      };

      await planner.submitPlan(plan, 'agent-alpha', 'operator-1');

      expect(auditLog.recordMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'coding_task',
          operation: 'plan_submitted',
          resource: 'task:task-123',
          details: expect.objectContaining({
            codingTaskId: 'task-123',
            agentId: 'agent-alpha',
            stepCount: 2,
            reasoning: 'Two steps.',
          }),
        }),
      );
    });

    it('should throw when submitting an empty plan', async () => {
      const emptyPlan: GeneratedPlan = {
        steps: [],
        reasoning: 'No steps.',
      };

      await expect(
        planner.submitPlan(emptyPlan, 'agent-alpha', 'operator-1'),
      ).rejects.toThrow('Cannot submit an empty plan: no steps defined');

      expect(taskOrchestrator.createTaskMock).not.toHaveBeenCalled();
    });

    it('should propagate Task_Orchestrator errors', async () => {
      taskOrchestrator.createTaskMock.mockRejectedValue(new Error('Orchestrator failure'));

      const plan: GeneratedPlan = {
        steps: [{ instructions: 'Work', executionMode: 'agent' }],
        reasoning: 'Plan.',
      };

      await expect(
        planner.submitPlan(plan, 'agent-alpha', 'operator-1'),
      ).rejects.toThrow('Orchestrator failure');
    });
  });

  // ----------------------------------------------------------------
  // Step normalization
  // ----------------------------------------------------------------

  describe('step normalization', () => {
    it('should default execution mode to agent for unknown values', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            { instructions: 'Unknown mode step', executionMode: 'unknown-mode' },
          ],
          reasoning: 'Fallback to agent mode.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps[0].executionMode).toBe('agent');
    });

    it('should add default timeout for external-event triggers without one', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            {
              instructions: 'Wait for event',
              executionMode: 'external-event',
              trigger: {
                type: 'event-driven',
                eventSourceId: 'ci',
                eventType: 'done',
              },
            },
          ],
          reasoning: 'Event step without timeout.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps[0].trigger).toBeDefined();
      expect(plan.steps[0].trigger!.timeoutMs).toBe(300000); // 5 min default
    });

    it('should filter out invalid file paths (empty strings)', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            {
              instructions: 'Work on files',
              executionMode: 'agent',
              filePaths: ['valid/path.ts', '', '  ', 'another/valid.ts'],
            },
          ],
          reasoning: 'File-focused step.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps[0].filePaths).toEqual(['valid/path.ts', 'another/valid.ts']);
    });

    it('should trim whitespace from step instructions', async () => {
      mcpGateway.executeOperationMock.mockResolvedValue(
        buildLlmResponse({
          steps: [
            { instructions: '  Trimmed instructions  ', executionMode: 'agent' },
          ],
          reasoning: 'Whitespace test.',
        }),
      );

      const plan = await planner.generatePlan(createPlanningContext());

      expect(plan.steps[0].instructions).toBe('Trimmed instructions');
    });
  });
});
