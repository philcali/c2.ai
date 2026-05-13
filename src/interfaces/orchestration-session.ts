import type {
  StructuredIntent,
  OrchestrationSession,
  OrchestrationState,
  OrchestrationEvent,
} from './orchestration-config.js';

/**
 * IOrchestrationSessionManager — Tracks the full lifecycle of intents
 * from receipt through workspace resolution, agent spawning, task planning,
 * execution, and completion.
 *
 * Both operator-initiated intents and platform events flow through the same
 * Orchestration_Session lifecycle, providing uniform traceability and control.
 *
 * State machine:
 *   intent_received → resolving_workspace → spawning_agent → planning_task → executing → completed|failed
 *   intent_received → pending_approval (for platform events denied by guardrails)
 *   pending_approval → resolving_workspace (after operator approval)
 *   Any non-terminal state → failed (on cancel or unrecoverable error)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 7.1, 7.3, 7.4, 7.5
 */
export interface IOrchestrationSessionManager {
  /**
   * Create a new orchestration session from a structured intent.
   *
   * For platform event intents, evaluates guardrail policies via the
   * Policy_Engine. If the policy denies the session, it transitions
   * to 'pending_approval' instead of proceeding.
   *
   * @param intent - The structured intent to create a session for
   * @param operatorId - The operator who owns this session
   * @returns The created orchestration session
   */
  createSession(intent: StructuredIntent, operatorId: string): Promise<OrchestrationSession>;

  /**
   * Drive the session through its lifecycle states.
   *
   * Each call advances the session one step:
   *   intent_received → resolving_workspace (resolve workspace)
   *   resolving_workspace → spawning_agent (spawn agent)
   *   spawning_agent → planning_task (generate plan)
   *   planning_task → executing (submit plan to task orchestrator)
   *   executing → completed (when task completes)
   *
   * If any step fails, the session transitions to 'failed'.
   *
   * @param sessionId - The ID of the session to advance
   * @returns The updated session after advancement
   * @throws Error if the session is in a terminal or non-advanceable state
   */
  advance(sessionId: string): Promise<OrchestrationSession>;

  /**
   * Approve a session that is pending approval.
   *
   * Resumes the session from 'pending_approval' to 'resolving_workspace',
   * allowing it to proceed through the normal lifecycle.
   *
   * @param sessionId - The ID of the session to approve
   * @param operatorId - The operator approving the session
   * @returns The updated session after approval
   * @throws Error if the session is not in 'pending_approval' state
   */
  approve(sessionId: string, operatorId: string): Promise<OrchestrationSession>;

  /**
   * Cancel a session at any non-terminal stage.
   *
   * Transitions the session to 'failed' with the provided reason.
   *
   * @param sessionId - The ID of the session to cancel
   * @param reason - The reason for cancellation
   * @param operatorId - The operator cancelling the session
   * @throws Error if the session is already in a terminal state
   */
  cancel(sessionId: string, reason: string, operatorId: string): Promise<void>;

  /**
   * Get a session by ID.
   *
   * @param sessionId - The ID of the session to retrieve
   * @returns The session, or undefined if not found
   */
  getSession(sessionId: string): OrchestrationSession | undefined;

  /**
   * List sessions, optionally filtered by state or operator.
   *
   * @param filter - Optional filter criteria
   * @returns Array of matching sessions
   */
  listSessions(filter?: {
    state?: OrchestrationState;
    operatorId?: string;
  }): OrchestrationSession[];

  /**
   * Get the full resolution chain for a session.
   *
   * Returns an ordered sequence of OrchestrationEvent entries covering
   * every state transition the session underwent.
   *
   * @param sessionId - The ID of the session
   * @returns Ordered array of orchestration events
   */
  getHistory(sessionId: string): Promise<OrchestrationEvent[]>;

  /**
   * Subscribe to session lifecycle events.
   *
   * The handler is called for every state transition across all sessions.
   *
   * @param handler - Callback invoked on each session event
   */
  onSessionEvent(handler: (event: OrchestrationEvent) => void): void;
}
