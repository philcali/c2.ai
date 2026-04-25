import { describe, it, expect, beforeEach } from 'vitest';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { ManifestValidator } from '../../src/subsystems/manifest-validator.js';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import { MemoryStore } from '../../src/subsystems/memory-store.js';
import { AntiLeakage } from '../../src/subsystems/anti-leakage.js';
import { CommunicationBus } from '../../src/subsystems/communication-bus.js';
import { MCPGateway, type ServiceExecutor } from '../../src/subsystems/mcp-gateway.js';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';
import type { ACPMessagePayload } from '../../src/interfaces/communication-bus.js';
import type { ServiceConfig, OperationResult } from '../../src/interfaces/mcp-gateway.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid AgentManifest. */
function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: overrides.id ?? 'agent-manifest-1',
    agentIdentity: overrides.agentIdentity ?? 'agent-1',
    description: overrides.description ?? 'Test agent',
    memoryNamespaces: overrides.memoryNamespaces ?? [],
    communicationChannels: overrides.communicationChannels ?? [],
    mcpOperations: overrides.mcpOperations ?? [],
  };
}

/** Build an allow policy for the given agent, operations, and resources. */
function allowPolicy(
  id: string,
  agentId: string,
  operations: string[],
  resources: string[],
): AccessPolicy {
  return {
    id,
    version: 1,
    agentId,
    operations,
    resources,
    effect: 'allow',
  };
}

/** Build a standard ACP message payload. */
function makePayload(overrides: Partial<ACPMessagePayload> = {}): ACPMessagePayload {
  return {
    type: overrides.type ?? 'text',
    contentType: overrides.contentType ?? 'text/plain',
    body: overrides.body ?? 'hello',
    correlationId: overrides.correlationId,
  };
}

// ---------------------------------------------------------------------------
// Shared subsystem wiring — mirrors CommandCenter constructor
// ---------------------------------------------------------------------------

interface TestSubsystems {
  auditLog: AuditLog;
  policyEngine: PolicyEngine;
  manifestValidator: ManifestValidator;
  sessionManager: SessionManager;
  memoryStore: MemoryStore;
  antiLeakage: AntiLeakage;
  communicationBus: CommunicationBus;
  mcpGateway: MCPGateway;
}

function createSubsystems(opts?: { executor?: ServiceExecutor; maxConcurrentSessions?: number }): TestSubsystems {
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const manifestValidator = new ManifestValidator();

  const sessionManager = new SessionManager({
    auditLog,
    policyEngine,
    maxConcurrentSessions: opts?.maxConcurrentSessions ?? 10,
  });

  const memoryStore = new MemoryStore({ policyEngine, auditLog });

  const antiLeakage = new AntiLeakage({ policyEngine });

  const communicationBus = new CommunicationBus({
    policyEngine,
    antiLeakage,
    auditLog,
    sessionManager,
  });

  const mcpGateway = new MCPGateway({
    policyEngine,
    auditLog,
    antiLeakage,
    executor: opts?.executor,
  });

  return {
    auditLog,
    policyEngine,
    manifestValidator,
    sessionManager,
    memoryStore,
    antiLeakage,
    communicationBus,
    mcpGateway,
  };
}

// ===========================================================================
// Integration Tests — End-to-End Agent Workflow
// ===========================================================================

describe('End-to-end agent workflow', () => {
  let s: TestSubsystems;

  beforeEach(() => {
    s = createSubsystems();
  });

  // -------------------------------------------------------------------------
  // Full workflow: create session → memory ops → messaging → policy → audit
  // Validates: Requirements 1.1, 3.1, 4.1, 5.1, 8.1
  // -------------------------------------------------------------------------

  describe('Full workflow: session → memory → messaging → policy → audit', () => {
    it('should create a session, write/read memory, send a message, and produce audit entries', async () => {
      // 1. Create two agent sessions
      const manifestA = makeManifest({
        id: 'manifest-a',
        agentIdentity: 'agent-a',
        memoryNamespaces: [{ namespace: 'shared', access: 'readwrite' }],
        communicationChannels: ['general'],
      });
      const manifestB = makeManifest({
        id: 'manifest-b',
        agentIdentity: 'agent-b',
        memoryNamespaces: [{ namespace: 'shared', access: 'read' }],
        communicationChannels: ['general'],
      });

      const sessionA = await s.sessionManager.createSession(manifestA, 'operator-1');
      const sessionB = await s.sessionManager.createSession(manifestB, 'operator-1');

      expect(sessionA.state).toBe('running');
      expect(sessionB.state).toBe('running');
      expect(sessionA.id).not.toBe(sessionB.id);

      // 2. Add policies so agents can read/write memory and communicate
      s.policyEngine.addPolicy(allowPolicy(
        'pol-a-mem-write', sessionA.id, ['write'], ['memory:shared'],
      ));
      s.policyEngine.addPolicy(allowPolicy(
        'pol-a-mem-read', sessionA.id, ['read'], ['memory:shared'],
      ));
      s.policyEngine.addPolicy(allowPolicy(
        'pol-b-mem-read', sessionB.id, ['read'], ['memory:shared'],
      ));

      // Communication policies — bilateral
      s.policyEngine.addPolicy(allowPolicy(
        'pol-a-send', sessionA.id, ['send'], [`communication:agent:${sessionB.id}`],
      ));
      s.policyEngine.addPolicy(allowPolicy(
        'pol-b-recv', sessionB.id, ['receive'], [`communication:agent:${sessionA.id}`],
      ));

      // 3. Agent A writes to memory
      const writeResult = await s.memoryStore.write(sessionA.id, 'shared', 'finding-1', { data: 'important' }, ['tag1']);
      expect(writeResult.success).toBe(true);

      // 4. Agent B reads from memory
      const readResult = await s.memoryStore.read(sessionB.id, 'shared', 'finding-1');
      expect(readResult.found).toBe(true);
      expect(readResult.entry?.value).toEqual({ data: 'important' });
      expect(readResult.entry?.authorAgentId).toBe(sessionA.id);
      expect(readResult.entry?.tags).toEqual(['tag1']);

      // 5. Agent A sends a message to Agent B
      const delivery = await s.communicationBus.sendMessage(
        sessionA.id,
        sessionB.id,
        makePayload({ body: 'Check finding-1 in shared namespace' }),
      );
      expect(delivery.delivered).toBe(true);

      // 6. Verify audit trail contains entries for all operations
      const allAuditEntries = await s.auditLog.query({});
      expect(allAuditEntries.length).toBeGreaterThanOrEqual(4); // session creates + memory write + communication

      // Verify session creation audit entries
      const sessionEntries = await s.auditLog.query({ eventType: 'session_lifecycle' });
      expect(sessionEntries.length).toBeGreaterThanOrEqual(2);

      // Verify memory operation audit entries
      const memoryEntries = await s.auditLog.query({ eventType: 'memory_operation' });
      expect(memoryEntries.length).toBeGreaterThanOrEqual(1);
      expect(memoryEntries.some(e => e.operation === 'write' && e.decision === 'allow')).toBe(true);

      // Verify communication audit entries
      const commEntries = await s.auditLog.query({ eventType: 'communication' });
      expect(commEntries.length).toBeGreaterThanOrEqual(1);
      expect(commEntries.some(e => e.decision === 'allow')).toBe(true);

      // 7. Verify audit sequence numbers are monotonically increasing
      for (let i = 1; i < allAuditEntries.length; i++) {
        expect(allAuditEntries[i].sequenceNumber).toBeGreaterThan(allAuditEntries[i - 1].sequenceNumber);
      }
    });

    it('should deny memory write when policy is missing and log the denial', async () => {
      const manifest = makeManifest({ id: 'manifest-no-write', agentIdentity: 'agent-no-write' });
      const session = await s.sessionManager.createSession(manifest, 'operator-1');

      // No write policy added — default deny
      const writeResult = await s.memoryStore.write(session.id, 'restricted', 'key1', 'value1');
      expect(writeResult.success).toBe(false);

      // Verify denial is in audit log
      const denials = await s.auditLog.query({ eventType: 'memory_operation', decision: 'deny' });
      expect(denials.length).toBeGreaterThanOrEqual(1);
      expect(denials.some(e => e.agentId === session.id && e.operation === 'write')).toBe(true);
    });

    it('should deny communication when sender lacks send policy', async () => {
      const manifestA = makeManifest({ id: 'manifest-sender', agentIdentity: 'sender' });
      const manifestB = makeManifest({ id: 'manifest-receiver', agentIdentity: 'receiver' });

      const sessionA = await s.sessionManager.createSession(manifestA, 'operator-1');
      const sessionB = await s.sessionManager.createSession(manifestB, 'operator-1');

      // No communication policies — default deny
      const delivery = await s.communicationBus.sendMessage(
        sessionA.id,
        sessionB.id,
        makePayload({ body: 'unauthorized message' }),
      );
      expect(delivery.delivered).toBe(false);
      expect(delivery.failureReason).toBeDefined();
    });

    it('should track session termination in audit log', async () => {
      const manifest = makeManifest({ id: 'manifest-term', agentIdentity: 'agent-term' });
      const session = await s.sessionManager.createSession(manifest, 'operator-1');

      const seqBefore = s.auditLog.getSequenceNumber();

      await s.sessionManager.terminateSession(session.id, 'workflow complete');

      const terminated = s.sessionManager.getSession(session.id);
      expect(terminated?.state).toBe('terminated');

      // Verify termination audit entry
      const termEntries = await s.auditLog.query({
        eventType: 'session_lifecycle',
        afterSequence: seqBefore,
      });
      expect(termEntries.some(e => e.operation === 'terminate_session')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent memory writes to the same namespace
  // Validates: Requirements 3.6
  // -------------------------------------------------------------------------

  describe('Concurrent memory writes to the same namespace', () => {
    it('should handle concurrent writes without data loss', async () => {
      const manifest = makeManifest({ id: 'manifest-concurrent', agentIdentity: 'agent-concurrent' });
      const session = await s.sessionManager.createSession(manifest, 'operator-1');

      // Grant write and read permissions
      s.policyEngine.addPolicy(allowPolicy(
        'pol-concurrent-write', session.id, ['write'], ['memory:concurrent-ns'],
      ));
      s.policyEngine.addPolicy(allowPolicy(
        'pol-concurrent-read', session.id, ['read'], ['memory:concurrent-ns'],
      ));

      // Fire 20 concurrent writes to the same namespace with different keys
      const writeCount = 20;
      const writePromises = Array.from({ length: writeCount }, (_, i) =>
        s.memoryStore.write(session.id, 'concurrent-ns', `key-${i}`, `value-${i}`, [`batch`]),
      );

      const results = await Promise.all(writePromises);

      // All writes should succeed
      expect(results.every(r => r.success)).toBe(true);

      // All entries should be readable
      for (let i = 0; i < writeCount; i++) {
        const readResult = await s.memoryStore.read(session.id, 'concurrent-ns', `key-${i}`);
        expect(readResult.found).toBe(true);
        expect(readResult.entry?.value).toBe(`value-${i}`);
      }
    });

    it('should handle concurrent writes to the same key (last-write-wins)', async () => {
      const manifest = makeManifest({ id: 'manifest-same-key', agentIdentity: 'agent-same-key' });
      const session = await s.sessionManager.createSession(manifest, 'operator-1');

      s.policyEngine.addPolicy(allowPolicy(
        'pol-same-key-write', session.id, ['write'], ['memory:same-key-ns'],
      ));
      s.policyEngine.addPolicy(allowPolicy(
        'pol-same-key-read', session.id, ['read'], ['memory:same-key-ns'],
      ));

      // Fire concurrent writes to the same key
      const writePromises = Array.from({ length: 10 }, (_, i) =>
        s.memoryStore.write(session.id, 'same-key-ns', 'shared-key', `value-${i}`),
      );

      const results = await Promise.all(writePromises);
      expect(results.every(r => r.success)).toBe(true);

      // The key should exist with one of the written values
      const readResult = await s.memoryStore.read(session.id, 'same-key-ns', 'shared-key');
      expect(readResult.found).toBe(true);
      expect(typeof readResult.entry?.value).toBe('string');
      expect((readResult.entry?.value as string).startsWith('value-')).toBe(true);
    });

    it('should handle concurrent writes from multiple agents to the same namespace', async () => {
      const agents = ['agent-x', 'agent-y', 'agent-z'];
      const sessions = await Promise.all(
        agents.map((agentId, i) =>
          s.sessionManager.createSession(
            makeManifest({ id: `manifest-${agentId}`, agentIdentity: agentId }),
            'operator-1',
          ),
        ),
      );

      // Grant write and read permissions for all agents
      for (const session of sessions) {
        s.policyEngine.addPolicy(allowPolicy(
          `pol-${session.id}-write`, session.id, ['write'], ['memory:multi-agent-ns'],
        ));
        s.policyEngine.addPolicy(allowPolicy(
          `pol-${session.id}-read`, session.id, ['read'], ['memory:multi-agent-ns'],
        ));
      }

      // Each agent writes 5 entries concurrently
      const allWrites = sessions.flatMap((session, agentIdx) =>
        Array.from({ length: 5 }, (_, keyIdx) =>
          s.memoryStore.write(
            session.id,
            'multi-agent-ns',
            `agent-${agentIdx}-key-${keyIdx}`,
            `data from agent ${agentIdx}`,
          ),
        ),
      );

      const results = await Promise.all(allWrites);
      expect(results.every(r => r.success)).toBe(true);

      // Verify all 15 entries are readable
      for (let agentIdx = 0; agentIdx < sessions.length; agentIdx++) {
        for (let keyIdx = 0; keyIdx < 5; keyIdx++) {
          const readResult = await s.memoryStore.read(
            sessions[agentIdx].id,
            'multi-agent-ns',
            `agent-${agentIdx}-key-${keyIdx}`,
          );
          expect(readResult.found).toBe(true);
          expect(readResult.entry?.authorAgentId).toBe(sessions[agentIdx].id);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // MCP Gateway with mocked external services
  // Validates: Requirements 5.1, 5.2, 5.3, 5.7
  // -------------------------------------------------------------------------

  describe('MCP Gateway with mocked external services', () => {
    const githubService: ServiceConfig = {
      id: 'github',
      name: 'GitHub API',
      endpoint: 'https://api.github.com',
      credentialRef: 'github-token',
      rateLimits: { perAgent: 100, perService: 500, windowMs: 60_000 },
    };

    it('should execute an external service operation through the gateway with policy approval', async () => {
      // Create subsystems with a mock executor
      const mockExecutor: ServiceExecutor = async (_serviceId, operation, params) => {
        return {
          success: true,
          data: { repos: ['repo-1', 'repo-2'], operation, params },
        };
      };

      const sub = createSubsystems({ executor: mockExecutor });

      // Create a session
      const manifest = makeManifest({ id: 'manifest-mcp', agentIdentity: 'agent-mcp' });
      const session = await sub.sessionManager.createSession(manifest, 'operator-1');

      // Register the service
      const regResult = sub.mcpGateway.registerService(githubService);
      expect(regResult.valid).toBe(true);

      // Add policy allowing the agent to use the GitHub service
      sub.policyEngine.addPolicy(allowPolicy(
        'pol-mcp-github', session.id, ['list_repos'], ['mcp:github'],
      ));

      // Execute the operation
      const opResult = await sub.mcpGateway.executeOperation(
        session.id, 'github', 'list_repos', { org: 'test-org' },
      );

      expect(opResult.success).toBe(true);
      expect(opResult.data).toBeDefined();

      // Verify audit trail
      const auditEntries = await sub.auditLog.query({ eventType: 'external_service' });
      expect(auditEntries.some(e => e.decision === 'allow' && e.operation === 'list_repos')).toBe(true);
    });

    it('should deny external service operation when policy is missing', async () => {
      const sub = createSubsystems();

      const manifest = makeManifest({ id: 'manifest-mcp-deny', agentIdentity: 'agent-mcp-deny' });
      const session = await sub.sessionManager.createSession(manifest, 'operator-1');

      sub.mcpGateway.registerService(githubService);

      // No policy added — default deny
      const opResult = await sub.mcpGateway.executeOperation(
        session.id, 'github', 'list_repos', {},
      );

      expect(opResult.success).toBe(false);
      expect(opResult.error?.code).toBe('AUTHZ_DENIED');

      // Verify denial in audit log
      const denials = await sub.auditLog.query({ eventType: 'external_service', decision: 'deny' });
      expect(denials.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle external service failure and record it in audit log', async () => {
      const failingExecutor: ServiceExecutor = async () => {
        throw new Error('Service unavailable: connection timeout');
      };

      const sub = createSubsystems({ executor: failingExecutor });

      const manifest = makeManifest({ id: 'manifest-mcp-fail', agentIdentity: 'agent-mcp-fail' });
      const session = await sub.sessionManager.createSession(manifest, 'operator-1');

      sub.mcpGateway.registerService(githubService);

      // Add policy to allow the operation
      sub.policyEngine.addPolicy(allowPolicy(
        'pol-mcp-fail', session.id, ['create_issue'], ['mcp:github'],
      ));

      const opResult = await sub.mcpGateway.executeOperation(
        session.id, 'github', 'create_issue', { title: 'Bug report' },
      );

      expect(opResult.success).toBe(false);
      expect(opResult.error?.message).toContain('connection timeout');

      // Verify failure recorded in audit log
      const serviceEntries = await sub.auditLog.query({ eventType: 'external_service' });
      expect(serviceEntries.some(e =>
        e.operation === 'create_issue' &&
        (e.details as Record<string, unknown>).success === false,
      )).toBe(true);
    });

    it('should enforce rate limits on external service operations', async () => {
      const countingExecutor: ServiceExecutor = async () => ({
        success: true,
        data: { ok: true },
      });

      const sub = createSubsystems({ executor: countingExecutor });

      const manifest = makeManifest({ id: 'manifest-rate', agentIdentity: 'agent-rate' });
      const session = await sub.sessionManager.createSession(manifest, 'operator-1');

      // Register service with very low rate limit
      const limitedService: ServiceConfig = {
        id: 'limited-svc',
        name: 'Limited Service',
        endpoint: 'https://limited.example.com',
        credentialRef: 'limited-token',
        rateLimits: { perAgent: 3, perService: 100, windowMs: 60_000 },
      };
      sub.mcpGateway.registerService(limitedService);

      // Add policy
      sub.policyEngine.addPolicy(allowPolicy(
        'pol-rate', session.id, ['query'], ['mcp:limited-svc'],
      ));

      // Execute 3 operations (should all succeed)
      for (let i = 0; i < 3; i++) {
        const result = await sub.mcpGateway.executeOperation(session.id, 'limited-svc', 'query', {});
        expect(result.success).toBe(true);
      }

      // 4th operation should be rate-limited
      const rateLimited = await sub.mcpGateway.executeOperation(session.id, 'limited-svc', 'query', {});
      expect(rateLimited.success).toBe(false);
      expect(rateLimited.error?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should integrate session creation, memory, messaging, and MCP gateway in a single workflow', async () => {
      // This test exercises the full cross-subsystem workflow
      const mockExecutor: ServiceExecutor = async (_serviceId, _operation, params) => ({
        success: true,
        data: { result: 'fetched', params },
      });

      const sub = createSubsystems({ executor: mockExecutor });

      // Step 1: Create two sessions
      const manifestA = makeManifest({
        id: 'manifest-full-a',
        agentIdentity: 'full-agent-a',
        memoryNamespaces: [{ namespace: 'research', access: 'readwrite' }],
        communicationChannels: ['results'],
      });
      const manifestB = makeManifest({
        id: 'manifest-full-b',
        agentIdentity: 'full-agent-b',
        memoryNamespaces: [{ namespace: 'research', access: 'read' }],
        communicationChannels: ['results'],
      });

      const sessionA = await sub.sessionManager.createSession(manifestA, 'operator-1');
      const sessionB = await sub.sessionManager.createSession(manifestB, 'operator-1');

      // Step 2: Set up all policies
      sub.policyEngine.addPolicy(allowPolicy('p1', sessionA.id, ['write', 'read'], ['memory:research']));
      sub.policyEngine.addPolicy(allowPolicy('p2', sessionB.id, ['read'], ['memory:research']));
      sub.policyEngine.addPolicy(allowPolicy('p3', sessionA.id, ['send'], [`communication:agent:${sessionB.id}`]));
      sub.policyEngine.addPolicy(allowPolicy('p4', sessionB.id, ['receive'], [`communication:agent:${sessionA.id}`]));
      sub.policyEngine.addPolicy(allowPolicy('p5', sessionA.id, ['fetch_data'], ['mcp:github']));

      // Step 3: Register external service
      sub.mcpGateway.registerService(githubService);

      // Step 4: Agent A fetches data from external service
      const fetchResult = await sub.mcpGateway.executeOperation(
        sessionA.id, 'github', 'fetch_data', { query: 'issues' },
      );
      expect(fetchResult.success).toBe(true);

      // Step 5: Agent A stores the result in memory
      const writeResult = await sub.memoryStore.write(
        sessionA.id, 'research', 'github-data', fetchResult.data, ['github', 'issues'],
      );
      expect(writeResult.success).toBe(true);

      // Step 6: Agent A notifies Agent B
      const delivery = await sub.communicationBus.sendMessage(
        sessionA.id,
        sessionB.id,
        makePayload({ body: 'New data available in research:github-data' }),
      );
      expect(delivery.delivered).toBe(true);

      // Step 7: Agent B reads the data
      const readResult = await sub.memoryStore.read(sessionB.id, 'research', 'github-data');
      expect(readResult.found).toBe(true);
      expect(readResult.entry?.authorAgentId).toBe(sessionA.id);

      // Step 8: Verify comprehensive audit trail
      const allEntries = await sub.auditLog.query({});

      // Should have entries for: 2 session creates + external service + memory write + communication + (no read audit for allowed reads)
      expect(allEntries.length).toBeGreaterThanOrEqual(5);

      // Verify each subsystem produced audit entries
      const eventTypes = new Set(allEntries.map(e => e.eventType));
      expect(eventTypes.has('session_lifecycle')).toBe(true);
      expect(eventTypes.has('external_service')).toBe(true);
      expect(eventTypes.has('memory_operation')).toBe(true);
      expect(eventTypes.has('communication')).toBe(true);

      // Verify monotonic sequence numbers across all entries
      for (let i = 1; i < allEntries.length; i++) {
        expect(allEntries[i].sequenceNumber).toBeGreaterThan(allEntries[i - 1].sequenceNumber);
      }

      // Step 9: Terminate sessions and verify cleanup
      await sub.sessionManager.terminateSession(sessionA.id, 'workflow done');
      await sub.sessionManager.terminateSession(sessionB.id, 'workflow done');

      expect(sub.sessionManager.getSession(sessionA.id)?.state).toBe('terminated');
      expect(sub.sessionManager.getSession(sessionB.id)?.state).toBe('terminated');

      // Verify termination audit entries
      const termEntries = await sub.auditLog.query({ eventType: 'session_lifecycle' });
      const termOps = termEntries.filter(e => e.operation === 'terminate_session');
      expect(termOps.length).toBe(2);
    });
  });
});
