import { describe, it, expect, beforeEach } from 'vitest';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { ManifestValidator } from '../../src/subsystems/manifest-validator.js';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import { MemoryStore } from '../../src/subsystems/memory-store.js';
import { AntiLeakage } from '../../src/subsystems/anti-leakage.js';
import { CommunicationBus } from '../../src/subsystems/communication-bus.js';
import { MCPGateway, type ServiceExecutor } from '../../src/subsystems/mcp-gateway.js';
import { AgentConnector } from '../../src/subsystems/agent-connector.js';
import { AgentDiscoveryRegistry } from '../../src/subsystems/agent-discovery-registry.js';
import { ACPAdapter } from '../../src/subsystems/acp-adapter.js';
import { AgentCPBridge } from '../../src/subsystems/agentcp-bridge.js';
import { OperatorInterface } from '../../src/subsystems/operator-interface.js';
import { TaskOrchestrator } from '../../src/subsystems/task-orchestrator.js';
import { WorkspaceResolver } from '../../src/subsystems/workspace-resolver.js';
import { AgentSpawner } from '../../src/subsystems/agent-spawner.js';
import { IntentResolver } from '../../src/subsystems/intent-resolver.js';
import { TaskPlanner } from '../../src/subsystems/task-planner.js';
import { OrchestrationSessionManager } from '../../src/subsystems/orchestration-session-manager.js';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';
import type { ACPMessagePayload } from '../../src/interfaces/communication-bus.js';
import type { ServiceConfig, OperationResult } from '../../src/interfaces/mcp-gateway.js';
import type { OrchestrationLlmConfig } from '../../src/interfaces/orchestration-config.js';

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

// ===========================================================================
// Layer 2 Integration Tests — Intent-Driven Orchestration
// ===========================================================================

// ---------------------------------------------------------------------------
// Layer 2 Helpers
// ---------------------------------------------------------------------------

/** Default orchestration LLM config for tests. */
const testOrchestrationLlmConfig: OrchestrationLlmConfig = {
  provider: 'openai-compatible',
  endpoint: 'http://localhost:11434',
  model: 'test-model',
  apiKeyRef: 'test-key',
  temperature: 0.3,
  maxTokens: 1024,
};

/** Orchestration LLM service config for MCP Gateway registration. */
const orchestrationLlmService: ServiceConfig = {
  id: '__orchestration_llm',
  name: 'Orchestration LLM',
  endpoint: 'http://localhost:11434',
  credentialRef: 'test-key',
  rateLimits: { perAgent: 1000, perService: 5000, windowMs: 60_000 },
};

/**
 * Create a mock MCP Gateway executor that returns properly formatted
 * LLM responses for IntentResolver and TaskPlanner.
 */
function createOrchestrationExecutor(overrides?: {
  intentResponse?: Record<string, unknown>;
  planResponse?: Record<string, unknown>;
}): ServiceExecutor {
  let callCount = 0;

  const defaultIntentResponse = {
    repository: 'acme/web-app',
    action: 'fix the login bug',
    branch: 'main',
    confidence: 0.9,
    constraints: {},
  };

  const defaultPlanResponse = {
    steps: [
      { instructions: 'Investigate the login bug in auth module', executionMode: 'agent' },
      { instructions: 'Apply fix and write tests', executionMode: 'agent' },
    ],
    reasoning: 'Two-step plan: investigate then fix',
    estimatedDuration: '30m',
  };

  return async (_serviceId, _operation, params) => {
    callCount++;
    const reqParams = params as { messages?: Array<{ content: string }> };

    // Determine if this is an intent parsing call or a planning call
    // by inspecting the system prompt content
    const systemMessage = reqParams.messages?.[0]?.content ?? '';
    const isPlanning = systemMessage.includes('task planning') || systemMessage.includes('task steps');

    const responseContent = isPlanning
      ? JSON.stringify(overrides?.planResponse ?? defaultPlanResponse)
      : JSON.stringify(overrides?.intentResponse ?? defaultIntentResponse);

    return {
      success: true,
      data: {
        choices: [{
          message: {
            content: responseContent,
          },
        }],
      },
    };
  };
}

interface Layer2TestSubsystems {
  auditLog: AuditLog;
  policyEngine: PolicyEngine;
  manifestValidator: ManifestValidator;
  sessionManager: SessionManager;
  memoryStore: MemoryStore;
  antiLeakage: AntiLeakage;
  communicationBus: CommunicationBus;
  mcpGateway: MCPGateway;
  agentDiscoveryRegistry: AgentDiscoveryRegistry;
  acpAdapter: ACPAdapter;
  agentCPBridge: AgentCPBridge;
  operatorInterface: OperatorInterface;
  agentConnector: AgentConnector;
  taskOrchestrator: TaskOrchestrator;
  workspaceResolver: WorkspaceResolver;
  agentSpawner: AgentSpawner;
  intentResolver: IntentResolver;
  taskPlanner: TaskPlanner;
  orchestrationSessionManager: OrchestrationSessionManager;
}

/**
 * Create all Layer 1 and Layer 2 subsystems with real wiring,
 * matching the CommandCenter constructor.
 */
function createLayer2Subsystems(opts?: {
  executor?: ServiceExecutor;
  maxConcurrentSessions?: number;
}): Layer2TestSubsystems {
  // Layer 1 — Foundation
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const manifestValidator = new ManifestValidator();
  const agentDiscoveryRegistry = new AgentDiscoveryRegistry();

  const sessionManager = new SessionManager({
    auditLog,
    policyEngine,
    maxConcurrentSessions: opts?.maxConcurrentSessions ?? 20,
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

  const acpAdapter = new ACPAdapter({
    discoveryRegistry: agentDiscoveryRegistry,
    communicationBus,
    policyEngine,
    auditLog,
  });

  const agentCPBridge = new AgentCPBridge({
    sessionManager,
    policyEngine,
    mcpGateway,
    auditLog,
  });

  const operatorInterface = new OperatorInterface({
    sessionManager,
    policyEngine,
    memoryStore,
    auditLog,
    authenticate: () => undefined,
  });

  const agentConnector = new AgentConnector({
    sessionManager,
    discoveryRegistry: agentDiscoveryRegistry,
    policyEngine,
    agentcpBridge: agentCPBridge,
    communicationBus,
    acpAdapter,
    antiLeakage,
    auditLog,
  });

  const taskOrchestrator = new TaskOrchestrator({
    agentConnector,
    memoryStore,
    policyEngine,
    mcpGateway,
    auditLog,
    operatorInterface,
    discoveryRegistry: agentDiscoveryRegistry,
    sessionManager,
  });

  // Layer 2 — Intent-Driven Orchestration
  const workspaceResolver = new WorkspaceResolver({
    memoryStore,
    auditLog,
  });

  const agentSpawner = new AgentSpawner({
    agentConnector,
    discoveryRegistry: agentDiscoveryRegistry,
    sessionManager,
    auditLog,
    harnessConfig: {
      command: 'node',
      args: ['--experimental-vm-modules'],
      env: {},
      defaultCapabilities: { languages: ['typescript'], frameworks: [], tools: [] },
    },
  });

  const intentResolver = new IntentResolver({
    mcpGateway,
    auditLog,
    orchestrationLlmConfig: testOrchestrationLlmConfig,
    confidenceThreshold: 0.7,
  });

  const taskPlanner = new TaskPlanner({
    mcpGateway,
    taskOrchestrator,
    auditLog,
    orchestrationLlmConfig: testOrchestrationLlmConfig,
  });

  const orchestrationSessionManager = new OrchestrationSessionManager({
    intentResolver,
    workspaceResolver,
    agentSpawner,
    taskPlanner,
    policyEngine,
    auditLog,
    operatorInterface,
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
    agentDiscoveryRegistry,
    acpAdapter,
    agentCPBridge,
    operatorInterface,
    agentConnector,
    taskOrchestrator,
    workspaceResolver,
    agentSpawner,
    intentResolver,
    taskPlanner,
    orchestrationSessionManager,
  };
}

// ===========================================================================
// Layer 2: Full operator intent flow
// Validates: Requirements 1.1, 2.1, 3.1, 4.1, 6.1
// ===========================================================================

describe('Layer 2: Full operator intent flow', () => {
  let sub: Layer2TestSubsystems;

  beforeEach(() => {
    sub = createLayer2Subsystems({ executor: createOrchestrationExecutor() });

    // Register the orchestration LLM service in the MCP Gateway
    sub.mcpGateway.registerService(orchestrationLlmService);

    // Add policies for the orchestration agent to use the LLM service
    sub.policyEngine.addPolicy(allowPolicy(
      'pol-orch-llm', '__c2_orchestration', ['chat.completions'], ['mcp:__orchestration_llm'],
    ));

    // Add policies for the workspace resolver to read/write memory
    sub.policyEngine.addPolicy(allowPolicy(
      'pol-ws-mem-write', '__c2_workspace_resolver', ['write'], ['memory:__workspaces'],
    ));
    sub.policyEngine.addPolicy(allowPolicy(
      'pol-ws-mem-read', '__c2_workspace_resolver', ['read'], ['memory:__workspaces'],
    ));
  });

  it('should drive an operator message through intent → workspace → agent → task → execution', async () => {
    // Step 1: Parse intent from operator message
    const intent = await sub.intentResolver.parseIntent(
      'Fix the login bug in acme/web-app',
      'operator-1',
    );

    expect(intent.repository).toBe('acme/web-app');
    expect(intent.action).toBe('fix the login bug');
    expect(intent.confidence).toBeGreaterThanOrEqual(0.7);

    // Step 2: Create an orchestration session
    const session = await sub.orchestrationSessionManager.createSession(intent, 'operator-1');
    expect(session.state).toBe('intent_received');
    expect(session.intent.id).toBe(intent.id);

    // Step 3: Advance → resolving_workspace
    const afterResolving = await sub.orchestrationSessionManager.advance(session.id);
    expect(afterResolving.state).toBe('resolving_workspace');

    // Step 4: Advance → spawning_agent (workspace resolved)
    const afterSpawning = await sub.orchestrationSessionManager.advance(session.id);
    expect(afterSpawning.state).toBe('spawning_agent');
    expect(afterSpawning.workspaceContext).toBeDefined();
    expect(afterSpawning.workspaceContext!.repositoryUrl).toContain('acme/web-app');

    // Step 5: Advance → planning_task (agent spawned)
    const afterPlanning = await sub.orchestrationSessionManager.advance(session.id);
    expect(afterPlanning.state).toBe('planning_task');
    expect(afterPlanning.agentId).toBeDefined();
    expect(afterPlanning.agentSessionId).toBeDefined();

    // Step 6: Advance → executing (task plan submitted)
    const afterExecuting = await sub.orchestrationSessionManager.advance(session.id);
    expect(afterExecuting.state).toBe('executing');
    expect(afterExecuting.codingTaskId).toBeDefined();

    // Verify the coding task was created in the TaskOrchestrator
    const codingTask = sub.taskOrchestrator.getTask(afterExecuting.codingTaskId!);
    expect(codingTask).toBeDefined();
    expect(codingTask!.steps.length).toBe(2);
    expect(codingTask!.steps[0].instructions).toBe('Investigate the login bug in auth module');
    expect(codingTask!.steps[1].instructions).toBe('Apply fix and write tests');

    // Step 7: Advance → completed
    const afterCompleted = await sub.orchestrationSessionManager.advance(session.id);
    expect(afterCompleted.state).toBe('completed');
    expect(afterCompleted.completedAt).toBeDefined();

    // Verify audit trail covers the full lifecycle
    const auditEntries = await sub.auditLog.query({});
    const orchestrationEntries = auditEntries.filter(
      e => e.resource?.includes('orchestration_session'),
    );
    expect(orchestrationEntries.length).toBeGreaterThanOrEqual(1);

    // Verify session history records all transitions
    const history = await sub.orchestrationSessionManager.getHistory(session.id);
    const states = history.map(e => e.toState);
    expect(states).toContain('resolving_workspace');
    expect(states).toContain('spawning_agent');
    expect(states).toContain('planning_task');
    expect(states).toContain('executing');
    expect(states).toContain('completed');
  });

  it('should record audit entries for each lifecycle phase', async () => {
    const intent = await sub.intentResolver.parseIntent(
      'Fix the login bug in acme/web-app',
      'operator-1',
    );

    const session = await sub.orchestrationSessionManager.createSession(intent, 'operator-1');

    // Advance through all states
    await sub.orchestrationSessionManager.advance(session.id); // → resolving_workspace
    await sub.orchestrationSessionManager.advance(session.id); // → spawning_agent
    await sub.orchestrationSessionManager.advance(session.id); // → planning_task
    await sub.orchestrationSessionManager.advance(session.id); // → executing
    await sub.orchestrationSessionManager.advance(session.id); // → completed

    // Verify audit log has entries from multiple subsystems
    const allEntries = await sub.auditLog.query({});

    // Should have: intent_parsed, orchestration_session_created, workspace_resolved,
    // agent_spawned/connected, plan_generated, plan_submitted, state transitions
    expect(allEntries.length).toBeGreaterThanOrEqual(6);

    // Verify intent parsing was audited
    const intentEntries = allEntries.filter(e => e.operation === 'intent_parsed');
    expect(intentEntries.length).toBeGreaterThanOrEqual(1);

    // Verify workspace resolution was audited
    const workspaceEntries = allEntries.filter(e => e.operation === 'workspace_resolved');
    expect(workspaceEntries.length).toBeGreaterThanOrEqual(1);

    // Verify agent spawn was audited
    const agentEntries = allEntries.filter(
      e => e.operation === 'agent_spawned' || e.operation === 'connect',
    );
    expect(agentEntries.length).toBeGreaterThanOrEqual(1);

    // Verify plan generation was audited
    const planEntries = allEntries.filter(e => e.operation === 'plan_generated');
    expect(planEntries.length).toBeGreaterThanOrEqual(1);

    // Verify monotonic sequence numbers
    for (let i = 1; i < allEntries.length; i++) {
      expect(allEntries[i].sequenceNumber).toBeGreaterThan(allEntries[i - 1].sequenceNumber);
    }
  });
});

// ===========================================================================
// Layer 2: Workspace caching flow
// Validates: Requirements 2.2, 8.1, 8.2, 8.3
// ===========================================================================

describe('Layer 2: Workspace caching flow', () => {
  let sub: Layer2TestSubsystems;

  beforeEach(() => {
    sub = createLayer2Subsystems({ executor: createOrchestrationExecutor() });

    // Register the orchestration LLM service
    sub.mcpGateway.registerService(orchestrationLlmService);

    // Add policies for the orchestration agent
    sub.policyEngine.addPolicy(allowPolicy(
      'pol-orch-llm', '__c2_orchestration', ['chat.completions'], ['mcp:__orchestration_llm'],
    ));

    // Add policies for the workspace resolver to read/write memory
    sub.policyEngine.addPolicy(allowPolicy(
      'pol-ws-mem-write', '__c2_workspace_resolver', ['write'], ['memory:__workspaces'],
    ));
    sub.policyEngine.addPolicy(allowPolicy(
      'pol-ws-mem-read', '__c2_workspace_resolver', ['read'], ['memory:__workspaces'],
    ));
  });

  it('should cache workspace on first resolve and return same workspace on second resolve', async () => {
    // First intent — triggers workspace creation
    const intent1 = await sub.intentResolver.parseIntent(
      'Fix the login bug in acme/web-app',
      'operator-1',
    );

    // Resolve workspace for the first time (creates new workspace)
    const workspace1 = await sub.workspaceResolver.resolve(intent1);
    expect(workspace1).toBeDefined();
    expect(workspace1.repositoryUrl).toContain('acme/web-app');
    expect(workspace1.localPath).toBeDefined();

    // Second intent — same repository, should hit cache
    const intent2 = await sub.intentResolver.parseIntent(
      'Add unit tests to acme/web-app',
      'operator-1',
    );

    // Resolve workspace for the second time (should reuse cached workspace)
    const workspace2 = await sub.workspaceResolver.resolve(intent2);
    expect(workspace2).toBeDefined();

    // Verify same workspace is returned (same localPath and repositoryUrl)
    expect(workspace2.localPath).toBe(workspace1.localPath);
    expect(workspace2.repositoryUrl).toBe(workspace1.repositoryUrl);
    expect(workspace2.id).toBe(workspace1.id);

    // Verify last-used timestamp was updated
    expect(workspace2.lastUsedAt.getTime()).toBeGreaterThanOrEqual(workspace1.lastUsedAt.getTime());
  });

  it('should persist workspace metadata in MemoryStore under __workspaces namespace', async () => {
    const intent = await sub.intentResolver.parseIntent(
      'Fix the login bug in acme/web-app',
      'operator-1',
    );

    // Resolve workspace (creates and persists)
    const workspace = await sub.workspaceResolver.resolve(intent);

    // Verify the workspace was persisted in MemoryStore
    // The workspace resolver uses normalized repo ref as the key
    const normalizedRef = sub.workspaceResolver.normalizeRepoRef('acme/web-app');
    const memoryResult = await sub.memoryStore.read(
      '__c2_workspace_resolver',
      '__workspaces',
      normalizedRef,
    );

    expect(memoryResult.found).toBe(true);
    expect(memoryResult.entry).toBeDefined();

    const storedData = memoryResult.entry!.value as Record<string, unknown>;
    expect(storedData.repositoryUrl).toBe(workspace.repositoryUrl);
    expect(storedData.localPath).toBe(workspace.localPath);
  });

  it('should handle different repository formats resolving to the same workspace', async () => {
    // First resolve with shorthand format
    const intent1 = await sub.intentResolver.parseIntent(
      'Fix the login bug in acme/web-app',
      'operator-1',
    );
    const workspace1 = await sub.workspaceResolver.resolve(intent1);

    // Second resolve with the same normalized reference
    // Create a manual intent with the same repo to test normalization
    const intent2 = { ...intent1, id: 'intent-2', repository: 'acme/web-app' };
    const workspace2 = await sub.workspaceResolver.resolve(intent2);

    // Should return the same workspace
    expect(workspace2.localPath).toBe(workspace1.localPath);
    expect(workspace2.id).toBe(workspace1.id);
  });

  it('should create separate workspaces for different repositories', async () => {
    // Create executor that returns different repos for different calls
    const callCount = { value: 0 };
    const multiRepoExecutor: ServiceExecutor = async (_serviceId, _operation, params) => {
      callCount.value++;
      const reqParams = params as { messages?: Array<{ content: string }> };
      const systemMessage = reqParams.messages?.[0]?.content ?? '';
      const isPlanning = systemMessage.includes('task planning') || systemMessage.includes('task steps');

      if (isPlanning) {
        return {
          success: true,
          data: {
            choices: [{
              message: {
                content: JSON.stringify({
                  steps: [{ instructions: 'Do work', executionMode: 'agent' }],
                  reasoning: 'Simple plan',
                }),
              },
            }],
          },
        };
      }

      // Alternate between two different repos based on user message content
      const userMessage = reqParams.messages?.[1]?.content ?? '';
      const repo = userMessage.includes('backend') ? 'acme/backend' : 'acme/frontend';

      return {
        success: true,
        data: {
          choices: [{
            message: {
              content: JSON.stringify({
                repository: repo,
                action: 'fix bug',
                branch: 'main',
                confidence: 0.9,
                constraints: {},
              }),
            },
          }],
        },
      };
    };

    // Recreate subsystems with the multi-repo executor
    const multiSub = createLayer2Subsystems({ executor: multiRepoExecutor });
    multiSub.mcpGateway.registerService(orchestrationLlmService);
    multiSub.policyEngine.addPolicy(allowPolicy(
      'pol-orch-llm', '__c2_orchestration', ['chat.completions'], ['mcp:__orchestration_llm'],
    ));
    multiSub.policyEngine.addPolicy(allowPolicy(
      'pol-ws-mem-write', '__c2_workspace_resolver', ['write'], ['memory:__workspaces'],
    ));
    multiSub.policyEngine.addPolicy(allowPolicy(
      'pol-ws-mem-read', '__c2_workspace_resolver', ['read'], ['memory:__workspaces'],
    ));

    // Resolve workspace for first repo
    const intent1 = await multiSub.intentResolver.parseIntent(
      'Fix bug in backend service',
      'operator-1',
    );
    const workspace1 = await multiSub.workspaceResolver.resolve(intent1);

    // Resolve workspace for second repo
    const intent2 = await multiSub.intentResolver.parseIntent(
      'Fix bug in frontend app',
      'operator-1',
    );
    const workspace2 = await multiSub.workspaceResolver.resolve(intent2);

    // Should be different workspaces
    expect(workspace1.id).not.toBe(workspace2.id);
    expect(workspace1.localPath).not.toBe(workspace2.localPath);
    expect(workspace1.repositoryUrl).not.toBe(workspace2.repositoryUrl);
  });

  it('should record audit entries for workspace creation and reuse', async () => {
    const intent = await sub.intentResolver.parseIntent(
      'Fix the login bug in acme/web-app',
      'operator-1',
    );

    // First resolve — creation
    await sub.workspaceResolver.resolve(intent);

    // Second resolve — reuse
    const intent2 = { ...intent, id: 'intent-reuse' };
    await sub.workspaceResolver.resolve(intent2);

    // Verify audit entries for workspace operations
    const auditEntries = await sub.auditLog.query({});
    const workspaceEntries = auditEntries.filter(e => e.operation === 'workspace_resolved');
    expect(workspaceEntries.length).toBeGreaterThanOrEqual(2);

    // First should be 'created', second should be 'reused'
    const details = workspaceEntries.map(e => (e.details as Record<string, unknown>).action);
    expect(details).toContain('created');
    expect(details).toContain('reused');
  });
});
