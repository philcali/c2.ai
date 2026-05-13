import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createHmac } from 'crypto';
import { EventIngress } from '../../src/subsystems/event-ingress.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import {
  arbitraryPlatformEvent,
  arbitraryPRCommentPayload,
} from '../generators/platform-event.generator.js';
import type {
  PlatformEvent,
  EventSourceRegistration,
  StructuredIntent,
  OrchestrationSession,
} from '../../src/interfaces/orchestration-config.js';
import type { IOrchestrationSessionCreator } from '../../src/subsystems/event-ingress.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock OrchestrationSessionCreator that records created sessions.
 */
function createMockSessionCreator(): IOrchestrationSessionCreator & {
  sessions: OrchestrationSession[];
} {
  const sessions: OrchestrationSession[] = [];

  return {
    sessions,
    async createSession(
      intent: StructuredIntent,
      operatorId: string,
    ): Promise<OrchestrationSession> {
      const session: OrchestrationSession = {
        id: `session-${sessions.length + 1}`,
        state: 'intent_received',
        intent,
        operatorId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.push(session);
      return session;
    },
  };
}

/**
 * Create a valid signature for a platform event payload using HMAC-SHA256.
 */
function signPayload(payload: unknown, secret: string): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Create a test EventIngress with a registered source and signed event.
 */
function createTestIngress(options?: { allowedEventTypes?: string[] }) {
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const sessionCreator = createMockSessionCreator();

  const eventIngress = new EventIngress({
    orchestrationSession: sessionCreator,
    policyEngine,
    auditLog,
  });

  const webhookSecret = 'test-secret-key-12345';
  const sourceId = 'source-001';
  const ownerOperatorId = 'operator-owner-1';

  const source: EventSourceRegistration = {
    id: sourceId,
    platform: 'github',
    webhookSecret,
    allowedEventTypes: options?.allowedEventTypes ?? [
      'push',
      'pull_request_comment',
      'workflow_run',
    ],
    ownerOperatorId,
  };

  eventIngress.registerSource(source);

  return { eventIngress, sessionCreator, source, webhookSecret, sourceId, ownerOperatorId };
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Event Ingress Property Tests', () => {
  // --------------------------------------------------------------------------
  // Property 8: Event-to-intent schema conformance
  //
  // For any valid platform event, the translated output is a valid
  // StructuredIntent with non-empty sourceId, sourceType 'platform_event',
  // non-empty action, and parsedAt timestamp.
  //
  // Feature: intent-driven-orchestration, Property 8: Event-to-intent schema conformance
  // Validates: Requirements 5.2
  // --------------------------------------------------------------------------
  describe('Property 8: Event-to-intent schema conformance', () => {
    it('translated intent has non-empty sourceId, sourceType platform_event, non-empty action, and parsedAt timestamp', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPlatformEvent(),
          async (event: PlatformEvent) => {
            const { eventIngress, sessionCreator, sourceId, webhookSecret } =
              createTestIngress();

            // Fix the event to use our registered source and sign it.
            const signedEvent: PlatformEvent = {
              ...event,
              sourceId,
              signature: signPayload(event.payload, webhookSecret),
            };

            await eventIngress.processEvent(signedEvent);

            // The session creator should have received exactly one session.
            expect(sessionCreator.sessions.length).toBe(1);

            const intent = sessionCreator.sessions[0].intent;

            // Property assertions:
            // 1. sourceId is non-empty
            expect(intent.sourceId).toBeTruthy();
            expect(intent.sourceId.length).toBeGreaterThan(0);

            // 2. sourceType is 'platform_event'
            expect(intent.sourceType).toBe('platform_event');

            // 3. action is non-empty
            expect(intent.action).toBeTruthy();
            expect(intent.action.length).toBeGreaterThan(0);

            // 4. parsedAt is a valid Date
            expect(intent.parsedAt).toBeInstanceOf(Date);
            expect(intent.parsedAt.getTime()).not.toBeNaN();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('translated intent has a valid UUID id field', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPlatformEvent(),
          async (event: PlatformEvent) => {
            const { eventIngress, sessionCreator, sourceId, webhookSecret } =
              createTestIngress();

            const signedEvent: PlatformEvent = {
              ...event,
              sourceId,
              signature: signPayload(event.payload, webhookSecret),
            };

            await eventIngress.processEvent(signedEvent);

            const intent = sessionCreator.sessions[0].intent;

            // id should be a non-empty string (UUID format)
            expect(intent.id).toBeTruthy();
            expect(typeof intent.id).toBe('string');
            expect(intent.id.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('translated intent confidence is between 0.0 and 1.0', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPlatformEvent(),
          async (event: PlatformEvent) => {
            const { eventIngress, sessionCreator, sourceId, webhookSecret } =
              createTestIngress();

            const signedEvent: PlatformEvent = {
              ...event,
              sourceId,
              signature: signPayload(event.payload, webhookSecret),
            };

            await eventIngress.processEvent(signedEvent);

            const intent = sessionCreator.sessions[0].intent;

            expect(intent.confidence).toBeGreaterThanOrEqual(0.0);
            expect(intent.confidence).toBeLessThanOrEqual(1.0);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('translated intent rawInput is a non-empty string', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPlatformEvent(),
          async (event: PlatformEvent) => {
            const { eventIngress, sessionCreator, sourceId, webhookSecret } =
              createTestIngress();

            const signedEvent: PlatformEvent = {
              ...event,
              sourceId,
              signature: signPayload(event.payload, webhookSecret),
            };

            await eventIngress.processEvent(signedEvent);

            const intent = sessionCreator.sessions[0].intent;

            expect(typeof intent.rawInput).toBe('string');
            expect(intent.rawInput.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 9: PR comment intent targeting
  //
  // For any PR comment event, the translated StructuredIntent has repository
  // matching the event's repository and branch matching the PR's head branch.
  //
  // Feature: intent-driven-orchestration, Property 9: PR comment intent targeting
  // Validates: Requirements 5.3
  // --------------------------------------------------------------------------
  describe('Property 9: PR comment intent targeting', () => {
    it('PR comment intent has repository matching event repository and branch matching PR head branch', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPRCommentPayload(),
          async (payload: Record<string, unknown>) => {
            const { eventIngress, sessionCreator, sourceId, webhookSecret } =
              createTestIngress();

            const event: PlatformEvent = {
              id: `event-${Date.now()}`,
              sourceId,
              eventType: 'pull_request_comment',
              payload,
              signature: signPayload(payload, webhookSecret),
              receivedAt: new Date(),
            };

            await eventIngress.processEvent(event);

            expect(sessionCreator.sessions.length).toBe(1);
            const intent = sessionCreator.sessions[0].intent;

            // Extract expected values from the payload.
            const expectedRepo = (payload.repository as { full_name?: string })?.full_name;
            const expectedBranch = (
              payload.pull_request as { head?: { ref?: string } }
            )?.head?.ref;

            // Property assertions:
            // 1. repository matches the event's repository full_name
            expect(intent.repository).toBe(expectedRepo);

            // 2. branch matches the PR's head branch
            expect(intent.branch).toBe(expectedBranch);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('PR comment intent includes prRef matching the PR number', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPRCommentPayload(),
          async (payload: Record<string, unknown>) => {
            const { eventIngress, sessionCreator, sourceId, webhookSecret } =
              createTestIngress();

            const event: PlatformEvent = {
              id: `event-${Date.now()}`,
              sourceId,
              eventType: 'pull_request_comment',
              payload,
              signature: signPayload(payload, webhookSecret),
              receivedAt: new Date(),
            };

            await eventIngress.processEvent(event);

            const intent = sessionCreator.sessions[0].intent;

            const prNumber = (payload.pull_request as { number?: number })?.number;
            if (prNumber) {
              expect(intent.prRef).toBe(`#${prNumber}`);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('PR comment intent action references the comment content', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryPRCommentPayload(),
          async (payload: Record<string, unknown>) => {
            const { eventIngress, sessionCreator, sourceId, webhookSecret } =
              createTestIngress();

            const event: PlatformEvent = {
              id: `event-${Date.now()}`,
              sourceId,
              eventType: 'pull_request_comment',
              payload,
              signature: signPayload(payload, webhookSecret),
              receivedAt: new Date(),
            };

            await eventIngress.processEvent(event);

            const intent = sessionCreator.sessions[0].intent;

            // The action should reference the comment body.
            const commentBody = (payload.comment as { body?: string })?.body ?? '';
            if (commentBody) {
              expect(intent.action).toContain(commentBody);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
