import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { arbitraryAuditEntry } from '../generators/audit.generator.js';
import type { AuditEntry, AuditEventType, AuditQuery } from '../../src/interfaces/audit-log.js';

describe('Audit Log Property Tests', () => {
  let auditLog: AuditLog;

  beforeEach(() => {
    auditLog = new AuditLog();
  });

  // --------------------------------------------------------------------------
  // Property 22: Audit Log Completeness
  // Every recorded entry is retrievable via query.
  // Validates: Requirements 8.1, 8.4
  // --------------------------------------------------------------------------
  describe('Property 22: Audit Log Completeness', () => {
    it('every recorded entry is retrievable via an empty query', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();

            for (const entry of entries) {
              await log.record(entry);
            }

            const all = await log.query({});
            expect(all).toHaveLength(entries.length);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('each recorded entry can be retrieved by its assigned sequence number', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();

            for (const entry of entries) {
              await log.record(entry);
            }

            const all = await log.query({});

            // Every entry from 1..N should be present exactly once.
            const seqNums = all.map((e) => e.sequenceNumber);
            const expected = Array.from({ length: entries.length }, (_, i) => i + 1);
            expect(seqNums).toEqual(expected);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('entries recorded with a specific agentId are all retrievable by that agentId', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();

            for (const entry of entries) {
              await log.record(entry);
            }

            // For each distinct agentId present, querying by it should return
            // exactly the entries that have that agentId.
            const agentIds = new Set(entries.map((e) => e.agentId).filter(Boolean));
            for (const agentId of agentIds) {
              const results = await log.query({ agentId });
              const expectedCount = entries.filter((e) => e.agentId === agentId).length;
              expect(results).toHaveLength(expectedCount);
              for (const r of results) {
                expect(r.agentId).toBe(agentId);
              }
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 23: Audit Log Append-Only Invariant
  // Entries are never modified or deleted after recording.
  // Validates: Requirements 8.3
  // --------------------------------------------------------------------------
  describe('Property 23: Audit Log Append-Only Invariant', () => {
    it('recording new entries never changes previously recorded entries', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 2, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();

            // Record entries one at a time and snapshot after each.
            const snapshots: AuditEntry[][] = [];

            for (const entry of entries) {
              await log.record(entry);
              const current = await log.query({});
              // Deep-clone the snapshot so later mutations can't affect it.
              snapshots.push(current.map((e) => ({ ...e, timestamp: new Date(e.timestamp.getTime()), details: { ...e.details } })));
            }

            // For every snapshot, verify that the entries present at that point
            // are identical in the final state.
            const finalState = await log.query({});
            for (let i = 0; i < snapshots.length; i++) {
              const snapshot = snapshots[i];
              for (let j = 0; j < snapshot.length; j++) {
                const snapshotEntry = snapshot[j];
                const finalEntry = finalState[j];
                expect(finalEntry.sequenceNumber).toBe(snapshotEntry.sequenceNumber);
                expect(finalEntry.eventType).toBe(snapshotEntry.eventType);
                expect(finalEntry.operation).toBe(snapshotEntry.operation);
                expect(finalEntry.resource).toBe(snapshotEntry.resource);
                expect(finalEntry.agentId).toBe(snapshotEntry.agentId);
                expect(finalEntry.decision).toBe(snapshotEntry.decision);
                expect(finalEntry.timestamp.getTime()).toBe(snapshotEntry.timestamp.getTime());
              }
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('the total entry count only ever increases', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();
            let previousCount = 0;

            for (const entry of entries) {
              await log.record(entry);
              const currentCount = (await log.query({})).length;
              expect(currentCount).toBe(previousCount + 1);
              previousCount = currentCount;
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 24: Audit Log Query Filtering
  // Query results match all specified criteria and include all matching entries.
  // Validates: Requirements 8.1, 8.4
  // --------------------------------------------------------------------------
  describe('Property 24: Audit Log Query Filtering', () => {
    it('filtering by eventType returns exactly the matching entries', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          fc.constantFrom<AuditEventType>(
            'policy_decision', 'session_lifecycle', 'memory_operation',
            'communication', 'external_service', 'security_violation',
            'operator_action', 'acp_task', 'acp_discovery', 'agentcp_session',
          ),
          async (entries, eventType) => {
            const log = new AuditLog();
            for (const entry of entries) {
              await log.record(entry);
            }

            const results = await log.query({ eventType });
            const expectedCount = entries.filter((e) => e.eventType === eventType).length;

            expect(results).toHaveLength(expectedCount);
            for (const r of results) {
              expect(r.eventType).toBe(eventType);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('filtering by decision returns exactly the matching entries', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          fc.constantFrom<'allow' | 'deny'>('allow', 'deny'),
          async (entries, decision) => {
            const log = new AuditLog();
            for (const entry of entries) {
              await log.record(entry);
            }

            const results = await log.query({ decision });
            const expectedCount = entries.filter((e) => e.decision === decision).length;

            expect(results).toHaveLength(expectedCount);
            for (const r of results) {
              expect(r.decision).toBe(decision);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('filtering by afterSequence returns only entries with higher sequence numbers', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 2, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();
            for (const entry of entries) {
              await log.record(entry);
            }

            // Pick a cutoff somewhere in the middle.
            const cutoff = Math.floor(entries.length / 2);
            const results = await log.query({ afterSequence: cutoff });

            expect(results).toHaveLength(entries.length - cutoff);
            for (const r of results) {
              expect(r.sequenceNumber).toBeGreaterThan(cutoff);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('filtering by timeRange returns only entries within the range', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();
            for (const entry of entries) {
              await log.record(entry);
            }

            // Build a time range from the min and max timestamps in the entries.
            const timestamps = entries.map((e) => e.timestamp.getTime());
            const minTs = Math.min(...timestamps);
            const maxTs = Math.max(...timestamps);
            const mid = Math.floor((minTs + maxTs) / 2);

            const timeRange = { start: new Date(mid), end: new Date(maxTs) };
            const results = await log.query({ timeRange });

            const expectedCount = entries.filter(
              (e) => e.timestamp.getTime() >= mid && e.timestamp.getTime() <= maxTs,
            ).length;

            expect(results).toHaveLength(expectedCount);
            for (const r of results) {
              expect(r.timestamp.getTime()).toBeGreaterThanOrEqual(mid);
              expect(r.timestamp.getTime()).toBeLessThanOrEqual(maxTs);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('combining multiple filters returns only entries matching ALL criteria', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 5, maxLength: 30 }),
          fc.constantFrom<AuditEventType>(
            'policy_decision', 'session_lifecycle', 'memory_operation',
          ),
          fc.constantFrom<'allow' | 'deny'>('allow', 'deny'),
          async (entries, eventType, decision) => {
            const log = new AuditLog();
            for (const entry of entries) {
              await log.record(entry);
            }

            const query: AuditQuery = { eventType, decision };
            const results = await log.query(query);

            const expectedCount = entries.filter(
              (e) => e.eventType === eventType && e.decision === decision,
            ).length;

            expect(results).toHaveLength(expectedCount);
            for (const r of results) {
              expect(r.eventType).toBe(eventType);
              expect(r.decision).toBe(decision);
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 25: Audit Log Monotonic Sequence Numbers
  // Sequence numbers are strictly increasing across all recorded entries.
  // Validates: Requirements 8.5
  // --------------------------------------------------------------------------
  describe('Property 25: Audit Log Monotonic Sequence Numbers', () => {
    it('sequence numbers are strictly increasing starting from 1', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 50 }),
          async (entries) => {
            const log = new AuditLog();

            for (const entry of entries) {
              await log.record(entry);
            }

            const all = await log.query({});

            for (let i = 0; i < all.length; i++) {
              expect(all[i].sequenceNumber).toBe(i + 1);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('each new entry has a sequence number exactly one greater than the previous', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 2, maxLength: 50 }),
          async (entries) => {
            const log = new AuditLog();

            for (const entry of entries) {
              await log.record(entry);
            }

            const all = await log.query({});

            for (let i = 1; i < all.length; i++) {
              expect(all[i].sequenceNumber - all[i - 1].sequenceNumber).toBe(1);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('getSequenceNumber() always equals the highest assigned sequence number', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 1, maxLength: 30 }),
          async (entries) => {
            const log = new AuditLog();

            expect(log.getSequenceNumber()).toBe(0);

            for (let i = 0; i < entries.length; i++) {
              await log.record(entries[i]);
              expect(log.getSequenceNumber()).toBe(i + 1);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('no two entries share the same sequence number', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(arbitraryAuditEntry(), { minLength: 2, maxLength: 50 }),
          async (entries) => {
            const log = new AuditLog();

            for (const entry of entries) {
              await log.record(entry);
            }

            const all = await log.query({});
            const seqNums = all.map((e) => e.sequenceNumber);
            const uniqueSeqNums = new Set(seqNums);

            expect(uniqueSeqNums.size).toBe(seqNums.length);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
