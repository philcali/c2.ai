import fc from 'fast-check';
import type { AccessPolicy, AuthzRequest, PolicyCondition } from '../../src/interfaces/policy-engine.js';

export const arbitraryPolicyCondition = (): fc.Arbitrary<PolicyCondition> =>
  fc.record({
    field: fc.constantFrom('agentId', 'namespace', 'channel', 'serviceId', 'time', 'resource'),
    operator: fc.constantFrom('equals', 'notEquals', 'contains', 'startsWith', 'endsWith', 'in'),
    value: fc.oneof(
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.boolean(),
      fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
    ),
  });

export const arbitraryAccessPolicy = (): fc.Arbitrary<AccessPolicy> =>
  fc.record({
    id: fc.uuid(),
    version: fc.integer({ min: 1, max: 100 }),
    agentId: fc.oneof(
      fc.constant('*'),
      fc.uuid(),
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
    ),
    operations: fc.array(
      fc.constantFrom('read', 'write', 'send', 'receive', 'execute', 'subscribe', 'broadcast'),
      { minLength: 1, maxLength: 5 }
    ),
    resources: fc.array(
      fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
      { minLength: 1, maxLength: 5 }
    ),
    conditions: fc.option(
      fc.array(arbitraryPolicyCondition(), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
    effect: fc.constantFrom('allow', 'deny'),
  });

export const arbitraryAuthzRequest = (): fc.Arbitrary<AuthzRequest> =>
  fc.record({
    agentId: fc.oneof(
      fc.uuid(),
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
    ),
    operation: fc.constantFrom('read', 'write', 'send', 'receive', 'execute', 'subscribe', 'broadcast'),
    resource: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    context: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 1, maxKeys: 5 }
      ),
      { nil: undefined }
    ),
  });
