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
 *   planning_task → executing
 *   executing → completed
 *   Any non-terminal → failed
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
   * Advance from planning_task → executing.
   *
   * Generates a task plan and submits it to the Task_Orchestrator.
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
    const codingTaskId = await this.taskPlanner.submitPlan(
      plan,
      session.agentId,
      session.operatorId,
    );

    session.codingTaskId = codingTaskId;

    await this.transitionState(session.id, 'executing', {
      codingTaskId,
      stepCount: plan.steps.length,
    });
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
