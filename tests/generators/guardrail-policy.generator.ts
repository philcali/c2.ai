import fc from 'fast-check';
import type { AccessPolicy, PolicyCondition } from '../../src/interfaces/policy-engine.js';

/** Generate guardrail-specific policy conditions */
const arbitraryGuardrailCondition = (): fc.Arbitrary<PolicyCondition> =>
  fc.oneof(
    // Max concurrent autonomous sessions
    fc.record({
      field: fc.constant('concurrent_autonomous_count'),
      operator: fc.constantFrom('lte', 'lt', 'eq'),
      value: fc.integer({ min: 1, max: 20 }) as fc.Arbitrary<unknown>,
    }),
    // Max step count per session
    fc.record({
      field: fc.constant('max_step_count'),
      operator: fc.constantFrom('lte', 'lt'),
      value: fc.integer({ min: 5, max: 100 }) as fc.Arbitrary<unknown>,
    }),
    // Allowed actions restriction
    fc.record({
      field: fc.constant('allowed_actions'),
      operator: fc.constant('in'),
      value: fc.array(
        fc.constantFrom('read', 'write', 'execute', 'deploy', 'test', 'lint'),
        { minLength: 1, maxLength: 4 }
      ) as fc.Arbitrary<unknown>,
    }),
  );

/** Generate an AccessPolicy configured as a guardrail policy for autonomous sessions */
export const arbitraryGuardrailPolicy = (): fc.Arbitrary<AccessPolicy> =>
  fc.record({
    id: fc.uuid().map(id => `guardrail-${id}`),
    version: fc.integer({ min: 1, max: 50 }),
    agentId: fc.constant('*' as const),
    operations: fc.constant(['autonomous_session']),
    resources: fc.array(
      fc.oneof(
        fc.constant('*'),
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 15 }).filter(s => /^[a-z0-9-]+$/i.test(s)),
          fc.constantFrom('*', 'repo-a', 'repo-b', 'service-api'),
        ).map(([org, repo]) => `github.com/${org}/${repo}`),
      ),
      { minLength: 1, maxLength: 3 }
    ),
    conditions: fc.option(
      fc.array(arbitraryGuardrailCondition(), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
    effect: fc.constantFrom('allow', 'deny'),
  });
