import type {
  PlatformEvent,
  EventSourceRegistration,
} from './orchestration-config.js';

/**
 * IEventIngress — Receives and validates external platform events,
 * translating them into structured intents and creating autonomous
 * orchestration sessions.
 *
 * The Event_Ingress validates event payload signatures using HMAC-SHA256,
 * translates platform events (git push, PR comment, workflow run) into
 * StructuredIntents with the same schema used by the Intent_Resolver,
 * and creates independent Orchestration_Sessions for each event.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */
export interface IEventIngress {
  /**
   * Process an incoming platform event.
   *
   * Validates the event signature, translates the event into a
   * StructuredIntent, evaluates guardrail policies, and creates
   * a new Orchestration_Session.
   *
   * @param event - The platform event to process
   * @returns The orchestration session ID created for this event
   * @throws Error if signature validation fails or source is not registered
   */
  processEvent(event: PlatformEvent): Promise<string>;

  /**
   * Register an event source (webhook endpoint).
   *
   * @param registration - The event source registration details
   */
  registerSource(registration: EventSourceRegistration): void;

  /**
   * Deregister an event source.
   *
   * @param sourceId - The ID of the event source to deregister
   */
  deregisterSource(sourceId: string): void;

  /**
   * List all registered event sources.
   *
   * @returns Array of registered event sources
   */
  listSources(): EventSourceRegistration[];

  /**
   * Validate the signature of a platform event against its registered source.
   *
   * Uses HMAC-SHA256 to verify that the event payload was signed with
   * the registered webhook secret.
   *
   * @param event - The platform event to validate
   * @param source - The registered event source with the webhook secret
   * @returns true if the signature is valid, false otherwise
   */
  validateSignature(event: PlatformEvent, source: EventSourceRegistration): boolean;
}
