import fc from 'fast-check';
import type { ExternalEventPayload } from '../../src/interfaces/task-orchestrator.js';

/** Generate an ExternalEventPayload for event-driven step resolution */
export const arbitraryExternalEventPayload = (): fc.Arbitrary<ExternalEventPayload> =>
  fc.record({
    sourceId: fc.uuid(),
    eventType: fc.constantFrom(
      'ci_passed', 'ci_failed', 'pr_merged', 'pr_approved', 'pr_rejected',
      'deploy_succeeded', 'deploy_failed', 'review_completed', 'build_completed',
      'test_passed', 'test_failed', 'webhook_received',
    ),
    outcome: fc.constantFrom('success', 'failure'),
    data: fc.oneof(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 0, maxKeys: 5 }
      ),
      fc.string({ minLength: 0, maxLength: 200 }),
      fc.constant(null),
    ),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
  });
