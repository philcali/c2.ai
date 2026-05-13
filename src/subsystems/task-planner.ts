import type { ITaskPlanner } from '../interfaces/task-planner.js';
import type { IMCPGateway, OperationResult } from '../interfaces/mcp-gateway.js';
import type { ITaskOrchestrator, TaskStepDefinition } from '../interfaces/task-orchestrator.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type {
  OrchestrationLlmConfig,
  PlanningContext,
  GeneratedPlan,
} from '../interfaces/orchestration-config.js';

/**
 * The service ID used when routing orchestration LLM calls through the MCP Gateway.
 */
const ORCHESTRATION_LLM_SERVICE_ID = '__orchestration_llm';

/**
 * The agent ID used for the C2's own orchestration inference calls.
 * Distinguished from coding agent IDs to maintain audit clarity.
 */
const ORCHESTRATION_AGENT_ID = '__c2_orchestration';

/**
 * TaskPlanner — Decomposes resolved intents into concrete task step sequences
 * using the orchestration LLM, then submits plans to the Task_Orchestrator.
 *
 * All inference calls are routed through the MCP Gateway to ensure audit
 * logging and policy enforcement apply uniformly to the C2's own LLM traffic.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 10.2, 10.3
 */
export class TaskPlanner implements ITaskPlanner {
  private readonly mcpGateway: IMCPGateway;
  private readonly taskOrchestrator: ITaskOrchestrator;
  private readonly auditLog: IAuditLog;
  private readonly orchestrationLlmConfig: OrchestrationLlmConfig;

  constructor(options: {
    mcpGateway: IMCPGateway;
    taskOrchestrator: ITaskOrchestrator;
    auditLog: IAuditLog;
    orchestrationLlmConfig: OrchestrationLlmConfig;
  }) {
    this.mcpGateway = options.mcpGateway;
    this.taskOrchestrator = options.taskOrchestrator;
    this.auditLog = options.auditLog;
    this.orchestrationLlmConfig = options.orchestrationLlmConfig;
  }

  // ------------------------------------------------------------------
  // ITaskPlanner — Plan generation
  // ------------------------------------------------------------------

  /**
   * Generate a task plan from a planning context.
   *
   * Uses the orchestration LLM via MCP Gateway to decompose the intent
   * into a sequence of TaskStepDefinition objects. The LLM is prompted
   * with the intent details, workspace context, and agent capabilities
   * to produce an appropriate plan.
   *
   * Requirements: 4.1, 4.2, 4.3, 10.2, 10.3
   */
  async generatePlan(context: PlanningContext): Promise<GeneratedPlan> {
    const now = new Date();

    // Build the prompt for task planning
    const prompt = this.buildPlanningPrompt(context);

    // Route inference through MCP Gateway
    const result = await this.mcpGateway.executeOperation(
      ORCHESTRATION_AGENT_ID,
      ORCHESTRATION_LLM_SERVICE_ID,
      'chat.completions',
      {
        model: this.orchestrationLlmConfig.model,
        messages: [
          {
            role: 'system',
            content: this.orchestrationLlmConfig.systemPrompt ?? this.getDefaultSystemPrompt(),
          },
          { role: 'user', content: prompt },
        ],
        temperature: this.orchestrationLlmConfig.temperature ?? 0.3,
        max_tokens: this.orchestrationLlmConfig.maxTokens ?? 2048,
        response_format: { type: 'json_object' },
      },
    );

    // Parse the LLM response into a GeneratedPlan
    const plan = this.parsePlanFromResponse(result, context);

    // Record the plan generation in the audit log
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId: context.intent.sourceId,
      eventType: 'coding_task',
      operation: 'plan_generated',
      resource: `intent:${context.intent.id}`,
      details: {
        intentId: context.intent.id,
        action: context.intent.action,
        repository: context.intent.repository,
        stepCount: plan.steps.length,
        reasoning: plan.reasoning,
        estimatedDuration: plan.estimatedDuration,
        reviewMode: context.operatorPreferences?.reviewMode ?? 'manual',
      },
    });

    return plan;
  }

  // ------------------------------------------------------------------
  // ITaskPlanner — Plan submission
  // ------------------------------------------------------------------

  /**
   * Submit a generated plan to the Task_Orchestrator.
   *
   * Creates a new CodingTask via the Task_Orchestrator's createTask interface.
   * If the plan has no steps, an error is thrown since an empty plan cannot
   * be meaningfully executed.
   *
   * Requirements: 4.4, 4.5
   */
  async submitPlan(
    plan: GeneratedPlan,
    agentId: string,
    operatorId: string,
  ): Promise<string> {
    if (plan.steps.length === 0) {
      throw new Error('Cannot submit an empty plan: no steps defined');
    }

    const now = new Date();

    // Submit the plan to the Task_Orchestrator
    const codingTask = await this.taskOrchestrator.createTask({
      operatorId,
      steps: plan.steps,
      agentId,
    });

    // Record the plan submission in the audit log
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      agentId,
      eventType: 'coding_task',
      operation: 'plan_submitted',
      resource: `task:${codingTask.id}`,
      details: {
        codingTaskId: codingTask.id,
        agentId,
        stepCount: plan.steps.length,
        reasoning: plan.reasoning,
      },
    });

    return codingTask.id;
  }

  // ------------------------------------------------------------------
  // Private — Prompt construction
  // ------------------------------------------------------------------

  /**
   * Build the default system prompt for task planning.
   */
  private getDefaultSystemPrompt(): string {
    return `You are a task planning intelligence for a C2 AI Command Center. Your role is to decompose high-level intents into concrete, actionable task steps that a coding agent can execute sequentially. Each step should have clear instructions. Include external-event steps (e.g., wait for CI) when the work involves asynchronous operations. Always respond with valid JSON.`;
  }

  /**
   * Build the user prompt for task plan generation.
   */
  private buildPlanningPrompt(context: PlanningContext): string {
    const { intent, workspace, agentCapabilities, operatorPreferences } = context;

    let prompt = `Decompose the following intent into a sequence of concrete task steps for a coding agent.

## Intent
- Action: ${intent.action}
- Repository: ${intent.repository ?? 'not specified'}
- Branch: ${intent.branch ?? 'not specified'}
`;

    if (intent.issueRef) {
      prompt += `- Issue Reference: ${intent.issueRef}\n`;
    }
    if (intent.prRef) {
      prompt += `- PR Reference: ${intent.prRef}\n`;
    }
    if (intent.constraints) {
      prompt += `- Constraints: ${JSON.stringify(intent.constraints)}\n`;
    }

    prompt += `
## Workspace
- Repository URL: ${workspace.repositoryUrl}
- Local Path: ${workspace.localPath}
- Branch: ${workspace.branch}
- Default Branch: ${workspace.defaultBranch}

## Agent Capabilities
- Languages: ${agentCapabilities.languages?.join(', ') ?? 'any'}
- Frameworks: ${agentCapabilities.frameworks?.join(', ') ?? 'any'}
- Tools: ${agentCapabilities.tools?.join(', ') ?? 'any'}
`;

    if (operatorPreferences) {
      prompt += `
## Operator Preferences
- Review Mode: ${operatorPreferences.reviewMode}
`;
      if (operatorPreferences.maxSteps) {
        prompt += `- Maximum Steps: ${operatorPreferences.maxSteps}\n`;
      }
    }

    prompt += `
## Instructions
Respond with a JSON object containing:
- "steps": array of step objects, each with:
  - "instructions": string (clear instructions for the coding agent)
  - "executionMode": "agent" or "external-event" (use "external-event" for CI waits, deployments, etc.)
  - "trigger": object or null (for external-event steps: { "type": "event-driven", "eventSourceId": string, "eventType": string, "timeoutMs": number })
  - "filePaths": array of strings or null (relevant file paths for context)
  - "memoryReferences": array of { "namespace": string, "key": string } or null
- "reasoning": string (explain your plan decomposition rationale)
- "estimatedDuration": string or null (e.g., "15 minutes", "1 hour")

Guidelines:
- Each step should be independently actionable
- Include external-event steps when the work involves CI, deployments, or other async operations
- Order steps logically (setup → implementation → testing → cleanup)
- Keep instructions specific and unambiguous
- Reference the issue or PR content in step instructions when available`;

    return prompt;
  }

  // ------------------------------------------------------------------
  // Private — Response parsing
  // ------------------------------------------------------------------

  /**
   * Parse the MCP Gateway response into a GeneratedPlan.
   *
   * Handles both successful LLM responses and error cases gracefully.
   * If the LLM response is malformed, returns an empty plan with an
   * error explanation in the reasoning field.
   */
  private parsePlanFromResponse(
    result: OperationResult,
    context: PlanningContext,
  ): GeneratedPlan {
    const emptyPlan: GeneratedPlan = {
      steps: [],
      reasoning: '',
    };

    if (!result.success || !result.data) {
      return {
        ...emptyPlan,
        reasoning: 'Unable to generate plan: LLM service unavailable',
      };
    }

    try {
      // Extract the JSON content from the LLM response
      const responseData = result.data as {
        choices?: Array<{ message?: { content?: string } }>;
        content?: string;
      };

      let content: string | undefined;
      if (responseData.choices && responseData.choices[0]?.message?.content) {
        content = responseData.choices[0].message.content;
      } else if (typeof responseData.content === 'string') {
        content = responseData.content;
      } else if (typeof result.data === 'string') {
        content = result.data as string;
      }

      if (!content) {
        return {
          ...emptyPlan,
          reasoning: 'Unable to generate plan: empty LLM response',
        };
      }

      const parsed = JSON.parse(content) as {
        steps?: Array<{
          instructions?: string;
          executionMode?: string;
          trigger?: {
            type?: string;
            eventSourceId?: string;
            eventType?: string;
            pollingIntervalMs?: number;
            timeoutMs?: number;
          };
          filePaths?: string[];
          memoryReferences?: Array<{ namespace: string; key: string }>;
        }>;
        reasoning?: string;
        estimatedDuration?: string;
      };

      // Validate and normalize steps
      const steps: TaskStepDefinition[] = this.normalizeSteps(
        parsed.steps ?? [],
        context,
      );

      return {
        steps,
        reasoning: parsed.reasoning ?? 'Plan generated successfully',
        estimatedDuration: parsed.estimatedDuration ?? undefined,
      };
    } catch {
      return {
        ...emptyPlan,
        reasoning: 'Unable to generate plan: malformed LLM response',
      };
    }
  }

  /**
   * Normalize and validate raw step data from the LLM response into
   * proper TaskStepDefinition objects.
   *
   * Filters out steps with empty instructions and ensures execution mode
   * and trigger fields are valid. Respects the operator's maxSteps preference.
   *
   * Requirements: 4.2, 4.5
   */
  private normalizeSteps(
    rawSteps: Array<{
      instructions?: string;
      executionMode?: string;
      trigger?: {
        type?: string;
        eventSourceId?: string;
        eventType?: string;
        pollingIntervalMs?: number;
        timeoutMs?: number;
      };
      filePaths?: string[];
      memoryReferences?: Array<{ namespace: string; key: string }>;
    }>,
    context: PlanningContext,
  ): TaskStepDefinition[] {
    const maxSteps = context.operatorPreferences?.maxSteps;

    const steps: TaskStepDefinition[] = [];

    for (const raw of rawSteps) {
      // Skip steps with empty or missing instructions
      if (!raw.instructions || raw.instructions.trim() === '') {
        continue;
      }

      // Enforce maxSteps limit
      if (maxSteps !== undefined && steps.length >= maxSteps) {
        break;
      }

      const executionMode = raw.executionMode === 'external-event' ? 'external-event' : 'agent';

      const step: TaskStepDefinition = {
        instructions: raw.instructions.trim(),
        executionMode,
      };

      // Add trigger for external-event steps
      if (executionMode === 'external-event' && raw.trigger) {
        step.trigger = {
          type: raw.trigger.type === 'time-based' ? 'time-based' : 'event-driven',
          eventSourceId: raw.trigger.eventSourceId,
          eventType: raw.trigger.eventType,
          pollingIntervalMs: raw.trigger.pollingIntervalMs,
          timeoutMs: raw.trigger.timeoutMs ?? 300000, // Default 5 min timeout
        };
      }

      // Add file paths if provided
      if (raw.filePaths && Array.isArray(raw.filePaths) && raw.filePaths.length > 0) {
        step.filePaths = raw.filePaths.filter(
          (p): p is string => typeof p === 'string' && p.trim() !== '',
        );
      }

      // Add memory references if provided
      if (raw.memoryReferences && Array.isArray(raw.memoryReferences) && raw.memoryReferences.length > 0) {
        step.memoryReferences = raw.memoryReferences.filter(
          (ref) => typeof ref.namespace === 'string' && typeof ref.key === 'string',
        );
      }

      steps.push(step);
    }

    return steps;
  }
}
