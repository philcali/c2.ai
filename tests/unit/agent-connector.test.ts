import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentConnector } from '../../src/subsystems/agent-connector.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import { AgentDiscoveryRegistry } from '../../src/subsystems/agent-discovery-registry.js';
import { AgentCPBridge } from '../../src/subsystems/agentcp-bridge.js';
import { CommunicationBus } from '../../src/subsystems/communication-bus.js';
import { ACPAdapter } from '../../src/subsystems/acp-adapter.js';
import { AntiLeakage } from '../../src/subsystems/anti-leakage.js';
import { MCPGateway } from '../../src/subsystems/mcp-gateway.js';
import type { AgentConnectionConfig, AgentEvent, ExternalEventSourceConfig } from '../../src/interfaces/agent-connector.js';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';
import type { TaskContext } from '../../src/interfaces/task-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    id: 'agent-alpha',
    agentIdentity: 'Alpha Agent',
    description: 'A test coding agent',
    memoryNamespaces: [{ namespace: 'notes', access: 'readwrite' }],
    communicationChannels: ['general'],
    mcpOperations: [{ serviceId: 'github', operations: ['read_repo'] }],
    ...overrides,
  };
}

function makeConnectionConfig(
  overrides?: Partial<AgentConnectionConfig>,
): AgentConnectionConfig {
  return {
    agentId: 'agent-alpha',
    protocol: 'process-spawn',
    manifest: validManifest(),
    operatorId: 'operator-1',
    connectionParams: { command: 'node', args: ['agent.js'] },
    ...overrides,
  };
}

function makeTaskContext(overrides?: Partial<TaskContext>): TaskContext {
  return {
    taskId: 'task-1',
    stepId: 'step-1',
    instructions: 'Implement the feature',
    isolationBoundary: {
      allowedNamespaces: ['notes'],
      allowedChannels: ['general'],
      allowedServices: ['github'],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AgentConnector', () => {
  let auditLog: AuditLog;
  let policyEngine: PolicyEngine;
  let sessionManager: SessionManager;
  let discoveryRegistry: AgentDiscoveryRegistry;
  let agentcpBridge: AgentCPBridge;
  let communicationBus: CommunicationBus;
  let acpAdapter: ACPAdapter;
  let antiLeakage: AntiLeakage;
  let connector: AgentConnector;

  beforeEach(() => {
    auditLog = new AuditLog();
    policyEngine = new PolicyEngine();
    antiLeakage = new AntiLeakage({ policyEngine });
    sessionManager = new SessionManager({
      auditLog,
      policyEngine,
      maxConcurrentSessions: 20,
    });
    discoveryRegistry = new AgentDiscoveryRegistry();
    const mcpGateway = new MCPGateway({ policyEngine, auditLog, antiLeakage });
    agentcpBridge = new AgentCPBridge({
      sessionManager,
      policyEngine,
      mcpGateway,
      auditLog,
    });
    communicationBus = new CommunicationBus({
      policyEngine,
      antiLeakage,
      auditLog,
      sessionManager,
    });
    acpAdapter = new ACPAdapter({
      discoveryRegistry,
      communicationBus,
      policyEngine,
      auditLog,
    });

    connector = new AgentConnector({
      sessionManager,
      discoveryRegistry,
      policyEngine,
      agentcpBridge,
      communicationBus,
      acpAdapter,
      antiLeakage,
      auditLog,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ----------------------------------------------------------------
  // 1. Connection establishment
  // ----------------------------------------------------------------

  describe('connection establishment', () => {
    it('should connect a process-spawn agent and return ConnectedAgent', async () => {
      const config = makeConnectionConfig({ protocol: 'process-spawn' });
      const agent = await connector.connect(config);

      expect(agent.agentId).toBe('agent-alpha');
      expect(agent.protocol).toBe('process-spawn');
      expect(agent.healthStatus).toBe('healthy');
      expect(agent.sessionId).toBeTruthy();
      expect(agent.connectedAt).toBeInstanceOf(Date);
      expect(agent.lastHeartbeat).toBeInstanceOf(Date);
    });

    it('should connect a WebSocket agent', async () => {
      const config = makeConnectionConfig({
        agentId: 'ws-agent',
        protocol: 'websocket',
        manifest: validManifest({ id: 'ws-agent', agentIdentity: 'WS Agent' }),
        connectionParams: { url: 'ws://localhost:8080' },
      });
      const agent = await connector.connect(config);

      expect(agent.agentId).toBe('ws-agent');
      expect(agent.protocol).toBe('websocket');
      expect(agent.healthStatus).toBe('healthy');
    });

    it('should connect an ACP REST agent', async () => {
      const config = makeConnectionConfig({
        agentId: 'acp-agent',
        protocol: 'acp-rest',
        manifest: validManifest({
          id: 'acp-agent',
          agentIdentity: 'ACP Agent',
          agentCard: {
            name: 'ACP Agent',
            description: 'An ACP agent',
            url: 'https://agent.example.com',
            version: '1.0.0',
            capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
            skills: [{ id: 'skill-1', name: 'Code', description: 'Writes code' }],
            defaultInputContentTypes: ['application/json'],
            defaultOutputContentTypes: ['application/json'],
          },
        }),
        connectionParams: { agentUrl: 'https://agent.example.com' },
      });
      const agent = await connector.connect(config);

      expect(agent.agentId).toBe('acp-agent');
      expect(agent.protocol).toBe('acp-rest');
      expect(agent.healthStatus).toBe('healthy');
    });

    it('should create an Agent_Session in the SessionManager', async () => {
      const config = makeConnectionConfig();
      const agent = await connector.connect(config);

      const session = sessionManager.getSession(agent.sessionId);
      expect(session).toBeDefined();
      expect(session!.state).toBe('running');
    });

    it('should register capabilities in the AgentDiscoveryRegistry', async () => {
      const config = makeConnectionConfig();
      await connector.connect(config);

      const card = discoveryRegistry.getCard('agent://agent-alpha');
      expect(card).toBeDefined();
      expect(card!.name).toBe('Alpha Agent');
    });

    it('should record connection in the AuditLog', async () => {
      const config = makeConnectionConfig();
      await connector.connect(config);

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const connectEntry = entries.find((e) => e.operation === 'connect');
      expect(connectEntry).toBeDefined();
      expect(connectEntry!.agentId).toBe('agent-alpha');
    });

    it('should derive isolation boundary from manifest', async () => {
      const config = makeConnectionConfig({
        manifest: validManifest({
          memoryNamespaces: [
            { namespace: 'notes', access: 'read' },
            { namespace: 'research', access: 'write' },
          ],
          communicationChannels: ['general', 'alerts'],
          mcpOperations: [
            { serviceId: 'github', operations: ['read_repo'] },
            { serviceId: 'slack', operations: ['post_message'] },
          ],
        }),
      });
      await connector.connect(config);

      const boundary = connector.getIsolationBoundary('agent-alpha');
      expect(boundary).toBeDefined();
      expect(boundary!.allowedNamespaces).toEqual(['notes', 'research']);
      expect(boundary!.allowedChannels).toEqual(['general', 'alerts']);
      expect(boundary!.allowedServices).toEqual(['github', 'slack']);
    });
  });

  // ----------------------------------------------------------------
  // 2. Connection validation errors
  // ----------------------------------------------------------------

  describe('connection validation errors', () => {
    it('should reject connection with empty agentId', async () => {
      const config = makeConnectionConfig({ agentId: '' });
      await expect(connector.connect(config)).rejects.toThrow('agentId is required');
    });

    it('should reject duplicate connection for same agentId', async () => {
      await connector.connect(makeConnectionConfig());
      await expect(connector.connect(makeConnectionConfig())).rejects.toThrow(
        "Agent 'agent-alpha' is already connected",
      );
    });
  });

  // ----------------------------------------------------------------
  // 3. Disconnection cleanup
  // ----------------------------------------------------------------

  describe('disconnection cleanup', () => {
    it('should remove agent from connected agents', async () => {
      await connector.connect(makeConnectionConfig());
      expect(connector.getAgent('agent-alpha')).toBeDefined();

      await connector.disconnect('agent-alpha', 'test cleanup');
      expect(connector.getAgent('agent-alpha')).toBeUndefined();
    });

    it('should terminate the Agent_Session', async () => {
      const agent = await connector.connect(makeConnectionConfig());
      await connector.disconnect('agent-alpha', 'test cleanup');

      const session = sessionManager.getSession(agent.sessionId);
      expect(session?.state).toBe('terminated');
    });

    it('should deregister from AgentDiscoveryRegistry', async () => {
      await connector.connect(makeConnectionConfig());
      expect(discoveryRegistry.getCard('agent://agent-alpha')).toBeDefined();

      await connector.disconnect('agent-alpha', 'test cleanup');
      expect(discoveryRegistry.getCard('agent://agent-alpha')).toBeUndefined();
    });

    it('should record disconnection in AuditLog', async () => {
      await connector.connect(makeConnectionConfig());
      await connector.disconnect('agent-alpha', 'operator requested');

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const disconnectEntry = entries.find((e) => e.operation === 'disconnect');
      expect(disconnectEntry).toBeDefined();
      expect(disconnectEntry!.details).toHaveProperty('reason', 'operator requested');
    });

    it('should emit disconnected event', async () => {
      const events: AgentEvent[] = [];
      connector.onAgentEvent((e) => events.push(e));

      await connector.connect(makeConnectionConfig());
      await connector.disconnect('agent-alpha', 'done');

      const disconnectedEvent = events.find((e) => e.type === 'disconnected');
      expect(disconnectedEvent).toBeDefined();
      expect(disconnectedEvent!.agentId).toBe('agent-alpha');
    });

    it('should remove isolation boundary on disconnect', async () => {
      await connector.connect(makeConnectionConfig());
      expect(connector.getIsolationBoundary('agent-alpha')).toBeDefined();

      await connector.disconnect('agent-alpha', 'cleanup');
      expect(connector.getIsolationBoundary('agent-alpha')).toBeUndefined();
    });

    it('should throw when disconnecting a non-connected agent', async () => {
      await expect(connector.disconnect('unknown', 'test')).rejects.toThrow(
        "Agent 'unknown' is not connected",
      );
    });
  });

  // ----------------------------------------------------------------
  // 4. Heartbeat monitoring and health state machine
  // ----------------------------------------------------------------

  describe('heartbeat monitoring and health state machine', () => {
    it('should transition healthy → degraded after 1 missed heartbeat', async () => {
      vi.useFakeTimers();
      const events: AgentEvent[] = [];
      connector.onAgentEvent((e) => events.push(e));

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 3,
      });
      await connector.connect(config);

      // Advance past one heartbeat interval
      vi.advanceTimersByTime(1000);

      const agent = connector.getAgent('agent-alpha');
      expect(agent!.healthStatus).toBe('degraded');

      const healthEvent = events.find(
        (e) => e.type === 'health_change' && (e.data as Record<string, unknown>).newStatus === 'degraded',
      );
      expect(healthEvent).toBeDefined();
    });

    it('should transition degraded → unresponsive after timeout count exceeded', async () => {
      vi.useFakeTimers();
      const events: AgentEvent[] = [];
      connector.onAgentEvent((e) => events.push(e));

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 3,
      });
      await connector.connect(config);

      // Advance past 3 heartbeat intervals (1 → degraded, 2 more → unresponsive at count 3)
      vi.advanceTimersByTime(3000);

      const agent = connector.getAgent('agent-alpha');
      expect(agent!.healthStatus).toBe('unresponsive');

      const timeoutEvent = events.find((e) => e.type === 'heartbeat_timeout');
      expect(timeoutEvent).toBeDefined();
    });

    it('should recover degraded → healthy when heartbeat is received', async () => {
      vi.useFakeTimers();
      const events: AgentEvent[] = [];
      connector.onAgentEvent((e) => events.push(e));

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 3,
      });
      await connector.connect(config);

      // Miss one heartbeat → degraded
      vi.advanceTimersByTime(1000);
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('degraded');

      // Record heartbeat → should recover to healthy
      connector.recordHeartbeat('agent-alpha');
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('healthy');

      const recoveryEvent = events.find(
        (e) =>
          e.type === 'health_change' &&
          (e.data as Record<string, unknown>).previousStatus === 'degraded' &&
          (e.data as Record<string, unknown>).newStatus === 'healthy',
      );
      expect(recoveryEvent).toBeDefined();
    });

    it('should recover unresponsive → healthy when heartbeat is received', async () => {
      vi.useFakeTimers();

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 3,
        maxReconnectAttempts: 5,
      });
      await connector.connect(config);

      // Miss enough heartbeats to become unresponsive
      vi.advanceTimersByTime(3000);
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('unresponsive');

      // Record heartbeat → should recover to healthy
      connector.recordHeartbeat('agent-alpha');
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('healthy');
    });

    it('should not affect unknown agent on recordHeartbeat', () => {
      // Should not throw
      connector.recordHeartbeat('nonexistent-agent');
    });

    it('should stop heartbeat monitoring on disconnect', async () => {
      vi.useFakeTimers();

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 3,
      });
      await connector.connect(config);
      await connector.disconnect('agent-alpha', 'done');

      // Advance timers — should not throw or affect anything
      vi.advanceTimersByTime(5000);
      expect(connector.getAgent('agent-alpha')).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // 5. Reconnection attempt counting
  // ----------------------------------------------------------------

  describe('reconnection attempt counting', () => {
    it('should disconnect agent after max reconnection attempts exhausted', async () => {
      vi.useFakeTimers();
      const events: AgentEvent[] = [];
      connector.onAgentEvent((e) => events.push(e));

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 2,
        maxReconnectAttempts: 2,
      });
      await connector.connect(config);

      // Tick 1: missed=1, healthy → degraded
      await vi.advanceTimersByTimeAsync(1000);
      // Tick 2: missed=2, degraded → unresponsive, attempt 1
      await vi.advanceTimersByTimeAsync(1000);
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('unresponsive');

      // Tick 3: still unresponsive, attempt 2
      await vi.advanceTimersByTimeAsync(1000);
      // Tick 4: still unresponsive, attempt 3 > max(2) → cleanup
      await vi.advanceTimersByTimeAsync(1000);

      // Agent should be cleaned up
      expect(connector.getAgent('agent-alpha')).toBeUndefined();

      const disconnectedEvent = events.find((e) => e.type === 'disconnected');
      expect(disconnectedEvent).toBeDefined();
      expect((disconnectedEvent!.data as Record<string, unknown>).reason).toContain(
        'Reconnection failed',
      );
    });

    it('should record reconnection failure in AuditLog', async () => {
      vi.useFakeTimers();

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 2,
        maxReconnectAttempts: 1,
      });
      await connector.connect(config);

      // Miss 2 → unresponsive (attempt 1), tick again → attempt 2 > max → disconnect
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(1000);

      // Allow async audit log records to settle
      await vi.advanceTimersByTimeAsync(0);

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const reconnectFailed = entries.find((e) => e.operation === 'reconnection_failed');
      expect(reconnectFailed).toBeDefined();
    });

    it('should reset reconnect counter when heartbeat is received', async () => {
      vi.useFakeTimers();

      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 2,
        maxReconnectAttempts: 3,
      });
      await connector.connect(config);

      // Miss 2 → unresponsive, attempt 1
      vi.advanceTimersByTime(2000);
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('unresponsive');

      // Heartbeat received → resets counters
      connector.recordHeartbeat('agent-alpha');
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('healthy');

      // Miss 2 again → unresponsive, attempt 1 (counter was reset)
      vi.advanceTimersByTime(2000);
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('unresponsive');

      // Still connected because reconnect counter was reset
      expect(connector.getAgent('agent-alpha')).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // 6. Multi-protocol dispatch
  // ----------------------------------------------------------------

  describe('multi-protocol dispatch', () => {
    it('should dispatch via AgentCP Bridge for process-spawn agent', async () => {
      vi.useFakeTimers();
      const config = makeConnectionConfig({ protocol: 'process-spawn' });
      const agent = await connector.connect(config);

      // The AgentCP Bridge needs an active session matching agent.sessionId.
      // Since we don't have a real process, the dispatch will fail because
      // listSessions() won't find a matching active session.
      const result = await connector.dispatchStep('agent-alpha', makeTaskContext());

      // Expected to fail because no AgentCP session exists
      expect(result.success).toBe(false);
      expect(result.error).toContain('No active AgentCP session');
    });

    it('should dispatch via CommunicationBus for websocket agent', async () => {
      vi.useFakeTimers();
      const config = makeConnectionConfig({
        agentId: 'ws-agent',
        protocol: 'websocket',
        manifest: validManifest({ id: 'ws-agent', agentIdentity: 'WS Agent' }),
        connectionParams: { url: 'ws://localhost:8080' },
      });
      await connector.connect(config);

      // CommunicationBus requires policies and active session for the recipient.
      // Without them, delivery will fail.
      const result = await connector.dispatchStep('ws-agent', makeTaskContext());

      // Expected to fail because no allow policy or active session for ws-agent
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should dispatch via ACPAdapter for acp-rest agent', async () => {
      vi.useFakeTimers();
      const config = makeConnectionConfig({
        agentId: 'acp-agent',
        protocol: 'acp-rest',
        manifest: validManifest({ id: 'acp-agent', agentIdentity: 'ACP Agent' }),
        connectionParams: { agentUrl: 'https://agent.example.com' },
      });
      await connector.connect(config);

      // ACPAdapter.submitTask requires the target agent to be registered
      // and policy authorization. The agent card is registered by connect(),
      // but policy will deny by default.
      const result = await connector.dispatchStep('acp-agent', makeTaskContext());

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should return failure for dispatch to unresponsive agent', async () => {
      vi.useFakeTimers();
      const config = makeConnectionConfig({
        heartbeatIntervalMs: 1000,
        heartbeatTimeoutCount: 2,
        maxReconnectAttempts: 10,
      });
      await connector.connect(config);

      // Make agent unresponsive
      vi.advanceTimersByTime(2000);
      expect(connector.getAgent('agent-alpha')!.healthStatus).toBe('unresponsive');

      const result = await connector.dispatchStep('agent-alpha', makeTaskContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('unresponsive');
    });

    it('should return failure for dispatch to non-connected agent', async () => {
      const result = await connector.dispatchStep('nonexistent', makeTaskContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected');
    });
  });

  // ----------------------------------------------------------------
  // 7. Dispatch error handling
  // ----------------------------------------------------------------

  describe('dispatch error handling', () => {
    it('should emit error artifact via onAgentEvent on dispatch failure', async () => {
      vi.useFakeTimers();
      const events: AgentEvent[] = [];
      connector.onAgentEvent((e) => events.push(e));

      await connector.connect(makeConnectionConfig({ protocol: 'process-spawn' }));

      await connector.dispatchStep('agent-alpha', makeTaskContext());

      const errorEvent = events.find(
        (e) => e.type === 'step_result' && (e.data as Record<string, unknown>).success === false,
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.agentId).toBe('agent-alpha');
    });

    it('should record dispatch error in AuditLog', async () => {
      vi.useFakeTimers();
      await connector.connect(makeConnectionConfig({ protocol: 'process-spawn' }));
      await connector.dispatchStep('agent-alpha', makeTaskContext());

      // Allow async audit records to settle
      await vi.advanceTimersByTimeAsync(0);

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const errorEntry = entries.find((e) => e.operation === 'dispatch_step_error');
      expect(errorEntry).toBeDefined();
      expect(errorEntry!.details).toHaveProperty('taskId', 'task-1');
    });
  });

  // ----------------------------------------------------------------
  // 8. Policy enforcement (checkAgentOperation)
  // ----------------------------------------------------------------

  describe('policy enforcement', () => {
    it('should deny operation when no allow policy exists (default deny)', () => {
      const decision = connector.checkAgentOperation(
        'agent-alpha',
        'file_write',
        '/src/main.ts',
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBeTruthy();
    });

    it('should allow operation when matching allow policy exists', async () => {
      policyEngine.addPolicy({
        id: 'allow-file-write',
        version: 1,
        agentId: 'agent-alpha',
        operations: ['file_write'],
        resources: ['/src/*'],
        effect: 'allow',
      });

      const decision = connector.checkAgentOperation(
        'agent-alpha',
        'file_write',
        '/src/main.ts',
      );
      expect(decision.allowed).toBe(true);
      expect(decision.policyId).toBe('allow-file-write');
    });

    it('should deny operation when deny policy overrides allow', async () => {
      policyEngine.addPolicy({
        id: 'allow-all',
        version: 1,
        agentId: '*',
        operations: ['*'],
        resources: ['*'],
        effect: 'allow',
      });
      policyEngine.addPolicy({
        id: 'deny-secrets',
        version: 1,
        agentId: '*',
        operations: ['file_write'],
        resources: ['/secrets/*'],
        effect: 'deny',
      });

      const decision = connector.checkAgentOperation(
        'agent-alpha',
        'file_write',
        '/secrets/key.pem',
      );
      expect(decision.allowed).toBe(false);
      expect(decision.policyId).toBe('deny-secrets');
    });

    it('should return structured AuthzDecision with policyId and reason', () => {
      policyEngine.addPolicy({
        id: 'deny-terminal',
        version: 1,
        agentId: '*',
        operations: ['terminal_command'],
        resources: ['*'],
        effect: 'deny',
      });

      const decision = connector.checkAgentOperation(
        'agent-alpha',
        'terminal_command',
        'rm -rf /',
      );
      expect(decision).toHaveProperty('allowed', false);
      expect(decision).toHaveProperty('policyId', 'deny-terminal');
      expect(decision).toHaveProperty('reason');
      expect(typeof decision.reason).toBe('string');
    });

    it('should record policy denial in AuditLog', async () => {
      connector.checkAgentOperation('agent-alpha', 'file_write', '/src/main.ts');

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const denialEntry = entries.find((e) => e.operation === 'policy_denial');
      expect(denialEntry).toBeDefined();
      expect(denialEntry!.agentId).toBe('agent-alpha');
      expect(denialEntry!.decision).toBe('deny');
    });

    it('should record allowed operations in AuditLog (Req 9.2)', async () => {
      policyEngine.addPolicy({
        id: 'allow-read',
        version: 1,
        agentId: 'agent-alpha',
        operations: ['file_read'],
        resources: ['/src/*'],
        effect: 'allow',
      });

      const decision = connector.checkAgentOperation(
        'agent-alpha',
        'file_read',
        '/src/utils.ts',
      );
      expect(decision.allowed).toBe(true);

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const allowedEntry = entries.find((e) => e.operation === 'agent_operation_allowed');
      expect(allowedEntry).toBeDefined();
      expect(allowedEntry!.agentId).toBe('agent-alpha');
      expect(allowedEntry!.decision).toBe('allow');
      expect(allowedEntry!.resource).toBe('/src/utils.ts');
      expect(allowedEntry!.details).toHaveProperty('requestedOperation', 'file_read');
      expect(allowedEntry!.details).toHaveProperty('policyId', 'allow-read');
    });

    it('should include taskId and stepId in audit entry when provided (Req 9.2, 9.5)', async () => {
      connector.checkAgentOperation(
        'agent-alpha',
        'file_write',
        '/src/main.ts',
        undefined,
        'task-42',
        'step-7',
      );

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const entry = entries.find((e) => e.operation === 'policy_denial');
      expect(entry).toBeDefined();
      expect(entry!.details).toHaveProperty('taskId', 'task-42');
      expect(entry!.details).toHaveProperty('stepId', 'step-7');
    });

    it('should omit taskId and stepId from audit entry when not provided', async () => {
      connector.checkAgentOperation('agent-alpha', 'file_write', '/src/main.ts');

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const entry = entries.find((e) => e.operation === 'policy_denial');
      expect(entry).toBeDefined();
      expect(entry!.details).not.toHaveProperty('taskId');
      expect(entry!.details).not.toHaveProperty('stepId');
    });

    it('should include taskId and stepId in allowed operation audit entry', async () => {
      policyEngine.addPolicy({
        id: 'allow-all-ops',
        version: 1,
        agentId: '*',
        operations: ['*'],
        resources: ['*'],
        effect: 'allow',
      });

      connector.checkAgentOperation(
        'agent-alpha',
        'terminal_command',
        'npm test',
        undefined,
        'task-99',
        'step-3',
      );

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const allowedEntry = entries.find((e) => e.operation === 'agent_operation_allowed');
      expect(allowedEntry).toBeDefined();
      expect(allowedEntry!.details).toHaveProperty('taskId', 'task-99');
      expect(allowedEntry!.details).toHaveProperty('stepId', 'step-3');
    });
  });

  // ----------------------------------------------------------------
  // 9. Isolation boundary enforcement
  // ----------------------------------------------------------------

  describe('isolation boundary enforcement', () => {
    beforeEach(async () => {
      await connector.connect(
        makeConnectionConfig({
          manifest: validManifest({
            memoryNamespaces: [{ namespace: 'notes', access: 'readwrite' }],
            communicationChannels: ['general'],
            mcpOperations: [{ serviceId: 'github', operations: ['read_repo'] }],
          }),
        }),
      );
    });

    it('should allow access to namespace within boundary', () => {
      expect(connector.enforceIsolationBoundary('agent-alpha', 'namespace', 'notes')).toBe(true);
    });

    it('should block access to namespace outside boundary', () => {
      expect(connector.enforceIsolationBoundary('agent-alpha', 'namespace', 'secrets')).toBe(false);
    });

    it('should allow access to channel within boundary', () => {
      expect(connector.enforceIsolationBoundary('agent-alpha', 'channel', 'general')).toBe(true);
    });

    it('should block access to channel outside boundary', () => {
      expect(connector.enforceIsolationBoundary('agent-alpha', 'channel', 'admin')).toBe(false);
    });

    it('should allow access to service within boundary', () => {
      expect(connector.enforceIsolationBoundary('agent-alpha', 'service', 'github')).toBe(true);
    });

    it('should block access to service outside boundary', () => {
      expect(connector.enforceIsolationBoundary('agent-alpha', 'service', 'aws')).toBe(false);
    });

    it('should deny all access for unknown agent (no boundary)', () => {
      expect(connector.enforceIsolationBoundary('unknown-agent', 'namespace', 'notes')).toBe(false);
    });

    it('should record isolation violation in AuditLog', async () => {
      connector.enforceIsolationBoundary('agent-alpha', 'namespace', 'secrets');

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const violation = entries.find((e) => e.operation === 'isolation_violation');
      expect(violation).toBeDefined();
      expect(violation!.decision).toBe('deny');
      expect(violation!.resource).toBe('namespace:secrets');
    });

    it('should include taskId and stepId in isolation violation audit entry when provided (Req 9.5)', async () => {
      connector.enforceIsolationBoundary('agent-alpha', 'namespace', 'secrets', 'task-10', 'step-2');

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const violation = entries.find((e) => e.operation === 'isolation_violation');
      expect(violation).toBeDefined();
      expect(violation!.details).toHaveProperty('taskId', 'task-10');
      expect(violation!.details).toHaveProperty('stepId', 'step-2');
    });

    it('should omit taskId and stepId from isolation violation when not provided', async () => {
      connector.enforceIsolationBoundary('agent-alpha', 'namespace', 'secrets');

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const violation = entries.find((e) => e.operation === 'isolation_violation');
      expect(violation).toBeDefined();
      expect(violation!.details).not.toHaveProperty('taskId');
      expect(violation!.details).not.toHaveProperty('stepId');
    });

    it('should include taskId and stepId in no-boundary audit entry when provided (Req 9.5)', async () => {
      connector.enforceIsolationBoundary('unknown-agent', 'namespace', 'notes', 'task-5', 'step-1');

      const entries = await auditLog.query({ eventType: 'agent_connector' });
      const violation = entries.find((e) => e.operation === 'isolation_violation');
      expect(violation).toBeDefined();
      expect(violation!.details).toHaveProperty('taskId', 'task-5');
      expect(violation!.details).toHaveProperty('stepId', 'step-1');
      expect(violation!.details).toHaveProperty('reason', 'No isolation boundary found for agent');
    });
  });

  // ----------------------------------------------------------------
  // 10. Response sanitization
  // ----------------------------------------------------------------

  describe('response sanitization', () => {
    it('should sanitize response by stripping sensitive keys', async () => {
      await connector.connect(makeConnectionConfig());

      const response = {
        data: 'safe content',
        password: 'super-secret-password-12345',
        token: 'my-auth-token-abcdef1234567890',
      };

      const sanitized = connector.sanitizeResponse('agent-alpha', response) as Record<string, unknown>;
      expect(sanitized.data).toBe('safe content');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.token).toBe('[REDACTED]');
    });

    it('should pass through safe responses unchanged', async () => {
      await connector.connect(makeConnectionConfig());

      const response = { result: 42, message: 'success' };
      const sanitized = connector.sanitizeResponse('agent-alpha', response) as Record<string, unknown>;
      expect(sanitized.result).toBe(42);
      expect(sanitized.message).toBe('success');
    });

    it('should handle sanitization for unknown agent (empty permissions)', () => {
      const response = { data: 'test' };
      const sanitized = connector.sanitizeResponse('unknown', response) as Record<string, unknown>;
      expect(sanitized.data).toBe('test');
    });
  });

  // ----------------------------------------------------------------
  // 11. External event source management
  // ----------------------------------------------------------------

  describe('external event source management', () => {
    const eventSource: ExternalEventSourceConfig = {
      id: 'github-webhooks',
      endpoint: 'https://api.github.com/webhooks',
      credentialRef: 'github-token',
      supportedEventTypes: ['push', 'pull_request', 'check_run'],
      pollingIntervalMs: 30000,
    };

    it('should register an event source', () => {
      connector.registerEventSource(eventSource);
      expect(connector.getEventSource('github-webhooks')).toEqual(eventSource);
    });

    it('should list registered event sources', () => {
      connector.registerEventSource(eventSource);
      connector.registerEventSource({
        id: 'ci-pipeline',
        endpoint: 'https://ci.example.com/api',
        credentialRef: 'ci-token',
        supportedEventTypes: ['build_complete'],
      });

      const sources = connector.listEventSources();
      expect(sources).toHaveLength(2);
    });

    it('should deregister an event source', () => {
      connector.registerEventSource(eventSource);
      expect(connector.getEventSource('github-webhooks')).toBeDefined();

      connector.deregisterEventSource('github-webhooks');
      expect(connector.getEventSource('github-webhooks')).toBeUndefined();
    });

    it('should record event source registration in AuditLog', async () => {
      connector.registerEventSource(eventSource);

      const entries = await auditLog.query({ eventType: 'external_event' });
      const registerEntry = entries.find((e) => e.operation === 'register_event_source');
      expect(registerEntry).toBeDefined();
      expect(registerEntry!.resource).toBe('event_source:github-webhooks');
    });

    it('should record event source deregistration in AuditLog', async () => {
      connector.registerEventSource(eventSource);
      connector.deregisterEventSource('github-webhooks');

      const entries = await auditLog.query({ eventType: 'external_event' });
      const deregisterEntry = entries.find((e) => e.operation === 'deregister_event_source');
      expect(deregisterEntry).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // 12. Agent query methods
  // ----------------------------------------------------------------

  describe('agent query methods', () => {
    it('should return undefined for non-connected agent via getAgent', () => {
      expect(connector.getAgent('nonexistent')).toBeUndefined();
    });

    it('should return connected agent via getAgent', async () => {
      await connector.connect(makeConnectionConfig());
      const agent = connector.getAgent('agent-alpha');
      expect(agent).toBeDefined();
      expect(agent!.agentId).toBe('agent-alpha');
    });

    it('should list all connected agents', async () => {
      await connector.connect(makeConnectionConfig({ agentId: 'agent-1', manifest: validManifest({ id: 'agent-1', agentIdentity: 'Agent 1' }) }));
      await connector.connect(makeConnectionConfig({ agentId: 'agent-2', manifest: validManifest({ id: 'agent-2', agentIdentity: 'Agent 2' }) }));

      const agents = connector.listAgents();
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.agentId).sort()).toEqual(['agent-1', 'agent-2']);
    });

    it('should return empty list when no agents connected', () => {
      expect(connector.listAgents()).toEqual([]);
    });

    it('should find capable agents matching tool requirements', async () => {
      await connector.connect(
        makeConnectionConfig({
          agentId: 'github-agent',
          manifest: validManifest({
            id: 'github-agent',
            agentIdentity: 'GitHub Agent',
            mcpOperations: [{ serviceId: 'github', operations: ['read_repo', 'create_pr'] }],
          }),
        }),
      );
      await connector.connect(
        makeConnectionConfig({
          agentId: 'slack-agent',
          manifest: validManifest({
            id: 'slack-agent',
            agentIdentity: 'Slack Agent',
            mcpOperations: [{ serviceId: 'slack', operations: ['post_message'] }],
          }),
        }),
      );

      const capable = connector.findCapableAgents({ tools: ['github'] });
      expect(capable).toHaveLength(1);
      expect(capable[0].agentId).toBe('github-agent');
    });

    it('should exclude unhealthy agents from findCapableAgents', async () => {
      vi.useFakeTimers();

      await connector.connect(
        makeConnectionConfig({
          agentId: 'healthy-agent',
          manifest: validManifest({ id: 'healthy-agent', agentIdentity: 'Healthy' }),
          heartbeatIntervalMs: 1000,
          heartbeatTimeoutCount: 2,
        }),
      );
      await connector.connect(
        makeConnectionConfig({
          agentId: 'sick-agent',
          manifest: validManifest({ id: 'sick-agent', agentIdentity: 'Sick' }),
          heartbeatIntervalMs: 1000,
          heartbeatTimeoutCount: 2,
        }),
      );

      // Make sick-agent degraded
      vi.advanceTimersByTime(1000);

      // Record heartbeat only for healthy-agent
      connector.recordHeartbeat('healthy-agent');

      const capable = connector.findCapableAgents({});
      expect(capable).toHaveLength(1);
      expect(capable[0].agentId).toBe('healthy-agent');
    });

    it('should return empty array when no agents match requirements', async () => {
      await connector.connect(makeConnectionConfig());
      const capable = connector.findCapableAgents({ tools: ['nonexistent-tool'] });
      expect(capable).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // 13. Event subscription
  // ----------------------------------------------------------------

  describe('event subscription', () => {
    it('should deliver events to all registered handlers', async () => {
      const events1: AgentEvent[] = [];
      const events2: AgentEvent[] = [];
      connector.onAgentEvent((e) => events1.push(e));
      connector.onAgentEvent((e) => events2.push(e));

      await connector.connect(makeConnectionConfig());
      await connector.disconnect('agent-alpha', 'test');

      // Both handlers should receive the disconnected event
      expect(events1.some((e) => e.type === 'disconnected')).toBe(true);
      expect(events2.some((e) => e.type === 'disconnected')).toBe(true);
    });

    it('should not throw if event handler throws', async () => {
      connector.onAgentEvent(() => {
        throw new Error('handler error');
      });

      // Should not throw despite handler error
      await connector.connect(makeConnectionConfig());
      await expect(connector.disconnect('agent-alpha', 'test')).resolves.not.toThrow();
    });
  });

  // ----------------------------------------------------------------
  // 14. Artifact normalization
  // ----------------------------------------------------------------

  describe('artifact normalization', () => {
    it('should produce a valid ExecutionArtifact with all required fields', () => {
      const artifact = connector.normalizeResult(
        'task-1',
        'step-1',
        'diff',
        { filePath: '/src/main.ts', beforeContent: 'old', afterContent: 'new' },
      );

      expect(artifact.id).toBeTruthy();
      expect(artifact.taskId).toBe('task-1');
      expect(artifact.stepId).toBe('step-1');
      expect(artifact.type).toBe('diff');
      expect(artifact.timestamp).toBeInstanceOf(Date);
      expect(artifact.data).toEqual({
        filePath: '/src/main.ts',
        beforeContent: 'old',
        afterContent: 'new',
      });
    });

    it('should generate unique IDs for each artifact', () => {
      const a1 = connector.normalizeResult('t1', 's1', 'error', { code: 'E1', message: 'err' });
      const a2 = connector.normalizeResult('t1', 's1', 'error', { code: 'E2', message: 'err2' });
      expect(a1.id).not.toBe(a2.id);
    });
  });
});
