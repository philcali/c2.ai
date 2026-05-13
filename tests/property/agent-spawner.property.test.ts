import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { AgentSpawner } from '../../src/subsystems/agent-spawner.js';
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
import { arbitraryCapabilityRequirements } from '../generators/capability-requirements.generator.js';
import { arbitraryWorkspaceContext } from '../generators/workspace-context.generator.js';
import type { CapabilityRequirements, AgentConnectionConfig } from '../../src/interfaces/agent-connector.js';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';
import type { SpawnRequest } from '../../src/interfaces/orchestration-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a manifest whose agentCard skills cover the given capability requirements.
 * This ensures findCapableAgents will match the agent.
 */
function buildManifestForRequirements(
  agentId: string,
  requirements: CapabilityRequirements,
): AgentManifest {
  const skills: Array<{ id: string; name: string; description: string }> = [];

  if (requirements.languages) {
    for (const lang of requirements.languages) {
      skills.push({
        id: `lang-${lang}`,
        name: lang,
        description: `Development in ${lang}`,
      });
    }
  }

  if (requirements.frameworks) {
    for (const fw of requirements.frameworks) {
      skills.push({
        id: `framework-${fw}`,
        name: fw,
        description: `Development with ${fw} framework`,
      });
    }
  }

  const mcpOperations = (requirements.tools ?? []).map((tool) => ({
    serviceId: tool,
    operations: ['*'],
  }));

  if (skills.length === 0) {
    skills.push({
      id: 'general-coding',
      name: 'general-coding',
      description: 'General-purpose coding and development',
    });
  }

  return {
    id: `manifest-${agentId}`,
    agentIdentity: agentId,
    description: `Agent with capabilities for testing`,
    memoryNamespaces: [{ namespace: `agent-${agentId}`, access: 'readwrite' as const }],
    communicationChannels: ['command-center'],
    mcpOperations,
    agentCard: {
      name: agentId,
      description: `Test agent ${agentId}`,
      url: `agent://${agentId}`,
      version: '1.0.0',
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: true,
      },
      skills,
      defaultInputContentTypes: ['application/json'],
      defaultOutputContentTypes: ['application/json'],
    },
  };
}

/**
 * Create a full subsystem stack for testing the AgentSpawner with real
 * AgentConnector wiring.
 */
function createTestStack(maxSessions = 50) {
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const antiLeakage = new AntiLeakage({ policyEngine });
  const sessionManager = new SessionManager({
    auditLog,
    policyEngine,
    maxConcurrentSessions: maxSessions,
  });
  const discoveryRegistry = new AgentDiscoveryRegistry();
  const mcpGateway = new MCPGateway({ policyEngine, auditLog, antiLeakage });
  const agentcpBridge = new AgentCPBridge({
    sessionManager,
    policyEngine,
    mcpGateway,
    auditLog,
  });
  const communicationBus = new CommunicationBus({
    policyEngine,
    antiLeakage,
    auditLog,
    sessionManager,
  });
  const acpAdapter = new ACPAdapter({
    discoveryRegistry,
    communicationBus,
    policyEngine,
    auditLog,
  });

  const agentConnector = new AgentConnector({
    sessionManager,
    discoveryRegistry,
    policyEngine,
    agentcpBridge,
    communicationBus,
    acpAdapter,
    antiLeakage,
    auditLog,
  });

  const agentSpawner = new AgentSpawner({
    agentConnector,
    discoveryRegistry,
    sessionManager,
    auditLog,
  });

  return {
    auditLog,
    policyEngine,
    sessionManager,
    discoveryRegistry,
    agentConnector,
    agentSpawner,
  };
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('Agent Spawner Property Tests', () => {
  // --------------------------------------------------------------------------
  // Property 5: Idle agent reuse preference
  //
  // For any spawn request where an idle agent with matching capabilities
  // exists, the spawner returns `reused: true` with the existing agent's ID.
  //
  // Feature: intent-driven-orchestration, Property 5: Idle agent reuse preference
  // Validates: Requirements 3.3
  // --------------------------------------------------------------------------
  describe('Property 5: Idle agent reuse preference', () => {
    it('returns reused: true with existing agent ID when an idle matching agent exists', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryCapabilityRequirements(),
          arbitraryWorkspaceContext(),
          fc.uuid(),
          fc.uuid(),
          async (requirements, workspaceContext, operatorId, orchestrationSessionId) => {
            // Only test when at least one capability dimension is specified,
            // otherwise findCapableAgents matches all agents trivially.
            const hasRequirements =
              (requirements.languages && requirements.languages.length > 0) ||
              (requirements.frameworks && requirements.frameworks.length > 0) ||
              (requirements.tools && requirements.tools.length > 0);
            fc.pre(hasRequirements === true);

            const { agentConnector, agentSpawner } = createTestStack();

            // Pre-connect an agent whose capabilities satisfy the requirements.
            const existingAgentId = `idle-agent-${operatorId.slice(0, 8)}`;
            const manifest = buildManifestForRequirements(existingAgentId, requirements);

            const connectionConfig: AgentConnectionConfig = {
              agentId: existingAgentId,
              protocol: 'process-spawn',
              manifest,
              operatorId,
              connectionParams: { command: 'node', args: ['agent.js'] },
              heartbeatIntervalMs: 600000, // Long interval to avoid heartbeat issues in test
              heartbeatTimeoutCount: 100,
            };

            const connectedAgent = await agentConnector.connect(connectionConfig);

            // Verify the agent is idle (no currentTaskId) and healthy.
            const agentState = agentConnector.getAgent(existingAgentId);
            expect(agentState).toBeDefined();
            expect(agentState!.healthStatus).toBe('healthy');
            expect(agentState!.currentTaskId).toBeUndefined();

            // Now spawn with the same requirements — should reuse the idle agent.
            const spawnRequest: SpawnRequest = {
              workspaceContext,
              requirements,
              operatorId,
              orchestrationSessionId,
            };

            const result = await agentSpawner.spawn(spawnRequest);

            // Property assertion: reused must be true and agentId must match.
            expect(result.reused).toBe(true);
            expect(result.agentId).toBe(existingAgentId);
            expect(result.sessionId).toBe(connectedAgent.sessionId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('does not reuse an agent that is busy (has currentTaskId)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryCapabilityRequirements(),
          arbitraryWorkspaceContext(),
          fc.uuid(),
          fc.uuid(),
          async (requirements, workspaceContext, operatorId, orchestrationSessionId) => {
            const hasRequirements =
              (requirements.languages && requirements.languages.length > 0) ||
              (requirements.frameworks && requirements.frameworks.length > 0) ||
              (requirements.tools && requirements.tools.length > 0);
            fc.pre(hasRequirements === true);

            const { agentConnector, agentSpawner } = createTestStack();

            // Pre-connect an agent with matching capabilities.
            const busyAgentId = `busy-agent-${operatorId.slice(0, 8)}`;
            const manifest = buildManifestForRequirements(busyAgentId, requirements);

            const connectionConfig: AgentConnectionConfig = {
              agentId: busyAgentId,
              protocol: 'process-spawn',
              manifest,
              operatorId,
              connectionParams: { command: 'node', args: ['agent.js'] },
              heartbeatIntervalMs: 600000,
              heartbeatTimeoutCount: 100,
            };

            await agentConnector.connect(connectionConfig);

            // Mark the agent as busy by setting currentTaskId.
            const agentState = agentConnector.getAgent(busyAgentId);
            expect(agentState).toBeDefined();
            agentState!.currentTaskId = 'task-in-progress';

            // Spawn with the same requirements — should NOT reuse the busy agent.
            const spawnRequest: SpawnRequest = {
              workspaceContext,
              requirements,
              operatorId,
              orchestrationSessionId,
            };

            const result = await agentSpawner.spawn(spawnRequest);

            // Property assertion: should spawn a new agent (not reuse the busy one).
            expect(result.reused).toBe(false);
            expect(result.agentId).not.toBe(busyAgentId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('does not reuse an agent with non-matching capabilities', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryWorkspaceContext(),
          fc.uuid(),
          fc.uuid(),
          async (workspaceContext, operatorId, orchestrationSessionId) => {
            const { agentConnector, agentSpawner } = createTestStack();

            // Connect an agent with Python capabilities only.
            const pythonAgentId = `python-agent-${operatorId.slice(0, 8)}`;
            const pythonManifest = buildManifestForRequirements(pythonAgentId, {
              languages: ['python'],
              frameworks: ['django'],
              tools: ['pip'],
            });

            await agentConnector.connect({
              agentId: pythonAgentId,
              protocol: 'process-spawn',
              manifest: pythonManifest,
              operatorId,
              connectionParams: { command: 'python', args: ['agent.py'] },
              heartbeatIntervalMs: 600000,
              heartbeatTimeoutCount: 100,
            });

            // Request an agent with Rust capabilities (no match).
            const rustRequirements: CapabilityRequirements = {
              languages: ['rust'],
              frameworks: [],
              tools: ['cargo'],
            };

            const spawnRequest: SpawnRequest = {
              workspaceContext,
              requirements: rustRequirements,
              operatorId,
              orchestrationSessionId,
            };

            const result = await agentSpawner.spawn(spawnRequest);

            // Property assertion: should spawn a new agent since no match exists.
            expect(result.reused).toBe(false);
            expect(result.agentId).not.toBe(pythonAgentId);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('reuses the first idle matching agent when multiple idle agents exist', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryCapabilityRequirements(),
          arbitraryWorkspaceContext(),
          fc.uuid(),
          fc.uuid(),
          fc.integer({ min: 2, max: 5 }),
          async (requirements, workspaceContext, operatorId, orchestrationSessionId, agentCount) => {
            const hasRequirements =
              (requirements.languages && requirements.languages.length > 0) ||
              (requirements.frameworks && requirements.frameworks.length > 0) ||
              (requirements.tools && requirements.tools.length > 0);
            fc.pre(hasRequirements === true);

            const { agentConnector, agentSpawner } = createTestStack();

            // Connect multiple idle agents with matching capabilities.
            const agentIds: string[] = [];
            for (let i = 0; i < agentCount; i++) {
              const agentId = `multi-agent-${i}-${operatorId.slice(0, 6)}`;
              agentIds.push(agentId);
              const manifest = buildManifestForRequirements(agentId, requirements);

              await agentConnector.connect({
                agentId,
                protocol: 'process-spawn',
                manifest,
                operatorId,
                connectionParams: { command: 'node', args: ['agent.js'] },
                heartbeatIntervalMs: 600000,
                heartbeatTimeoutCount: 100,
              });
            }

            // Spawn with matching requirements.
            const spawnRequest: SpawnRequest = {
              workspaceContext,
              requirements,
              operatorId,
              orchestrationSessionId,
            };

            const result = await agentSpawner.spawn(spawnRequest);

            // Property assertion: should reuse one of the idle agents.
            expect(result.reused).toBe(true);
            expect(agentIds).toContain(result.agentId);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
