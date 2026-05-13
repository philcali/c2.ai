import { describe, it, expect, afterEach } from 'vitest';
import { CommandCenter } from '../../src/command-center.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { ManifestValidator } from '../../src/subsystems/manifest-validator.js';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import { MemoryStore } from '../../src/subsystems/memory-store.js';
import { AntiLeakage } from '../../src/subsystems/anti-leakage.js';
import { CommunicationBus } from '../../src/subsystems/communication-bus.js';
import { MCPGateway } from '../../src/subsystems/mcp-gateway.js';
import { AgentDiscoveryRegistry } from '../../src/subsystems/agent-discovery-registry.js';
import { ACPAdapter } from '../../src/subsystems/acp-adapter.js';
import { AgentCPBridge } from '../../src/subsystems/agentcp-bridge.js';
import { OperatorInterface } from '../../src/subsystems/operator-interface.js';
import { IntentResolver } from '../../src/subsystems/intent-resolver.js';
import { WorkspaceResolver } from '../../src/subsystems/workspace-resolver.js';
import { AgentSpawner } from '../../src/subsystems/agent-spawner.js';
import { EventIngress } from '../../src/subsystems/event-ingress.js';
import { OrchestrationSessionManager } from '../../src/subsystems/orchestration-session-manager.js';
import { TaskPlanner } from '../../src/subsystems/task-planner.js';
import type { OrchestrationLlmConfig } from '../../src/interfaces/orchestration-config.js';

/** Minimal orchestration LLM config for tests. */
const TEST_ORCHESTRATION_LLM: OrchestrationLlmConfig = {
  provider: 'openai-compatible',
  endpoint: 'http://localhost:11434',
  model: 'test-model',
  apiKeyRef: 'test-key',
};

describe('CommandCenter', () => {
  let cc: CommandCenter | null = null;

  afterEach(async () => {
    if (cc?.isRunning) {
      await cc.stop();
    }
    cc = null;
  });

  it('should throw when orchestrationLlm config is missing', () => {
    expect(() => new CommandCenter()).toThrow('orchestrationLlm');
  });

  it('should instantiate all subsystems with default config', () => {
    cc = new CommandCenter({ orchestrationLlm: TEST_ORCHESTRATION_LLM });

    expect(cc.auditLog).toBeInstanceOf(AuditLog);
    expect(cc.policyEngine).toBeInstanceOf(PolicyEngine);
    expect(cc.manifestValidator).toBeInstanceOf(ManifestValidator);
    expect(cc.sessionManager).toBeInstanceOf(SessionManager);
    expect(cc.memoryStore).toBeInstanceOf(MemoryStore);
    expect(cc.antiLeakage).toBeInstanceOf(AntiLeakage);
    expect(cc.communicationBus).toBeInstanceOf(CommunicationBus);
    expect(cc.mcpGateway).toBeInstanceOf(MCPGateway);
    expect(cc.agentDiscoveryRegistry).toBeInstanceOf(AgentDiscoveryRegistry);
    expect(cc.acpAdapter).toBeInstanceOf(ACPAdapter);
    expect(cc.agentCPBridge).toBeInstanceOf(AgentCPBridge);
    expect(cc.operatorInterface).toBeInstanceOf(OperatorInterface);
  });

  it('should instantiate all Layer 2 subsystems', () => {
    cc = new CommandCenter({ orchestrationLlm: TEST_ORCHESTRATION_LLM });

    expect(cc.intentResolver).toBeInstanceOf(IntentResolver);
    expect(cc.workspaceResolver).toBeInstanceOf(WorkspaceResolver);
    expect(cc.agentSpawner).toBeInstanceOf(AgentSpawner);
    expect(cc.eventIngress).toBeInstanceOf(EventIngress);
    expect(cc.orchestrationSessionManager).toBeInstanceOf(OrchestrationSessionManager);
    expect(cc.taskPlanner).toBeInstanceOf(TaskPlanner);
  });

  it('should not be running before start()', () => {
    cc = new CommandCenter({ orchestrationLlm: TEST_ORCHESTRATION_LLM });
    expect(cc.isRunning).toBe(false);
  });

  it('should start and stop the WebSocket server', async () => {
    // Use a random high port to avoid conflicts.
    cc = new CommandCenter({ port: 0, orchestrationLlm: TEST_ORCHESTRATION_LLM });
    expect(cc.isRunning).toBe(false);

    await cc.start();
    expect(cc.isRunning).toBe(true);

    await cc.stop();
    expect(cc.isRunning).toBe(false);
  });

  it('should be idempotent on start() when already running', async () => {
    cc = new CommandCenter({ port: 0, orchestrationLlm: TEST_ORCHESTRATION_LLM });
    await cc.start();
    // Calling start again should not throw.
    await cc.start();
    expect(cc.isRunning).toBe(true);
  });

  it('should be idempotent on stop() when not running', async () => {
    cc = new CommandCenter({ orchestrationLlm: TEST_ORCHESTRATION_LLM });
    // Calling stop before start should not throw.
    await cc.stop();
    expect(cc.isRunning).toBe(false);
  });

  it('should accept a custom authenticate function', () => {
    const authenticate = (token: string) => {
      if (token === 'valid') {
        return { operatorId: 'op-1', permissions: ['session:list'] };
      }
      return undefined;
    };

    cc = new CommandCenter({ authenticate, orchestrationLlm: TEST_ORCHESTRATION_LLM });
    expect(cc.operatorInterface).toBeInstanceOf(OperatorInterface);
  });

  it('should accept custom configuration options', () => {
    cc = new CommandCenter({
      port: 9999,
      maxConcurrentSessions: 5,
      maxMessageSize: 2048,
      heartbeatIntervalMs: 15_000,
      orchestrationLlm: TEST_ORCHESTRATION_LLM,
    });

    // Verify the session manager respects the max concurrent sessions.
    expect(cc.sessionManager.getMaxConcurrentSessions()).toBe(5);
    // Verify the communication bus respects the max message size.
    expect(cc.communicationBus.getMaxMessageSize()).toBe(2048);
  });

  it('should terminate active sessions on stop()', async () => {
    cc = new CommandCenter({ port: 0, maxConcurrentSessions: 10, orchestrationLlm: TEST_ORCHESTRATION_LLM });
    await cc.start();

    // Create a session via the session manager.
    const session = await cc.sessionManager.createSession(
      {
        id: 'test-agent',
        agentIdentity: 'test-agent',
        description: 'Test agent',
        memoryNamespaces: [],
        communicationChannels: [],
        mcpOperations: [],
      },
      'operator-1',
    );

    expect(session.state).toBe('running');

    await cc.stop();

    // After stop, the session should be terminated.
    const terminated = cc.sessionManager.getSession(session.id);
    expect(terminated?.state).toBe('terminated');
  });
});
