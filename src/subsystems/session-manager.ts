import { v4 as uuidv4 } from 'uuid';
import type {
  ISessionManager,
  AgentSession,
  AgentSessionInfo,
  SessionState,
} from '../interfaces/session-manager.js';
import type {
  AgentManifest,
  IsolationBoundary,
} from '../interfaces/manifest-validator.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';

/**
 * Valid state transitions for the Agent Session lifecycle.
 *
 * State machine:
 *   [*] → running           (createSession)
 *   running → paused        (pauseSession)
 *   paused → running        (resumeSession)
 *   running → errored       (unrecoverable error)
 *   running → completed     (agent completes)
 *   errored → terminated    (auto-terminate)
 *   running → terminated    (terminateSession)
 *   paused → terminated     (terminateSession)
 */
const VALID_TRANSITIONS: Record<SessionState, SessionState[]> = {
  running: ['paused', 'errored', 'completed', 'terminated'],
  paused: ['running', 'terminated'],
  errored: ['terminated'],
  completed: [],
  terminated: [],
};

/**
 * In-memory Session Manager with lifecycle management.
 *
 * Guarantees:
 *  - Every session gets a unique ID (UUID v4).
 *  - Isolation boundaries are derived exactly from the agent manifest.
 *  - All lifecycle events are recorded in the Audit Log.
 *  - Configurable max concurrent sessions is enforced.
 *  - State transitions follow the defined state machine.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.4
 */
export class SessionManager implements ISessionManager {
  /** Active sessions keyed by session ID. */
  private readonly sessions: Map<string, AgentSession> = new Map();

  /** Maximum number of concurrent active sessions. */
  private maxConcurrent: number;

  /** Audit log for recording lifecycle events. */
  private readonly auditLog: IAuditLog;

  /** Policy engine for isolation boundary setup. */
  private readonly policyEngine: IPolicyEngine;

  constructor(options: {
    auditLog: IAuditLog;
    policyEngine: IPolicyEngine;
    maxConcurrentSessions?: number;
  }) {
    this.auditLog = options.auditLog;
    this.policyEngine = options.policyEngine;
    this.maxConcurrent = options.maxConcurrentSessions ?? 10;
  }

  // ------------------------------------------------------------------
  // ISessionManager — Session creation
  // ------------------------------------------------------------------

  async createSession(
    manifest: AgentManifest,
    operatorId: string,
  ): Promise<AgentSession> {
    // Enforce max concurrent sessions (count only non-terminal sessions).
    const activeCount = this.getActiveSessionCount();
    if (activeCount >= this.maxConcurrent) {
      await this.auditLog.record({
        sequenceNumber: 0, // assigned by AuditLog
        timestamp: new Date(),
        operatorId,
        eventType: 'session_lifecycle',
        operation: 'create_session',
        resource: `manifest:${manifest.id}`,
        decision: 'deny',
        details: {
          reason: 'Maximum concurrent sessions exceeded',
          maxConcurrent: this.maxConcurrent,
          activeCount,
        },
      });

      throw new Error(
        `Cannot create session: maximum concurrent sessions (${this.maxConcurrent}) reached.`,
      );
    }

    const sessionId = uuidv4();
    const now = new Date();

    // Build isolation boundary from manifest — grants exactly the
    // permissions declared, no more and no less.
    const isolationBoundary = this.buildIsolationBoundary(sessionId, manifest);

    const session: AgentSession = {
      id: sessionId,
      manifestId: manifest.id,
      state: 'running',
      isolationBoundary,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(sessionId, session);

    // Record creation in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: manifest.agentIdentity,
      operatorId,
      eventType: 'session_lifecycle',
      operation: 'create_session',
      resource: `session:${sessionId}`,
      details: {
        manifestId: manifest.id,
        agentIdentity: manifest.agentIdentity,
        state: 'running',
      },
    });

    return session;
  }

  // ------------------------------------------------------------------
  // ISessionManager — Termination
  // ------------------------------------------------------------------

  async terminateSession(sessionId: string, reason: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    this.transitionState(session, 'terminated');

    // Record termination in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: session.updatedAt,
      agentId: session.manifestId,
      eventType: 'session_lifecycle',
      operation: 'terminate_session',
      resource: `session:${sessionId}`,
      details: {
        reason,
        previousState: this.getPreviousState(session),
        state: 'terminated',
      },
    });
  }

  // ------------------------------------------------------------------
  // ISessionManager — Pause / Resume
  // ------------------------------------------------------------------

  async pauseSession(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    this.transitionState(session, 'paused');

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: session.updatedAt,
      agentId: session.manifestId,
      eventType: 'session_lifecycle',
      operation: 'pause_session',
      resource: `session:${sessionId}`,
      details: { state: 'paused' },
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    this.transitionState(session, 'running');

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: session.updatedAt,
      agentId: session.manifestId,
      eventType: 'session_lifecycle',
      operation: 'resume_session',
      resource: `session:${sessionId}`,
      details: { state: 'running' },
    });
  }

  // ------------------------------------------------------------------
  // ISessionManager — Query
  // ------------------------------------------------------------------

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): AgentSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      manifestId: s.manifestId,
      state: s.state,
      createdAt: s.createdAt,
    }));
  }

  // ------------------------------------------------------------------
  // ISessionManager — Concurrency configuration
  // ------------------------------------------------------------------

  getMaxConcurrentSessions(): number {
    return this.maxConcurrent;
  }

  setMaxConcurrentSessions(max: number): void {
    if (max < 1) {
      throw new Error('Maximum concurrent sessions must be at least 1.');
    }
    this.maxConcurrent = max;
  }

  // ------------------------------------------------------------------
  // Public helpers for subsystems that need to drive state transitions
  // (e.g., an agent completing its work, or an unrecoverable error).
  // ------------------------------------------------------------------

  /**
   * Transition a session to the 'errored' state and then auto-terminate it.
   * Records both the error and the subsequent termination in the audit log.
   *
   * Requirements: 1.4
   */
  async errorSession(sessionId: string, reason: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    this.transitionState(session, 'errored');

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: session.updatedAt,
      agentId: session.manifestId,
      eventType: 'session_lifecycle',
      operation: 'error_session',
      resource: `session:${sessionId}`,
      details: { reason, state: 'errored' },
    });

    // Auto-terminate after entering errored state (Req 1.4).
    await this.terminateSession(sessionId, `Auto-terminated after error: ${reason}`);
  }

  /**
   * Transition a session to the 'completed' state.
   * Records the completion in the audit log.
   */
  async completeSession(sessionId: string): Promise<void> {
    const session = this.getSessionOrThrow(sessionId);

    this.transitionState(session, 'completed');

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: session.updatedAt,
      agentId: session.manifestId,
      eventType: 'session_lifecycle',
      operation: 'complete_session',
      resource: `session:${sessionId}`,
      details: { state: 'completed' },
    });
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Build an IsolationBoundary from an AgentManifest.
   * The boundary grants exactly the permissions declared in the manifest.
   *
   * Requirements: 2.1
   */
  private buildIsolationBoundary(
    sessionId: string,
    manifest: AgentManifest,
  ): IsolationBoundary {
    return {
      sessionId,
      allowedNamespaces: manifest.memoryNamespaces.map((ns) => ns.namespace),
      allowedChannels: [...manifest.communicationChannels],
      allowedServices: manifest.mcpOperations.map(
        (op) => op.serviceId,
      ),
    };
  }

  /**
   * Transition a session to a new state, enforcing the state machine.
   * Throws if the transition is invalid.
   */
  private transitionState(session: AgentSession, newState: SessionState): void {
    const allowed = VALID_TRANSITIONS[session.state];

    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid state transition: cannot move from '${session.state}' to '${newState}' ` +
        `for session '${session.id}'.`,
      );
    }

    session.state = newState;
    session.updatedAt = new Date();
  }

  /**
   * Retrieve a session or throw if not found.
   */
  private getSessionOrThrow(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }
    return session;
  }

  /**
   * Count sessions that are in a non-terminal state (running or paused).
   * Errored sessions are counted as active since they haven't been
   * terminated yet (auto-termination happens asynchronously).
   */
  private getActiveSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (
        session.state !== 'completed' &&
        session.state !== 'terminated'
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Helper to infer the previous state for audit log details.
   * Since we mutate state in-place, we track this by checking what
   * transitions lead to the current state.
   */
  private getPreviousState(session: AgentSession): string {
    // After a transition, session.state is already the new state.
    // For termination, the previous state could have been running, paused, or errored.
    // We return 'unknown' since we don't track history — the audit log itself
    // provides the full history via prior entries.
    return 'unknown';
  }
}
