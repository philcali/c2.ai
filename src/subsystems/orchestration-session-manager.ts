import { v4 as uuidv4 } from 'uuid';

import type { IOrchestrationSessionManager } from '../interfaces/orchestration-session.js';
import type { IIntentResolver } from '../interfaces/intent-resolver.js';
import type { IWorkspaceResolver } from '../interfaces/workspace-resolver.js';
import type { IAgentSpawner } from '../interfaces/agent-spawner.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { IOperatorInterface } from '../interfaces/operator-interface.js';
import type { ITaskOrchestrator } from '../interfaces/task-orchestrator.js';
import type { IMCPGateway } from '../interfaces/mcp-gateway.js';
import type {
  StructuredIntent,
  OrchestrationSession,
  OrchestrationState,
  OrchestrationEvent,
  WorkspaceContext,
  OrchestrationLlmConfig,
  PlanningContext,
  GeneratedPlan,
  PlanRevisionEntry,
} from '../interfaces/orchestration-config.js';
import type { CapabilityRequirements } from '../interfaces/agent-connector.js';
import type { TaskStepDefinition } from '../interfaces/task-orchestrator.js';

/**
 * Valid state transitions in the orchestration state machine.
 *
 * State machine graph:
 *   intent_received → resolving_workspace
 *   intent_received → pending_approval (guardrail denial for platform events)
 *   pending_approval → resolving_workspace (after operator approval)
 *   resolving_workspace → spawning_agent
 *   spawning_agent → planning_task
 *   planning_task → awaiting_plan_approval (manual review mode, default)
 *   planning_task → executing (auto-advance mode)
 *   awaiting_plan_approval → executing (operator approves plan)
 *   awaiting_plan_approval → planning_task (operator requests modification)
 *   awaiting_plan_approval → failed (operator rejects, cancels, or timeout)
 *   executing → completed
 *   Any non-terminal → failed
 */
const VALID_TRANSITIONS: Record<OrchestrationState, OrchestrationState[]> = {
  intent_received: ['resolving_workspace', 'pending_approval', 'failed'],
  pending_approval: ['resolving_workspace', 'failed'],
  resolving_workspace: ['spawning_agent', 'failed'],
  spawning_agent: ['planning_task', 'failed'],
  planning_task: ['awaiting_plan_approval', 'executing', 'failed'],
  awaiting_plan_approval: ['executing', 'planning_task', 'failed'],
  executing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

/** Terminal states that cannot be advanced or cancelled. */
const TERMINAL_STATES: OrchestrationState[] = ['completed', 'failed'];

/**
 * The agent ID used for the C2's own task planning inference calls.
 */
const ORCHESTRATION_AGENT_ID = '__c2_orchestration';

/**
 * The service ID used when routing orchestration LLM calls through the MCP Gateway.
 */
const ORCHESTRATION_LLM_SERVICE_ID = '__orchestration_llm';

/**
 * Minimal interface for the Task_Planner dependency.
 *
 * The full ITaskPlanner interface is defined in task 9. This keeps
 * OrchestrationSessionManager decoupled until that subsystem is built.
 */
export interface ITaskPlannerMinimal {
  generatePlan(context: PlanningContext): Promise<GeneratedPlan>;
  submitPlan(
    plan: GeneratedPlan,
    agentId: string,
    operatorId: string,
  ): Promise<string>;
  regeneratePlan(
    context: PlanningContext,
    previousPlan: GeneratedPlan,
    modificationInstructions: string,
  ): Promise<GeneratedPlan>;
}


/**
 * OrchestrationSessionManager — Tracks the full lifecycle of intents
 * from receipt through workspace resolution, agent spawning, task planning,
 * execution, and completion.
 *
 * Both operator-initiated intents and platform events flow through the same
 * Orchestration_Session lifecycle, providing uniform traceability and control.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.3, 7.4, 7.5
 */
export class OrchestrationSessionManager implements IOrchestrationSessionManager {
  private readonly intentResolver: IIntentResolver;
  private readonly workspaceResolver: IWorkspaceResolver;
  private readonly agentSpawner: IAgentSpawner;
  private readonly taskPlanner: ITaskPlannerMinimal;
  private readonly policyEngine: IPolicyEngine;
  private readonly auditLog: IAuditLog;
  private readonly operatorInterface: IOperatorInterface;

  /** In-memory session store keyed by session ID. */
  private readonly sessions: Map<string, OrchestrationSession> = new Map();

  /** Event history keyed by session ID. */
  private readonly history: Map<string, OrchestrationEvent[]> = new Map();

  /** Registered event handlers for session lifecycle events. */
  private readonly eventHandlers: Array<(event: OrchestrationEvent) => void> = [];

  constructor(options: {
    intentResolver: IIntentResolver;
    workspaceResolver: IWorkspaceResolver;
    agentSpawner: IAgentSpawner;
    taskPlanner: ITaskPlannerMinimal;
    policyEngine: IPolicyEngine;
    auditLog: IAuditLog;
    operatorInterface: IOperatorInterface;
  }) {
    this.intentResolver = options.intentResolver;
    this.workspaceResolver = options.workspaceResolver;
    this.agentSpawner = options.agentSpawner;
    this.taskPlanner = options.taskPlanner;
    this.policyEngine = options.policyEngine;
    this.auditLog = options.auditLog;
    this.operatorInterface = options.operatorInterface;
  }

  // ------------------------------------------------------------------
  // IOrchestrationSessionManager — createSession
  // ------------------------------------------------------------------

  /**
   * Create a new orchestration session from a structured intent.
   *
   * For platform event intents, evaluates guardrail policies. If the
   * policy denies the session, it transitions to 'pending_approval'.
   *
   * Requirements: 6.1, 7.1, 7.3
   */
  async createSession(
    intent: StructuredIntent,
    operatorId: string,
  ): Promise<OrchestrationSession> {
    const now = new Date();
    const sessionId = uuidv4();

    const session: OrchestrationSession = {
      id: sessionId,
      state: 'intent_received',
      intent,
      operatorId,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(sessionId, session);
    this.history.set(sessionId, []);

    // Record session creation in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      eventType: 'session_lifecycle',
      operation: 'orchestration_session_created',
      resource: `orchestration_session:${sessionId}`,
      details: {
        orchestrationSessionId: sessionId,
        intentId: intent.id,
        sourceType: intent.sourceType,
        action: intent.action,
        repository: intent.repository,
      },
    });

    // For platform event intents, evaluate guardrail policies.
    if (intent.sourceType === 'platform_event') {
      const guardrailDecision = this.policyEngine.evaluate({
        agentId: '*',
        operation: 'autonomous_session',
        resource: intent.repository ?? '*',
        context: {
          sourceType: intent.sourceType,
          action: intent.action,
          orchestrationSessionId: sessionId,
        },
      });

      if (!guardrailDecision.allowed) {
        // Guardrail denied — transition to pending_approval.
        await this.transitionState(sessionId, 'pending_approval', {
          reason: guardrailDecision.reason,
          policyId: guardrailDecision.policyId,
        });

        // Notify operator of pending approval.
        this.operatorInterface.broadcastEvent(`session:${sessionId}`, {
          channel: `session:${sessionId}`,
          type: 'pending_approval',
          data: {
            sessionId,
            reason: guardrailDecision.reason,
            intent: {
              action: intent.action,
              repository: intent.repository,
            },
          },
          timestamp: new Date(),
        });

        return this.sessions.get(sessionId)!;
      }
    }

    return session;
  }

  // ------------------------------------------------------------------
  // IOrchestrationSessionManager — advance
  // ------------------------------------------------------------------

  /**
   * Drive the session through its lifecycle states.
   *
   * Each call advances the session one step through the state machine.
   * If any step fails, the session transitions to 'failed'.
   *
   * Requirements: 6.1, 6.2, 6.3, 6.4
   */
  async advance(sessionId: string): Promise<OrchestrationSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Orchestration session not found: ${sessionId}`);
    }

    if (TERMINAL_STATES.includes(session.state)) {
      throw new Error(
        `Cannot advance session ${sessionId}: already in terminal state '${session.state}'`,
      );
    }

    if (session.state === 'pending_approval') {
      throw new Error(
        `Cannot advance session ${sessionId}: waiting for operator approval`,
      );
    }

    if (session.state === 'awaiting_plan_approval') {
      throw new Error(
        `Cannot advance session ${sessionId}: session is awaiting plan approval. Use approvePlan(), modifyPlan(), or rejectPlan() to proceed.`,
      );
    }

    try {
      switch (session.state) {
        case 'intent_received':
          await this.advanceFromIntentReceived(session);
          break;
        case 'resolving_workspace':
          await this.advanceFromResolvingWorkspace(session);
          break;
        case 'spawning_agent':
          await this.advanceFromSpawningAgent(session);
          break;
        case 'planning_task':
          await this.advanceFromPlanningTask(session);
          break;
        case 'executing':
          await this.advanceFromExecuting(session);
          break;
        default:
          throw new Error(`Unexpected state for advance: ${session.state}`);
      }
    } catch (error) {
      // Transition to failed on any unrecoverable error.
      const reason = error instanceof Error ? error.message : String(error);
      await this.transitionState(sessionId, 'failed', { reason });
      session.failureReason = reason;
    }

    return this.sessions.get(sessionId)!;
  }

  // ------------------------------------------------------------------
  // IOrchestrationSessionManager — approve
  // ------------------------------------------------------------------

  /**
   * Approve a session that is pending approval.
   *
   * Resumes the session from 'pending_approval' to 'resolving_workspace'.
   *
   * Requirements: 7.5
   */
  async approve(
    sessionId: string,
    operatorId: string,
  ): Promise<OrchestrationSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Orchestration session not found: ${sessionId}`);
    }

    if (session.state !== 'pending_approval') {
      throw new Error(
        `Cannot approve session ${sessionId}: not in 'pending_approval' state (current: '${session.state}')`,
      );
    }

    // Record the approval in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      operatorId,
      eventType: 'operator_action',
      operation: 'orchestration_session_approved',
      resource: `orchestration_session:${sessionId}`,
      details: {
        orchestrationSessionId: sessionId,
        approvedBy: operatorId,
      },
    });

    // Transition to resolving_workspace.
    await this.transitionState(sessionId, 'resolving_workspace', {
      approvedBy: operatorId,
    });

    return this.sessions.get(sessionId)!;
  }

  // ------------------------------------------------------------------
  // IOrchestrationSessionManager — cancel
  // ------------------------------------------------------------------

  /**
   * Cancel a session at any non-terminal stage.
   *
   * Transitions the session to 'failed' with the provided reason.
   *
   * Requirements: 6.5
   */
  async cancel(
    sessionId: string,
    reason: string,
    operatorId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Orchestration session not found: ${sessionId}`);
    }

    if (TERMINAL_STATES.includes(session.state)) {
      throw new Error(
        `Cannot cancel session ${sessionId}: already in terminal state '${session.state}'`,
      );
    }

    // Record the cancellation in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      operatorId,
      eventType: 'operator_action',
      operation: 'orchestration_session_cancelled',
      resource: `orchestration_session:${sessionId}`,
      details: {
        orchestrationSessionId: sessionId,
        cancelledBy: operatorId,
        reason,
        previousState: session.state,
      },
    });

    // Transition to failed.
    await this.transitionState(sessionId, 'failed', {
      reason,
      cancelledBy: operatorId,
    });

    session.failureReason = reason;
  }

  // ------------------------------------------------------------------
  // IOrchestrationSessionManager — Plan Lifecycle
  // ------------------------------------------------------------------

  /**
   * Approve the plan for a session in 'awaiting_plan_approval' state.
   *
   * Submits the stored plan to the TaskOrchestrator and transitions
   * the session to 'executing'.
   *
   * Requirements: 2.1, 2.2, 2.5, 7.2, 8.4
   */
  async approvePlan(
    sessionId: string,
    operatorId: string,
  ): Promise<OrchestrationSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Orchestration session not found: ${sessionId}`);
    }

    if (session.state !== 'awaiting_plan_approval') {
      throw new Error(
        `Cannot approve plan for session ${sessionId}: not in 'awaiting_plan_approval' state (current: '${session.state}')`,
      );
    }

    if (!session.currentPlan) {
      throw new Error(
        `Cannot approve plan for session ${sessionId}: no plan stored on session`,
      );
    }

    // Submit the stored plan via taskPlanner.
    const codingTaskId = await this.taskPlanner.submitPlan(
      session.currentPlan,
      session.agentId!,
      operatorId,
    );
    session.codingTaskId = codingTaskId;

    // Transition to executing.
    await this.transitionState(sessionId, 'executing', {
      codingTaskId,
      planId: session.currentPlan.planId,
      approvedBy: operatorId,
    });

    // Emit plan_approved WebSocket event.
    this.operatorInterface.broadcastEvent(`session:${sessionId}`, {
      channel: `session:${sessionId}`,
      type: 'plan_approved',
      data: {
        sessionId,
        operatorId,
        codingTaskId,
        planId: session.currentPlan.planId,
      },
      timestamp: new Date(),
    });

    // Record approval in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      operatorId,
      eventType: 'operator_action',
      operation: 'plan_approved',
      resource: `orchestration_session:${sessionId}`,
      details: {
        orchestrationSessionId: sessionId,
        planId: session.currentPlan.planId,
        approvedBy: operatorId,
        stepCount: session.currentPlan.steps.length,
        revisionNumber: session.planRevisionHistory?.length ?? 1,
      },
    });

    return this.sessions.get(sessionId)!;
  }

  /**
   * Request plan modification for a session in 'awaiting_plan_approval' state.
   *
   * Transitions back to planning_task, regenerates the plan with modification
   * instructions, then returns to awaiting_plan_approval with the revised plan.
   *
   * Requirements: 2.3, 2.5, 2.6, 5.2, 7.3, 8.2, 8.3
   */
  async modifyPlan(
    sessionId: string,
    modificationInstructions: string,
    operatorId: string,
  ): Promise<OrchestrationSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Orchestration session not found: ${sessionId}`);
    }

    if (session.state !== 'awaiting_plan_approval') {
      throw new Error(
        `Cannot modify plan for session ${sessionId}: not in 'awaiting_plan_approval' state (current: '${session.state}')`,
      );
    }

    if (!session.currentPlan) {
      throw new Error(
        `Cannot modify plan for session ${sessionId}: no plan stored on session`,
      );
    }

    const previousPlan = session.currentPlan;
    const previousPlanId = previousPlan.planId;

    // Emit plan_regenerating WebSocket event.
    this.operatorInterface.broadcastEvent(`session:${sessionId}`, {
      channel: `session:${sessionId}`,
      type: 'plan_regenerating',
      data: {
        sessionId,
        operatorId,
        modificationInstructions,
      },
      timestamp: new Date(),
    });

    // Transition to planning_task (intermediate state during regeneration).
    await this.transitionState(sessionId, 'planning_task', {
      reason: 'plan_modification',
      modificationInstructions,
    });

    try {
      // Build planning context for regeneration.
      const requirements = this.deriveCapabilityRequirements(session.intent);
      const planningContext: PlanningContext = {
        intent: session.intent,
        workspace: session.workspaceContext!,
        agentCapabilities: requirements,
      };

      // Regenerate the plan with modification instructions.
      const newPlan = await this.taskPlanner.regeneratePlan(
        planningContext,
        previousPlan,
        modificationInstructions,
      );

      // Store previous plan in revision history with modification instructions.
      if (!session.planRevisionHistory) {
        session.planRevisionHistory = [];
      }
      // Update the last entry to include modification instructions (it was the previous current plan).
      const lastEntry = session.planRevisionHistory[session.planRevisionHistory.length - 1];
      if (lastEntry) {
        lastEntry.modificationInstructions = modificationInstructions;
      }

      // Store new plan as currentPlan with a new planId.
      const newPlanId = uuidv4();
      session.currentPlan = { ...newPlan, planId: newPlanId };

      // Add new plan to revision history.
      session.planRevisionHistory.push({
        planId: newPlanId,
        plan: newPlan,
        generatedAt: new Date(),
      });

      // Transition back to awaiting_plan_approval.
      session.planEnteredAt = new Date();
      await this.transitionState(sessionId, 'awaiting_plan_approval', {
        planId: newPlanId,
        stepCount: newPlan.steps.length,
        revisionNumber: session.planRevisionHistory.length,
      });

      // Emit plan_revised WebSocket event.
      this.operatorInterface.broadcastEvent(`session:${sessionId}`, {
        channel: `session:${sessionId}`,
        type: 'plan_revised',
        data: {
          sessionId,
          operatorId,
          plan: {
            planId: newPlanId,
            steps: newPlan.steps.map((s) => ({
              instructions: s.instructions,
              executionMode: s.executionMode,
            })),
            reasoning: newPlan.reasoning,
            estimatedDuration: newPlan.estimatedDuration,
          },
          revisionNumber: session.planRevisionHistory.length,
          previousPlanId,
        },
        timestamp: new Date(),
      });

      // Record modification in audit log.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        operatorId,
        eventType: 'operator_action',
        operation: 'plan_modified',
        resource: `orchestration_session:${sessionId}`,
        details: {
          orchestrationSessionId: sessionId,
          planId: newPlanId,
          previousPlanId,
          modificationInstructions,
          stepCount: newPlan.steps.length,
          revisionNumber: session.planRevisionHistory.length,
        },
      });
    } catch (error) {
      // Handle regeneratePlan failure by transitioning to failed.
      const reason = error instanceof Error ? error.message : String(error);
      session.failureReason = `Plan regeneration failed: ${reason}`;
      await this.transitionState(sessionId, 'failed', {
        reason: session.failureReason,
        previousPlanId,
      });
    }

    return this.sessions.get(sessionId)!;
  }

  /**
   * Reject the plan for a session in 'awaiting_plan_approval' state.
   *
   * Transitions the session to 'failed' with the rejection reason recorded.
   *
   * Requirements: 2.4, 4.5, 7.4, 8.5
   */
  async rejectPlan(
    sessionId: string,
    reason: string,
    operatorId: string,
  ): Promise<OrchestrationSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Orchestration session not found: ${sessionId}`);
    }

    if (session.state !== 'awaiting_plan_approval') {
      throw new Error(
        `Cannot reject plan for session ${sessionId}: not in 'awaiting_plan_approval' state (current: '${session.state}')`,
      );
    }

    // Set failure reason.
    session.failureReason = reason;

    // Transition to failed.
    await this.transitionState(sessionId, 'failed', {
      reason,
      rejectedBy: operatorId,
      planId: session.currentPlan?.planId,
    });

    // Emit plan_rejected WebSocket event.
    this.operatorInterface.broadcastEvent(`session:${sessionId}`, {
      channel: `session:${sessionId}`,
      type: 'plan_rejected',
      data: {
        sessionId,
        operatorId,
        reason,
        planId: session.currentPlan?.planId,
      },
      timestamp: new Date(),
    });

    // Record rejection in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      operatorId,
      eventType: 'operator_action',
      operation: 'plan_rejected',
      resource: `orchestration_session:${sessionId}`,
      details: {
        orchestrationSessionId: sessionId,
        planId: session.currentPlan?.planId,
        rejectedBy: operatorId,
        rejectionReason: reason,
        revisionNumber: session.planRevisionHistory?.length ?? 1,
      },
    });

    return this.sessions.get(sessionId)!;
  }

  // ------------------------------------------------------------------
  // IOrchestrationSessionManager — Query
  // ------------------------------------------------------------------

  /**
   * Get a session by ID.
   */
  getSession(sessionId: string): OrchestrationSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * List sessions, optionally filtered by state or operator.
   */
  listSessions(filter?: {
    state?: OrchestrationState;
    operatorId?: string;
  }): OrchestrationSession[] {
    let sessions = Array.from(this.sessions.values());

    if (filter?.state) {
      sessions = sessions.filter((s) => s.state === filter.state);
    }

    if (filter?.operatorId) {
      sessions = sessions.filter((s) => s.operatorId === filter.operatorId);
    }

    return sessions;
  }

  /**
   * Get the full resolution chain for a session.
   *
   * Returns an ordered sequence of OrchestrationEvent entries covering
   * every state transition the session underwent.
   *
   * Requirements: 9.1, 9.3
   */
  async getHistory(sessionId: string): Promise<OrchestrationEvent[]> {
    return this.history.get(sessionId) ?? [];
  }

  /**
   * Subscribe to session lifecycle events.
   */
  onSessionEvent(handler: (event: OrchestrationEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  // ------------------------------------------------------------------
  // Private — State advancement logic
  // ------------------------------------------------------------------

  /**
   * Advance from intent_received → resolving_workspace.
   */
  private async advanceFromIntentReceived(session: OrchestrationSession): Promise<void> {
    await this.transitionState(session.id, 'resolving_workspace');
  }

  /**
   * Advance from resolving_workspace → spawning_agent.
   *
   * Resolves the workspace using the Workspace_Resolver.
   */
  private async advanceFromResolvingWorkspace(session: OrchestrationSession): Promise<void> {
    const workspace = await this.workspaceResolver.resolve(session.intent);
    session.workspaceContext = workspace;
    await this.transitionState(session.id, 'spawning_agent', {
      workspaceId: workspace.id,
      repositoryUrl: workspace.repositoryUrl,
      localPath: workspace.localPath,
    });
  }

  /**
   * Advance from spawning_agent → planning_task.
   *
   * Spawns or reuses an agent via the Agent_Spawner.
   */
  private async advanceFromSpawningAgent(session: OrchestrationSession): Promise<void> {
    if (!session.workspaceContext) {
      throw new Error('Cannot spawn agent: workspace not resolved');
    }

    // Derive capability requirements from the intent constraints.
    const requirements = this.deriveCapabilityRequirements(session.intent);

    const spawnResult = await this.agentSpawner.spawn({
      workspaceContext: session.workspaceContext,
      requirements,
      operatorId: session.operatorId,
      orchestrationSessionId: session.id,
    });

    session.agentId = spawnResult.agentId;
    session.agentSessionId = spawnResult.sessionId;

    await this.transitionState(session.id, 'planning_task', {
      agentId: spawnResult.agentId,
      agentSessionId: spawnResult.sessionId,
      reused: spawnResult.reused,
    });
  }

  /**
   * Advance from planning_task → awaiting_plan_approval (manual) or executing (auto-advance).
   *
   * Generates a task plan via the TaskPlanner. Based on operator preferences:
   * - Manual review (default): stores plan on session, transitions to awaiting_plan_approval
   * - Auto-advance: submits plan immediately, transitions to executing
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4
   */
  private async advanceFromPlanningTask(session: OrchestrationSession): Promise<void> {
    if (!session.workspaceContext || !session.agentId) {
      throw new Error('Cannot plan task: workspace or agent not available');
    }

    const requirements = this.deriveCapabilityRequirements(session.intent);

    const planningContext: PlanningContext = {
      intent: session.intent,
      workspace: session.workspaceContext,
      agentCapabilities: requirements,
    };

    const plan = await this.taskPlanner.generatePlan(planningContext);

    // Handle empty plan (0 steps) by transitioning to failed.
    if (!plan.steps || plan.steps.length === 0) {
      session.failureReason = 'Plan generation produced an empty plan with no steps';
      await this.transitionState(session.id, 'failed', {
        reason: session.failureReason,
      });
      return;
    }

    // Store the plan on the session with a unique planId.
    const planId = uuidv4();
    session.currentPlan = { ...plan, planId };

    // Initialize plan revision history.
    const revisionEntry: PlanRevisionEntry = {
      planId,
      plan,
      generatedAt: new Date(),
    };
    session.planRevisionHistory = [revisionEntry];

    // Check operator preferences for review mode.
    const reviewMode = planningContext.operatorPreferences?.reviewMode;

    if (reviewMode === 'auto-advance') {
      // Auto-advance: submit plan immediately and transition to executing.
      const codingTaskId = await this.taskPlanner.submitPlan(
        plan,
        session.agentId,
        session.operatorId,
      );
      session.codingTaskId = codingTaskId;

      await this.transitionState(session.id, 'executing', {
        codingTaskId,
        stepCount: plan.steps.length,
        autoAdvanced: true,
      });

      // Emit plan_approved event for informational purposes.
      this.operatorInterface.broadcastEvent(`session:${session.id}`, {
        channel: `session:${session.id}`,
        type: 'plan_approved',
        data: {
          sessionId: session.id,
          operatorId: session.operatorId,
          codingTaskId,
          planId,
          autoAdvanced: true,
        },
        timestamp: new Date(),
      });

      // Record auto-advance audit entry.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        operatorId: session.operatorId,
        eventType: 'session_lifecycle',
        operation: 'plan_auto_approved',
        resource: `orchestration_session:${session.id}`,
        details: {
          orchestrationSessionId: session.id,
          planId,
          stepCount: plan.steps.length,
          reasoning: plan.reasoning,
          estimatedDuration: plan.estimatedDuration,
          autoAdvanced: true,
          revisionNumber: 1,
        },
      });
    } else {
      // Manual review (default): transition to awaiting_plan_approval.
      session.planEnteredAt = new Date();

      await this.transitionState(session.id, 'awaiting_plan_approval', {
        planId,
        stepCount: plan.steps.length,
      });

      // Emit plan_ready event.
      this.operatorInterface.broadcastEvent(`session:${session.id}`, {
        channel: `session:${session.id}`,
        type: 'plan_ready',
        data: {
          sessionId: session.id,
          operatorId: session.operatorId,
          plan: {
            planId,
            steps: plan.steps.map((s) => ({
              instructions: s.instructions,
              executionMode: s.executionMode,
            })),
            reasoning: plan.reasoning,
            estimatedDuration: plan.estimatedDuration,
          },
          revisionNumber: 1,
        },
        timestamp: new Date(),
      });
    }
  }

  /**
   * Advance from executing → completed.
   *
   * Marks the session as completed. In a full implementation, this would
   * check the underlying Coding_Task status.
   */
  private async advanceFromExecuting(session: OrchestrationSession): Promise<void> {
    session.completedAt = new Date();
    await this.transitionState(session.id, 'completed', {
      codingTaskId: session.codingTaskId,
    });
  }

  // ------------------------------------------------------------------
  // Private — State transition
  // ------------------------------------------------------------------

  /**
   * Transition a session to a new state, recording the event.
   *
   * Validates the transition is legal, updates the session, records
   * the event in history, emits to handlers, and broadcasts via
   * the operator interface.
   */
  private async transitionState(
    sessionId: string,
    toState: OrchestrationState,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const fromState = session.state;

    // Validate the transition is legal.
    const validTargets = VALID_TRANSITIONS[fromState];
    if (!validTargets.includes(toState)) {
      throw new Error(
        `Invalid state transition: ${fromState} → ${toState} (valid: ${validTargets.join(', ')})`,
      );
    }

    // Update session state.
    session.state = toState;
    session.updatedAt = new Date();

    // Record the event.
    const event: OrchestrationEvent = {
      sessionId,
      fromState,
      toState,
      timestamp: session.updatedAt,
      metadata,
    };

    // Append to history.
    const sessionHistory = this.history.get(sessionId);
    if (sessionHistory) {
      sessionHistory.push(event);
    }

    // Emit to registered handlers.
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Swallow handler errors to prevent cascading failures.
      }
    }

    // Broadcast via operator interface.
    this.operatorInterface.broadcastEvent(`session:${sessionId}`, {
      channel: `session:${sessionId}`,
      type: 'state_transition',
      data: {
        sessionId,
        fromState,
        toState,
        metadata,
      },
      timestamp: session.updatedAt,
    });

    // Record in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: session.updatedAt,
      operatorId: session.operatorId,
      eventType: 'session_lifecycle',
      operation: 'orchestration_state_transition',
      resource: `orchestration_session:${sessionId}`,
      details: {
        orchestrationSessionId: sessionId,
        transition: { from: fromState, to: toState },
        intent: {
          rawInput: session.intent.rawInput,
          action: session.intent.action,
          repository: session.intent.repository,
          confidence: session.intent.confidence,
        },
        ...(metadata ?? {}),
      },
    });
  }

  // ------------------------------------------------------------------
  // Private — Helpers
  // ------------------------------------------------------------------

  /**
   * Derive capability requirements from a structured intent.
   *
   * Extracts language, framework, and tool requirements from the
   * intent's constraints field if available.
   */
  private deriveCapabilityRequirements(intent: StructuredIntent): CapabilityRequirements {
    const constraints = intent.constraints ?? {};

    return {
      languages: Array.isArray(constraints.languages)
        ? (constraints.languages as string[])
        : typeof constraints.language === 'string'
          ? [constraints.language]
          : undefined,
      frameworks: Array.isArray(constraints.frameworks)
        ? (constraints.frameworks as string[])
        : typeof constraints.framework === 'string'
          ? [constraints.framework]
          : undefined,
      tools: Array.isArray(constraints.tools)
        ? (constraints.tools as string[])
        : typeof constraints.tool === 'string'
          ? [constraints.tool]
          : undefined,
    };
  }
}
