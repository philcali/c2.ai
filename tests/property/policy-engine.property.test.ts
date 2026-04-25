import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { arbitraryAccessPolicy, arbitraryAuthzRequest } from '../generators/policy.generator.js';
import type { AccessPolicy, AuthzRequest } from '../../src/interfaces/policy-engine.js';

// ---------------------------------------------------------------------------
// Helpers — generators tailored for property tests
// ---------------------------------------------------------------------------

/**
 * Generate a valid AccessPolicy with controlled fields suitable for
 * deterministic property assertions. The generator from the shared
 * generators file produces policies whose conditions may use operators
 * not recognised by the engine (e.g. "notEquals", "contains"). For
 * property tests that need predictable evaluation we use condition-free
 * policies or policies with known-good conditions.
 */
const arbitraryValidPolicy = (overrides?: Partial<AccessPolicy>): fc.Arbitrary<AccessPolicy> =>
  fc.record({
    id: fc.uuid(),
    version: fc.constant(1),
    agentId: overrides?.agentId !== undefined
      ? fc.constant(overrides.agentId)
      : fc.oneof(
          fc.constant('*'),
          fc.uuid(),
        ),
    operations: overrides?.operations !== undefined
      ? fc.constant(overrides.operations)
      : fc.array(
          fc.constantFrom('read', 'write', 'send', 'receive', 'execute'),
          { minLength: 1, maxLength: 3 },
        ),
    resources: overrides?.resources !== undefined
      ? fc.constant(overrides.resources)
      : fc.array(
          fc.stringMatching(/^[a-z]{1,10}:[a-z0-9]{1,10}$/),
          { minLength: 1, maxLength: 3 },
        ),
    conditions: fc.constant(undefined),
    effect: overrides?.effect !== undefined
      ? fc.constant(overrides.effect)
      : fc.constantFrom<'allow' | 'deny'>('allow', 'deny'),
  });

/**
 * Generate an AuthzRequest that is guaranteed to match a given policy
 * (ignoring conditions). Useful for testing that a matching allow
 * policy actually produces an allow decision.
 */
const arbitraryMatchingRequest = (policy: AccessPolicy): fc.Arbitrary<AuthzRequest> =>
  fc.record({
    agentId: policy.agentId === '*'
      ? fc.uuid()
      : fc.constant(policy.agentId),
    operation: fc.constantFrom(...policy.operations),
    resource: fc.constantFrom(...policy.resources),
    context: fc.constant(undefined),
  });

/**
 * Generate an AuthzRequest that will NOT match any of the given policies.
 * We achieve this by using an agent ID, operation, and resource that
 * none of the policies reference (and none use wildcards for).
 */
const arbitraryNonMatchingRequest = (): fc.Arbitrary<AuthzRequest> =>
  fc.record({
    agentId: fc.constant('non-matching-agent-00000000-0000-0000-0000-000000000000'),
    operation: fc.constant('__nonexistent_operation__'),
    resource: fc.constant('__nonexistent_resource__'),
    context: fc.constant(undefined),
  });

describe('Policy Engine Property Tests', () => {
  let engine: PolicyEngine;

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  // --------------------------------------------------------------------------
  // Property 16: Policy Evaluation Correctness
  // Verify allow iff matching allow policy exists and no deny overrides.
  // Validates: Requirements 6.1
  // --------------------------------------------------------------------------
  describe('Property 16: Policy Evaluation Correctness', () => {
    it('a request matching an allow policy with no deny override is allowed', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy({ effect: 'allow' }),
          (allowPolicy) => {
            const eng = new PolicyEngine();
            eng.addPolicy(allowPolicy);

            // Build a request that matches the allow policy.
            const request: AuthzRequest = {
              agentId: allowPolicy.agentId === '*' ? 'test-agent' : allowPolicy.agentId,
              operation: allowPolicy.operations[0],
              resource: allowPolicy.resources[0],
            };

            const decision = eng.evaluate(request);
            expect(decision.allowed).toBe(true);
            expect(decision.policyId).toBe(allowPolicy.id);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('a deny policy overrides a matching allow policy', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.uuid(),
          fc.uuid(),
          fc.constantFrom('read', 'write', 'send', 'receive', 'execute'),
          fc.stringMatching(/^[a-z]{1,10}:[a-z0-9]{1,10}$/),
          (allowId, denyId, agentId, operation, resource) => {
            // Skip if IDs collide (extremely unlikely with UUIDs).
            fc.pre(allowId !== denyId);

            const eng = new PolicyEngine();

            const allowPolicy: AccessPolicy = {
              id: allowId,
              version: 1,
              agentId,
              operations: [operation],
              resources: [resource],
              effect: 'allow',
            };

            const denyPolicy: AccessPolicy = {
              id: denyId,
              version: 1,
              agentId,
              operations: [operation],
              resources: [resource],
              effect: 'deny',
            };

            eng.addPolicy(allowPolicy);
            eng.addPolicy(denyPolicy);

            const decision = eng.evaluate({ agentId, operation, resource });
            expect(decision.allowed).toBe(false);
            expect(decision.policyId).toBe(denyId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('a wildcard deny policy overrides any allow policy for the same operation/resource', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          fc.uuid(),
          fc.uuid(),
          fc.constantFrom('read', 'write', 'send', 'receive', 'execute'),
          fc.stringMatching(/^[a-z]{1,10}:[a-z0-9]{1,10}$/),
          (allowId, denyId, agentId, operation, resource) => {
            fc.pre(allowId !== denyId);

            const eng = new PolicyEngine();

            eng.addPolicy({
              id: allowId,
              version: 1,
              agentId,
              operations: [operation],
              resources: [resource],
              effect: 'allow',
            });

            // Wildcard deny — applies to all agents.
            eng.addPolicy({
              id: denyId,
              version: 1,
              agentId: '*',
              operations: [operation],
              resources: [resource],
              effect: 'deny',
            });

            const decision = eng.evaluate({ agentId, operation, resource });
            expect(decision.allowed).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('allow decision references the matching allow policy id', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy({ effect: 'allow' }),
          (policy) => {
            const eng = new PolicyEngine();
            eng.addPolicy(policy);

            const request: AuthzRequest = {
              agentId: policy.agentId === '*' ? 'any-agent' : policy.agentId,
              operation: policy.operations[0],
              resource: policy.resources[0],
            };

            const decision = eng.evaluate(request);
            expect(decision.allowed).toBe(true);
            expect(decision.policyId).toBe(policy.id);
            expect(decision.reason).toContain(policy.id);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('deny decision references the matching deny policy id', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy({ effect: 'deny' }),
          (policy) => {
            const eng = new PolicyEngine();
            eng.addPolicy(policy);

            const request: AuthzRequest = {
              agentId: policy.agentId === '*' ? 'any-agent' : policy.agentId,
              operation: policy.operations[0],
              resource: policy.resources[0],
            };

            const decision = eng.evaluate(request);
            expect(decision.allowed).toBe(false);
            expect(decision.policyId).toBe(policy.id);
            expect(decision.reason).toContain(policy.id);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 17: Default Deny
  // Verify deny when no allow policy matches.
  // Validates: Requirements 6.4
  // --------------------------------------------------------------------------
  describe('Property 17: Default Deny', () => {
    it('an empty policy set denies every request', () => {
      fc.assert(
        fc.property(
          arbitraryAuthzRequest(),
          (request) => {
            const eng = new PolicyEngine();
            const decision = eng.evaluate(request);
            expect(decision.allowed).toBe(false);
            expect(decision.policyId).toBeUndefined();
            expect(decision.reason).toContain('Default deny');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('a request that matches no policy is denied', () => {
      fc.assert(
        fc.property(
          fc.array(
            arbitraryValidPolicy({ effect: 'allow' }),
            { minLength: 1, maxLength: 10 },
          ),
          arbitraryNonMatchingRequest(),
          (policies, request) => {
            const eng = new PolicyEngine();

            // Deduplicate policy IDs to avoid addPolicy rejection.
            const seen = new Set<string>();
            for (const p of policies) {
              if (seen.has(p.id)) continue;
              seen.add(p.id);

              // Ensure none of the policies use wildcards that would match
              // the non-matching request.
              const safePolicy: AccessPolicy = {
                ...p,
                agentId: p.agentId === '*' ? 'specific-agent-id' : p.agentId,
                operations: p.operations.filter((op) => op !== '*'),
                resources: p.resources.filter((r) => r !== '*' && !r.endsWith('*')),
              };
              if (safePolicy.operations.length === 0) safePolicy.operations = ['read'];
              if (safePolicy.resources.length === 0) safePolicy.resources = ['memory:ns1'];
              eng.addPolicy(safePolicy);
            }

            const decision = eng.evaluate(request);
            expect(decision.allowed).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('only deny policies (no allow) still results in deny', () => {
      fc.assert(
        fc.property(
          fc.array(
            arbitraryValidPolicy({ effect: 'deny' }),
            { minLength: 1, maxLength: 5 },
          ),
          arbitraryAuthzRequest(),
          (denyPolicies, request) => {
            const eng = new PolicyEngine();
            const seen = new Set<string>();
            for (const p of denyPolicies) {
              if (seen.has(p.id)) continue;
              seen.add(p.id);
              eng.addPolicy(p);
            }

            const decision = eng.evaluate(request);
            // With only deny policies, the result is always deny —
            // either a matching deny or default deny.
            expect(decision.allowed).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('removing the only matching allow policy restores default deny', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy({ effect: 'allow' }),
          (policy) => {
            const eng = new PolicyEngine();
            eng.addPolicy(policy);

            const request: AuthzRequest = {
              agentId: policy.agentId === '*' ? 'test-agent' : policy.agentId,
              operation: policy.operations[0],
              resource: policy.resources[0],
            };

            // Should be allowed.
            expect(eng.evaluate(request).allowed).toBe(true);

            // Remove the policy.
            eng.removePolicy(policy.id);

            // Should now be denied by default.
            const decision = eng.evaluate(request);
            expect(decision.allowed).toBe(false);
            expect(decision.policyId).toBeUndefined();
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 18: Policy Validation Rejects Malformed Policies
  // Verify invalid policies are rejected with descriptive errors.
  // Validates: Requirements 6.5
  // --------------------------------------------------------------------------
  describe('Property 18: Policy Validation Rejects Malformed Policies', () => {
    it('a policy with an empty id is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          (basePolicy) => {
            const eng = new PolicyEngine();
            const malformed: AccessPolicy = { ...basePolicy, id: '' };
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.some((e) => e.toLowerCase().includes('id'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a policy with an invalid effect is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          fc.string({ minLength: 1, maxLength: 10 }).filter(
            (s) => s !== 'allow' && s !== 'deny',
          ),
          (basePolicy, badEffect) => {
            const eng = new PolicyEngine();
            const malformed = { ...basePolicy, effect: badEffect } as unknown as AccessPolicy;
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.toLowerCase().includes('effect'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a policy with empty operations array is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          (basePolicy) => {
            const eng = new PolicyEngine();
            const malformed: AccessPolicy = { ...basePolicy, operations: [] };
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.toLowerCase().includes('operations'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a policy with empty resources array is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          (basePolicy) => {
            const eng = new PolicyEngine();
            const malformed: AccessPolicy = { ...basePolicy, resources: [] };
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.toLowerCase().includes('resources'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a policy with empty agentId is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          (basePolicy) => {
            const eng = new PolicyEngine();
            const malformed: AccessPolicy = { ...basePolicy, agentId: '' };
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.toLowerCase().includes('agentid'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a policy with an invalid condition operator is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          fc.string({ minLength: 1, maxLength: 15 }).filter(
            (s) => !['equals', 'not_equals', 'in', 'not_in', 'exists', 'not_exists'].includes(s),
          ),
          (basePolicy, badOperator) => {
            const eng = new PolicyEngine();
            const malformed: AccessPolicy = {
              ...basePolicy,
              conditions: [{ field: 'namespace', operator: badOperator, value: 'test' }],
            };
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.toLowerCase().includes('operator'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a policy with operations containing empty strings is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          (basePolicy) => {
            const eng = new PolicyEngine();
            const malformed: AccessPolicy = {
              ...basePolicy,
              operations: ['read', '', 'write'],
            };
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.toLowerCase().includes('operation'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('a policy with resources containing empty strings is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          (basePolicy) => {
            const eng = new PolicyEngine();
            const malformed: AccessPolicy = {
              ...basePolicy,
              resources: ['memory:ns1', '  ', 'mcp:github'],
            };
            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.toLowerCase().includes('resource'))).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('multiple validation errors are all reported', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          (_id) => {
            const eng = new PolicyEngine();
            const malformed = {
              id: '',
              version: 1,
              agentId: '',
              operations: [],
              resources: [],
              effect: 'invalid',
            } as unknown as AccessPolicy;

            const result = eng.addPolicy(malformed);
            expect(result.valid).toBe(false);
            // Should report errors for id, agentId, operations, resources, and effect.
            expect(result.errors.length).toBeGreaterThanOrEqual(4);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('a valid policy is accepted', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          (policy) => {
            const eng = new PolicyEngine();
            const result = eng.addPolicy(policy);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 19: Policy Versioning Round-Trip
  // Verify each version is retrievable and rollback restores exact state.
  // Validates: Requirements 6.6
  // --------------------------------------------------------------------------
  describe('Property 19: Policy Versioning Round-Trip', () => {
    it('each version of a policy is retrievable after updates', () => {
      fc.assert(
        fc.property(
          // Generate a sequence of 2–6 distinct policy states to apply as updates.
          fc.array(
            arbitraryValidPolicy(),
            { minLength: 2, maxLength: 6 },
          ),
          (policyVersions) => {
            const eng = new PolicyEngine();

            // Use the first policy's ID for all versions.
            const policyId = policyVersions[0].id;

            // Add the first version.
            const first = { ...policyVersions[0], id: policyId };
            const addResult = eng.addPolicy(first);
            expect(addResult.valid).toBe(true);

            // Apply subsequent updates.
            for (let i = 1; i < policyVersions.length; i++) {
              const update = { ...policyVersions[i], id: policyId };
              const updateResult = eng.updatePolicy(policyId, update);
              expect(updateResult.valid).toBe(true);
            }

            // Verify each version is retrievable.
            for (let v = 1; v <= policyVersions.length; v++) {
              const retrieved = eng.getPolicyVersion(policyId, v);
              expect(retrieved).toBeDefined();
              expect(retrieved!.version).toBe(v);
              expect(retrieved!.id).toBe(policyId);
            }

            // Current policy should be the latest version.
            const current = eng.getPolicy(policyId);
            expect(current).toBeDefined();
            expect(current!.version).toBe(policyVersions.length);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('rollback restores the exact state of the target version', () => {
      fc.assert(
        fc.property(
          fc.array(
            arbitraryValidPolicy(),
            { minLength: 3, maxLength: 6 },
          ),
          fc.integer({ min: 1, max: 5 }),
          (policyVersions, rawRollbackTarget) => {
            const eng = new PolicyEngine();
            const policyId = policyVersions[0].id;

            // Add first version.
            eng.addPolicy({ ...policyVersions[0], id: policyId });

            // Apply updates.
            for (let i = 1; i < policyVersions.length; i++) {
              eng.updatePolicy(policyId, { ...policyVersions[i], id: policyId });
            }

            // Clamp rollback target to valid range.
            const rollbackTarget = Math.min(rawRollbackTarget, policyVersions.length);

            // Snapshot the target version before rollback.
            const targetSnapshot = eng.getPolicyVersion(policyId, rollbackTarget)!;

            // Perform rollback.
            const rollbackResult = eng.rollbackPolicy(policyId, rollbackTarget);
            expect(rollbackResult.valid).toBe(true);

            // Current policy should match the target version's content.
            const current = eng.getPolicy(policyId)!;
            expect(current.agentId).toBe(targetSnapshot.agentId);
            expect(current.operations).toEqual(targetSnapshot.operations);
            expect(current.resources).toEqual(targetSnapshot.resources);
            expect(current.effect).toBe(targetSnapshot.effect);
            expect(current.conditions).toEqual(targetSnapshot.conditions);

            // The version number should be incremented (rollback creates a new version).
            expect(current.version).toBe(policyVersions.length + 1);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('rollback to an invalid version is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          fc.integer({ min: 2, max: 100 }),
          (policy, invalidVersion) => {
            const eng = new PolicyEngine();
            eng.addPolicy(policy);

            // Only version 1 exists, so anything > 1 is invalid.
            const result = eng.rollbackPolicy(policy.id, invalidVersion);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('rollback to version 0 or negative is rejected', () => {
      fc.assert(
        fc.property(
          arbitraryValidPolicy(),
          fc.integer({ min: -100, max: 0 }),
          (policy, invalidVersion) => {
            const eng = new PolicyEngine();
            eng.addPolicy(policy);

            const result = eng.rollbackPolicy(policy.id, invalidVersion);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('rollback for a non-existent policy is rejected', () => {
      fc.assert(
        fc.property(
          fc.uuid(),
          (nonExistentId) => {
            const eng = new PolicyEngine();
            const result = eng.rollbackPolicy(nonExistentId, 1);
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes('not found'))).toBe(true);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('version history is preserved after rollback', () => {
      fc.assert(
        fc.property(
          fc.array(
            arbitraryValidPolicy(),
            { minLength: 3, maxLength: 5 },
          ),
          (policyVersions) => {
            const eng = new PolicyEngine();
            const policyId = policyVersions[0].id;

            eng.addPolicy({ ...policyVersions[0], id: policyId });
            for (let i = 1; i < policyVersions.length; i++) {
              eng.updatePolicy(policyId, { ...policyVersions[i], id: policyId });
            }

            // Rollback to version 1.
            eng.rollbackPolicy(policyId, 1);

            // All original versions should still be retrievable.
            for (let v = 1; v <= policyVersions.length; v++) {
              const retrieved = eng.getPolicyVersion(policyId, v);
              expect(retrieved).toBeDefined();
              expect(retrieved!.version).toBe(v);
            }

            // Plus the new rollback version.
            const rollbackVersion = eng.getPolicyVersion(policyId, policyVersions.length + 1);
            expect(rollbackVersion).toBeDefined();
            expect(rollbackVersion!.version).toBe(policyVersions.length + 1);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
