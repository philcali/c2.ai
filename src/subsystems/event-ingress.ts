import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import type { IEventIngress } from '../interfaces/event-ingress.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type {
  PlatformEvent,
  EventSourceRegistration,
  StructuredIntent,
  OrchestrationSession,
} from '../interfaces/orchestration-config.js';

/**
 * Minimal interface for the OrchestrationSessionManager dependency.
 *
 * EventIngress only needs the ability to create sessions from intents.
 * The full IOrchestrationSessionManager interface is defined in task 8;
 * this keeps EventIngress decoupled until that subsystem is wired.
 */
export interface IOrchestrationSessionCreator {
  createSession(intent: StructuredIntent, operatorId: string): Promise<OrchestrationSession>;
}

/**
 * EventIngress — Receives and validates external platform events,
 * translating them into structured intents and creating autonomous
 * orchestration sessions.
 *
 * Flow:
 *  1. Validate the event source is registered.
 *  2. Validate the event signature (HMAC-SHA256).
 *  3. Translate the event payload into a StructuredIntent.
 *  4. Create a new Orchestration_Session for the translated intent.
 *
 * Each platform event creates an independent session associated with
 * the operator who owns the event source registration.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */
export class EventIngress implements IEventIngress {
  private readonly orchestrationSession: IOrchestrationSessionCreator;
  private readonly policyEngine: IPolicyEngine;
  private readonly auditLog: IAuditLog;

  private readonly sources: Map<string, EventSourceRegistration> = new Map();

  constructor(options: {
    orchestrationSession: IOrchestrationSessionCreator;
    policyEngine: IPolicyEngine;
    auditLog: IAuditLog;
  }) {
    this.orchestrationSession = options.orchestrationSession;
    this.policyEngine = options.policyEngine;
    this.auditLog = options.auditLog;
  }

  // ------------------------------------------------------------------
  // IEventIngress — processEvent
  // ------------------------------------------------------------------

  /**
   * Process an incoming platform event.
   *
   * Validates the source registration, verifies the signature,
   * translates the event into a StructuredIntent, and creates
   * a new Orchestration_Session.
   *
   * Requirements: 5.1, 5.2, 5.6, 5.7
   */
  async processEvent(event: PlatformEvent): Promise<string> {
    const now = new Date();

    // 1. Look up the registered source.
    const source = this.sources.get(event.sourceId);
    if (!source) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        eventType: 'external_event',
        operation: 'event_rejected',
        resource: `event:${event.id}`,
        details: {
          eventId: event.id,
          sourceId: event.sourceId,
          reason: 'unregistered_source',
        },
      });
      throw new Error(`Event source not registered: ${event.sourceId}`);
    }

    // 2. Check that the event type is allowed for this source.
    if (!source.allowedEventTypes.includes(event.eventType)) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        eventType: 'external_event',
        operation: 'event_rejected',
        resource: `event:${event.id}`,
        details: {
          eventId: event.id,
          sourceId: event.sourceId,
          eventType: event.eventType,
          reason: 'event_type_not_allowed',
        },
      });
      throw new Error(
        `Event type '${event.eventType}' not allowed for source '${event.sourceId}'`,
      );
    }

    // 3. Validate the event signature.
    if (!this.validateSignature(event, source)) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        eventType: 'security_violation',
        operation: 'signature_validation_failed',
        resource: `event:${event.id}`,
        decision: 'deny',
        details: {
          eventId: event.id,
          sourceId: event.sourceId,
          eventType: event.eventType,
        },
      });
      throw new Error(`Event signature validation failed for event: ${event.id}`);
    }

    // 4. Translate the event into a StructuredIntent.
    const intent = this.translateEventToIntent(event, source);

    // 5. Create a new Orchestration_Session.
    const session = await this.orchestrationSession.createSession(
      intent,
      source.ownerOperatorId,
    );

    // 6. Record the successful event processing.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId: source.ownerOperatorId,
      eventType: 'external_event',
      operation: 'event_processed',
      resource: `event:${event.id}`,
      details: {
        eventId: event.id,
        sourceId: event.sourceId,
        eventType: event.eventType,
        orchestrationSessionId: session.id,
        intentId: intent.id,
        action: intent.action,
        repository: intent.repository,
      },
    });

    return session.id;
  }

  // ------------------------------------------------------------------
  // IEventIngress — Source management
  // ------------------------------------------------------------------

  /**
   * Register an event source.
   */
  registerSource(registration: EventSourceRegistration): void {
    this.sources.set(registration.id, registration);
  }

  /**
   * Deregister an event source.
   */
  deregisterSource(sourceId: string): void {
    this.sources.delete(sourceId);
  }

  /**
   * List all registered event sources.
   */
  listSources(): EventSourceRegistration[] {
    return Array.from(this.sources.values());
  }

  // ------------------------------------------------------------------
  // IEventIngress — Signature validation
  // ------------------------------------------------------------------

  /**
   * Validate the HMAC-SHA256 signature of a platform event.
   *
   * The signature is computed as HMAC-SHA256(webhookSecret, JSON(payload))
   * and compared against the event's signature field using timing-safe
   * comparison.
   *
   * Requirements: 5.1
   */
  validateSignature(event: PlatformEvent, source: EventSourceRegistration): boolean {
    if (!event.signature) {
      return false;
    }

    const payload = JSON.stringify(event.payload);
    const expectedSignature = createHmac('sha256', source.webhookSecret)
      .update(payload)
      .digest('hex');

    // Timing-safe comparison to prevent timing attacks.
    if (event.signature.length !== expectedSignature.length) {
      return false;
    }

    let mismatch = 0;
    for (let i = 0; i < event.signature.length; i++) {
      mismatch |= event.signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }

    return mismatch === 0;
  }

  // ------------------------------------------------------------------
  // Private — Event translation
  // ------------------------------------------------------------------

  /**
   * Translate a platform event into a StructuredIntent.
   *
   * Dispatches to event-type-specific translators based on the
   * event's eventType field.
   *
   * Requirements: 5.2, 5.3, 5.4, 5.5
   */
  translateEventToIntent(
    event: PlatformEvent,
    source: EventSourceRegistration,
  ): StructuredIntent {
    switch (event.eventType) {
      case 'push':
        return this.translatePushEvent(event, source);
      case 'pull_request_comment':
        return this.translatePRCommentEvent(event, source);
      case 'workflow_run':
        return this.translateWorkflowRunEvent(event, source);
      default:
        return this.translateGenericEvent(event, source);
    }
  }

  /**
   * Translate a git push event into a StructuredIntent.
   *
   * Creates an intent to diagnose and fix CI failures on the pushed branch.
   *
   * Requirements: 5.4
   */
  private translatePushEvent(
    event: PlatformEvent,
    source: EventSourceRegistration,
  ): StructuredIntent {
    const payload = event.payload as {
      ref?: string;
      repository?: { full_name?: string; clone_url?: string };
      head_commit?: { message?: string };
      pusher?: { name?: string };
    };

    const branch = payload.ref?.replace('refs/heads/', '') ?? undefined;
    const repository = payload.repository?.full_name ?? undefined;
    const commitMessage = payload.head_commit?.message ?? '';
    const pusher = payload.pusher?.name ?? 'unknown';

    return {
      id: uuidv4(),
      sourceType: 'platform_event',
      sourceId: event.sourceId,
      repository,
      branch,
      action: `Process push event: ${commitMessage} (pushed by ${pusher})`,
      confidence: 1.0,
      rawInput: JSON.stringify(event.payload),
      parsedAt: new Date(),
    };
  }

  /**
   * Translate a PR comment event into a StructuredIntent.
   *
   * Creates an intent to address the feedback in the comment,
   * targeting the PR branch and repository.
   *
   * Requirements: 5.3
   */
  private translatePRCommentEvent(
    event: PlatformEvent,
    source: EventSourceRegistration,
  ): StructuredIntent {
    const payload = event.payload as {
      comment?: { body?: string; user?: { login?: string } };
      pull_request?: { number?: number; head?: { ref?: string }; base?: { ref?: string } };
      repository?: { full_name?: string; clone_url?: string };
    };

    const repository = payload.repository?.full_name ?? undefined;
    const branch = payload.pull_request?.head?.ref ?? undefined;
    const commentBody = payload.comment?.body ?? '';
    const commentAuthor = payload.comment?.user?.login ?? 'unknown';
    const prNumber = payload.pull_request?.number;

    return {
      id: uuidv4(),
      sourceType: 'platform_event',
      sourceId: event.sourceId,
      repository,
      branch,
      action: `Address PR comment from ${commentAuthor}: ${commentBody}`,
      prRef: prNumber ? `#${prNumber}` : undefined,
      confidence: 1.0,
      rawInput: JSON.stringify(event.payload),
      parsedAt: new Date(),
    };
  }

  /**
   * Translate a workflow run event into a StructuredIntent.
   *
   * Creates an intent to investigate and resolve workflow failures.
   *
   * Requirements: 5.5
   */
  private translateWorkflowRunEvent(
    event: PlatformEvent,
    source: EventSourceRegistration,
  ): StructuredIntent {
    const payload = event.payload as {
      workflow_run?: {
        conclusion?: string;
        head_branch?: string;
        head_sha?: string;
        name?: string;
      };
      repository?: { full_name?: string; clone_url?: string };
    };

    const repository = payload.repository?.full_name ?? undefined;
    const branch = payload.workflow_run?.head_branch ?? undefined;
    const conclusion = payload.workflow_run?.conclusion ?? 'unknown';
    const workflowName = payload.workflow_run?.name ?? 'unknown';

    return {
      id: uuidv4(),
      sourceType: 'platform_event',
      sourceId: event.sourceId,
      repository,
      branch,
      action: `Investigate workflow '${workflowName}' ${conclusion} on branch '${branch ?? 'unknown'}'`,
      confidence: 1.0,
      rawInput: JSON.stringify(event.payload),
      parsedAt: new Date(),
    };
  }

  /**
   * Translate a generic/unknown event type into a StructuredIntent.
   *
   * Provides a best-effort translation for event types not explicitly
   * handled by the specialized translators.
   */
  private translateGenericEvent(
    event: PlatformEvent,
    source: EventSourceRegistration,
  ): StructuredIntent {
    return {
      id: uuidv4(),
      sourceType: 'platform_event',
      sourceId: event.sourceId,
      action: `Process ${event.eventType} event from ${source.platform}`,
      confidence: 0.8,
      rawInput: JSON.stringify(event.payload),
      parsedAt: new Date(),
    };
  }
}
