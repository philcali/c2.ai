import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { arbitraryAgentManifest } from '../generators/manifest.generator.js';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';
import type { AuditEntry } from '../../src/interfaces/audit-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh SessionManager with real AuditLog and PolicyEngine. */
function createSessionManager(maxConcurrent = 100) {
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const sessionManager = new SessionManager({
    auditLog,
    policyEngine,
    maxConcurrentSessions: maxConcurrent,
  });
  return { sessionManager, auditLog, policyEngine };
}

/**
 * Generate a manifest that is guaranteed to have a unique id within a test run.
 * We use the shared generator and rely on UUID generation for uniqueness.
 */
const arbitraryManifest = (): fc.Arbitrary<AgentManifest> => arbitraryAgentManifest();

/**
 * Generate a list of manifests with guaranteed unique IDs.
 */
const arbitraryUniqueManifests = (
  min: number,
  max: number,
): fc.Arbitrary<AgentManifest[]> =>
  fc.array(arbitraryManifest(), { minLength: min, maxLength: max }).map((manifests) => {
    // Deduplicate by manifest id (extremely unlikely with UUIDs, but safe).
    const seen = new Set<string>();
    return manifests.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }).filter((arr) => arr.length >= min);

describe('Session Manager Property Tests', () => {
  // --------------------------------------------------------------------------
  // Property 1: Session ID Uniqueness
  // For any sequence of session creation requests with valid manifests,
  // every created Agent_Session SHALL have a unique identifier.
  // Validates: Requirements 1.1
  // --------------------------------------------------------------------------
  describe('Property 1: Session ID Uniqueness', () => {
    it('all created sessions have unique IDs', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueManifests(2, 20),
          async (manifests) => {
            const { sessionManager } = createSessionManager(manifests.length + 10);

            const sessions = [];
            for (const manifest of manifests) {
              const session = await sessionManager.createSession(manifest, 'operator-1');
              sessions.push(session);
            }

            const ids = sessions.map((s) => s.id);
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('session IDs are unique even when created from the same manifest', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          fc.integer({ min: 2, max: 10 }),
          async (manifest, count) => {
            const { sessionManager } = createSessionManager(count + 10);

            const ids: string[] = [];
            for (let i = 0; i < count; i++) {
              // Use a fresh manifest id each time since createSession stores by manifest id
              const m = { ...manifest, id: `${manifest.id}-${i}` };
              const session = await sessionManager.createSession(m, 'operator-1');
              ids.push(session.id);
            }

            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(ids.length);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('session IDs are non-empty strings', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          async (manifest) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            expect(typeof session.id).toBe('string');
            expect(session.id.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('session IDs remain unique across interleaved create and terminate operations', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueManifests(4, 15),
          async (manifests) => {
            const { sessionManager } = createSessionManager(manifests.length + 10);

            const allIds = new Set<string>();

            for (let i = 0; i < manifests.length; i++) {
              const session = await sessionManager.createSession(manifests[i], 'operator-1');
              allIds.add(session.id);

              // Terminate every other session to exercise ID uniqueness
              // even after sessions are recycled.
              if (i % 2 === 0) {
                await sessionManager.terminateSession(session.id, 'test cleanup');
              }
            }

            // Every ID ever assigned should be unique.
            expect(allIds.size).toBe(manifests.length);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 2: Isolation Boundary Matches Manifest
  // For any valid Agent_Manifest, the resulting Isolation_Boundary SHALL
  // grant exactly the permissions declared in the manifest — no more, no less.
  // Validates: Requirements 2.1
  // --------------------------------------------------------------------------
  describe('Property 2: Isolation Boundary Matches Manifest', () => {
    it('isolation boundary namespaces match manifest memory namespaces exactly', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          async (manifest) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            const expectedNamespaces = manifest.memoryNamespaces.map((ns) => ns.namespace);
            expect(session.isolationBoundary.allowedNamespaces).toEqual(expectedNamespaces);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('isolation boundary channels match manifest communication channels exactly', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          async (manifest) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            expect(session.isolationBoundary.allowedChannels).toEqual(
              manifest.communicationChannels,
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('isolation boundary services match manifest MCP operations exactly', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          async (manifest) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            const expectedServices = manifest.mcpOperations.map((op) => op.serviceId);
            expect(session.isolationBoundary.allowedServices).toEqual(expectedServices);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('isolation boundary grants no extra permissions beyond the manifest', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          async (manifest) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            const boundary = session.isolationBoundary;

            // The boundary should have exactly the same number of entries
            // as the manifest declares — no extras.
            expect(boundary.allowedNamespaces.length).toBe(manifest.memoryNamespaces.length);
            expect(boundary.allowedChannels.length).toBe(manifest.communicationChannels.length);
            expect(boundary.allowedServices.length).toBe(manifest.mcpOperations.length);

            // Every namespace in the boundary must come from the manifest.
            const manifestNamespaces = new Set(manifest.memoryNamespaces.map((ns) => ns.namespace));
            for (const ns of boundary.allowedNamespaces) {
              expect(manifestNamespaces.has(ns)).toBe(true);
            }

            // Every channel in the boundary must come from the manifest.
            const manifestChannels = new Set(manifest.communicationChannels);
            for (const ch of boundary.allowedChannels) {
              expect(manifestChannels.has(ch)).toBe(true);
            }

            // Every service in the boundary must come from the manifest.
            const manifestServices = new Set(manifest.mcpOperations.map((op) => op.serviceId));
            for (const svc of boundary.allowedServices) {
              expect(manifestServices.has(svc)).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('isolation boundary sessionId matches the session id', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          async (manifest) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            expect(session.isolationBoundary.sessionId).toBe(session.id);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('an empty manifest produces an empty isolation boundary', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest().map((m) => ({
            ...m,
            memoryNamespaces: [],
            communicationChannels: [],
            mcpOperations: [],
          })),
          async (emptyManifest) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(emptyManifest, 'operator-1');

            expect(session.isolationBoundary.allowedNamespaces).toEqual([]);
            expect(session.isolationBoundary.allowedChannels).toEqual([]);
            expect(session.isolationBoundary.allowedServices).toEqual([]);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 3: Termination Produces Correct State and Audit Entry
  // For any active Agent_Session that is terminated, the session state SHALL
  // become 'terminated', and the Audit_Log SHALL contain an entry recording
  // the termination with the session identifier and reason.
  // Validates: Requirements 1.3, 1.4
  // --------------------------------------------------------------------------
  describe('Property 3: Termination Produces Correct State and Audit Entry', () => {
    it('terminated session has state "terminated"', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (manifest, reason) => {
            const { sessionManager } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            expect(session.state).toBe('running');

            await sessionManager.terminateSession(session.id, reason);

            const terminated = sessionManager.getSession(session.id);
            expect(terminated).toBeDefined();
            expect(terminated!.state).toBe('terminated');
          },
        ),
        { numRuns: 50 },
      );
    });

    it('termination produces an audit log entry with session id and reason', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (manifest, reason) => {
            const { sessionManager, auditLog } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            await sessionManager.terminateSession(session.id, reason);

            // Query audit log for termination entries.
            const entries = await auditLog.query({ eventType: 'session_lifecycle' });
            const terminationEntries = entries.filter(
              (e) =>
                e.operation === 'terminate_session' &&
                e.resource === `session:${session.id}`,
            );

            expect(terminationEntries.length).toBeGreaterThanOrEqual(1);

            const entry = terminationEntries[0];
            expect(entry.resource).toBe(`session:${session.id}`);
            expect(entry.details).toBeDefined();
            expect((entry.details as Record<string, unknown>).reason).toBe(reason);
            expect((entry.details as Record<string, unknown>).state).toBe('terminated');
          },
        ),
        { numRuns: 50 },
      );
    });

    it('session creation also produces an audit log entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          async (manifest) => {
            const { sessionManager, auditLog } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            const entries = await auditLog.query({ eventType: 'session_lifecycle' });
            const creationEntries = entries.filter(
              (e) =>
                e.operation === 'create_session' &&
                e.resource === `session:${session.id}`,
            );

            expect(creationEntries.length).toBe(1);
            expect(creationEntries[0].operatorId).toBe('operator-1');
          },
        ),
        { numRuns: 50 },
      );
    });

    it('error-then-terminate produces both audit entries', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (manifest, errorReason) => {
            const { sessionManager, auditLog } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            // errorSession transitions to errored then auto-terminates.
            await sessionManager.errorSession(session.id, errorReason);

            const terminated = sessionManager.getSession(session.id);
            expect(terminated!.state).toBe('terminated');

            // Should have both error and termination audit entries.
            const entries = await auditLog.query({ eventType: 'session_lifecycle' });
            const errorEntries = entries.filter(
              (e) =>
                e.operation === 'error_session' &&
                e.resource === `session:${session.id}`,
            );
            const terminationEntries = entries.filter(
              (e) =>
                e.operation === 'terminate_session' &&
                e.resource === `session:${session.id}`,
            );

            expect(errorEntries.length).toBe(1);
            expect(terminationEntries.length).toBe(1);
            expect((errorEntries[0].details as Record<string, unknown>).reason).toBe(errorReason);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('terminating a paused session produces correct state and audit entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryManifest(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (manifest, reason) => {
            const { sessionManager, auditLog } = createSessionManager();
            const session = await sessionManager.createSession(manifest, 'operator-1');

            await sessionManager.pauseSession(session.id);
            expect(sessionManager.getSession(session.id)!.state).toBe('paused');

            await sessionManager.terminateSession(session.id, reason);

            const terminated = sessionManager.getSession(session.id);
            expect(terminated!.state).toBe('terminated');

            const entries = await auditLog.query({ eventType: 'session_lifecycle' });
            const terminationEntries = entries.filter(
              (e) =>
                e.operation === 'terminate_session' &&
                e.resource === `session:${session.id}`,
            );
            expect(terminationEntries.length).toBe(1);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 4: Maximum Concurrent Sessions Enforced
  // For any configured maximum N, when N Agent_Sessions are already active,
  // attempting to create an additional session SHALL be rejected, and the
  // number of active sessions SHALL never exceed N.
  // Validates: Requirements 1.5
  // --------------------------------------------------------------------------
  describe('Property 4: Maximum Concurrent Sessions Enforced', () => {
    it('creating more sessions than the max is rejected', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          arbitraryUniqueManifests(1, 15),
          async (maxConcurrent, manifests) => {
            const { sessionManager } = createSessionManager(maxConcurrent);

            let created = 0;
            let rejected = 0;

            for (const manifest of manifests) {
              try {
                await sessionManager.createSession(manifest, 'operator-1');
                created++;
              } catch {
                rejected++;
              }
            }

            // Should have created exactly min(manifests.length, maxConcurrent).
            const expectedCreated = Math.min(manifests.length, maxConcurrent);
            expect(created).toBe(expectedCreated);

            // Remaining should have been rejected.
            const expectedRejected = Math.max(0, manifests.length - maxConcurrent);
            expect(rejected).toBe(expectedRejected);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('active session count never exceeds the configured maximum', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 8 }),
          arbitraryUniqueManifests(1, 20),
          async (maxConcurrent, manifests) => {
            const { sessionManager } = createSessionManager(maxConcurrent);

            for (const manifest of manifests) {
              try {
                await sessionManager.createSession(manifest, 'operator-1');
              } catch {
                // Expected when at capacity.
              }

              // After every operation, the active session count must not exceed max.
              const activeSessions = sessionManager
                .listSessions()
                .filter(
                  (s) => s.state !== 'completed' && s.state !== 'terminated',
                );
              expect(activeSessions.length).toBeLessThanOrEqual(maxConcurrent);
            }
          },
        ),
        { numRuns: 50 },
      );
    });

    it('terminating a session frees a slot for a new session', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          arbitraryUniqueManifests(2, 10),
          async (maxConcurrent, manifests) => {
            // Need at least maxConcurrent + 1 manifests to test slot freeing.
            fc.pre(manifests.length > maxConcurrent);

            const { sessionManager } = createSessionManager(maxConcurrent);

            // Fill up to max.
            const createdSessions = [];
            for (let i = 0; i < maxConcurrent; i++) {
              const session = await sessionManager.createSession(manifests[i], 'operator-1');
              createdSessions.push(session);
            }

            // Next creation should fail.
            await expect(
              sessionManager.createSession(manifests[maxConcurrent], 'operator-1'),
            ).rejects.toThrow();

            // Terminate one session.
            await sessionManager.terminateSession(createdSessions[0].id, 'freeing slot');

            // Now creation should succeed.
            const newSession = await sessionManager.createSession(
              manifests[maxConcurrent],
              'operator-1',
            );
            expect(newSession).toBeDefined();
            expect(newSession.state).toBe('running');
          },
        ),
        { numRuns: 50 },
      );
    });

    it('completed sessions do not count toward the concurrent limit', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          arbitraryUniqueManifests(2, 10),
          async (maxConcurrent, manifests) => {
            fc.pre(manifests.length > maxConcurrent);

            const { sessionManager } = createSessionManager(maxConcurrent);

            // Fill up to max.
            const createdSessions = [];
            for (let i = 0; i < maxConcurrent; i++) {
              const session = await sessionManager.createSession(manifests[i], 'operator-1');
              createdSessions.push(session);
            }

            // Complete one session.
            await sessionManager.completeSession(createdSessions[0].id);

            // Now creation should succeed since completed sessions don't count.
            const newSession = await sessionManager.createSession(
              manifests[maxConcurrent],
              'operator-1',
            );
            expect(newSession).toBeDefined();
            expect(newSession.state).toBe('running');
          },
        ),
        { numRuns: 50 },
      );
    });

    it('rejection is logged in the audit log', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryUniqueManifests(2, 5),
          async (manifests) => {
            fc.pre(manifests.length >= 2);

            const { sessionManager, auditLog } = createSessionManager(1);

            // Create one session (fills the limit).
            await sessionManager.createSession(manifests[0], 'operator-1');

            // Second creation should fail.
            try {
              await sessionManager.createSession(manifests[1], 'operator-1');
            } catch {
              // Expected.
            }

            // Check audit log for the denial entry.
            const entries = await auditLog.query({ eventType: 'session_lifecycle' });
            const denialEntries = entries.filter(
              (e) => e.decision === 'deny' && e.operation === 'create_session',
            );

            expect(denialEntries.length).toBe(1);
            expect(
              (denialEntries[0].details as Record<string, unknown>).reason,
            ).toContain('Maximum concurrent sessions exceeded');
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
