import fc from 'fast-check';
import type { StructuredIntent } from '../../src/interfaces/orchestration-config.js';

/** Generate a valid StructuredIntent with realistic field combinations */
export const arbitraryStructuredIntent = (): fc.Arbitrary<StructuredIntent> =>
  fc.record({
    id: fc.uuid(),
    sourceType: fc.constantFrom('operator', 'platform_event'),
    sourceId: fc.uuid(),
    repository: fc.option(
      fc.tuple(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
      ).map(([owner, repo]) => `${owner}/${repo}`),
      { nil: undefined }
    ),
    branch: fc.option(
      fc.constantFrom('main', 'develop', 'feature/auth', 'fix/bug-123', 'release/v2.0'),
      { nil: undefined }
    ),
    action: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    constraints: fc.option(
      fc.dictionary(
        fc.constantFrom('maxFiles', 'language', 'scope', 'priority'),
        fc.oneof(fc.string({ minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 100 }), fc.boolean()),
        { minKeys: 1, maxKeys: 3 }
      ),
      { nil: undefined }
    ),
    issueRef: fc.option(
      fc.integer({ min: 1, max: 9999 }).map(n => `#${n}`),
      { nil: undefined }
    ),
    prRef: fc.option(
      fc.integer({ min: 1, max: 9999 }).map(n => `#${n}`),
      { nil: undefined }
    ),
    confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    rawInput: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
    parsedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
  });

/** Generate a partial intent for testing clarification scenarios (missing repository or empty action) */
export const arbitraryPartialIntent = (): fc.Arbitrary<StructuredIntent> =>
  fc.oneof(
    // Missing repository
    arbitraryStructuredIntent().map(intent => ({ ...intent, repository: undefined })),
    // Empty action
    arbitraryStructuredIntent().map(intent => ({ ...intent, action: '' })),
  );
