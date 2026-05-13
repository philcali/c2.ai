import type { PlanningContext, GeneratedPlan } from './orchestration-config.js';

/**
 * ITaskPlanner — Decomposes a resolved intent into concrete task steps
 * using the orchestration LLM, then submits the plan to the Task_Orchestrator.
 *
 * The Task_Planner routes all inference calls through the MCP Gateway,
 * ensuring audit logging and policy enforcement apply to the C2's own
 * LLM traffic.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 10.2, 10.3
 */
export interface ITaskPlanner {
  /**
   * Generate a task plan from a planning context.
   *
   * Uses the orchestration LLM via MCP Gateway to decompose the intent
   * into a sequence of TaskStepDefinition objects representing the work
   * to be done.
   *
   * @param context - The planning context including intent, workspace, and agent capabilities
   * @returns A generated plan with steps, reasoning, and optional estimated duration
   */
  generatePlan(context: PlanningContext): Promise<GeneratedPlan>;

  /**
   * Submit a generated plan to the Task_Orchestrator.
   *
   * Creates a new CodingTask via the Task_Orchestrator's createTask interface,
   * assigning it to the specified agent.
   *
   * @param plan - The generated plan to submit
   * @param agentId - The agent to assign the task to
   * @param operatorId - The operator who initiated the orchestration
   * @returns The ID of the created CodingTask
   */
  submitPlan(
    plan: GeneratedPlan,
    agentId: string,
    operatorId: string,
  ): Promise<string>;
}
