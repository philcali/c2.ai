import fc from 'fast-check';
import type { AuditEntry, AuditEventType } from '../../src/interfaces/audit-log.js';
import type { MemoryEntry } from '../../src/interfaces/memory-store.js';

const AUDIT_EVENT_TYPES: AuditEventType[] = [
  'policy_decision',
  'session_lifecycle',
  'memory_operation',
  'communication',
  'external_service',
  'security_violation',
  'operator_action',
  'acp_task',
  'acp_discovery',
  'agentcp_session',
];

export const arbitraryAuditEntry = (): fc.Arbitrary<AuditEntry> =>
  fc.record({
    sequenceNumber: fc.integer({ min: 1, max: 1_000_000 }),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
    agentId: fc.option(fc.uuid(), { nil: undefined }),
    operatorId: fc.option(
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      { nil: undefined }
    ),
    eventType: fc.constantFrom(...AUDIT_EVENT_TYPES),
    operation: fc.constantFrom(
      'read', 'write', 'send', 'receive', 'execute', 'create_session',
      'terminate_session', 'evaluate_policy', 'register_agent', 'submit_task'
    ),
    resource: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    decision: fc.option(fc.constantFrom('allow', 'deny'), { nil: undefined }),
    details: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
      fc.oneof(fc.string(), fc.integer(), fc.boolean()),
      { minKeys: 0, maxKeys: 5 }
    ),
  });

export const arbitraryMemoryEntry = (): fc.Arbitrary<MemoryEntry> =>
  fc.record({
    namespace: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
    key: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    value: fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 15 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 0, maxKeys: 5 }
      ),
      fc.constant(null),
    ),
    authorAgentId: fc.uuid(),
    timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
    tags: fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
      { minLength: 0, maxLength: 5 }
    ),
  });
