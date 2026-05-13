import { v4 as uuidv4 } from 'uuid';

import type { IAgentSpawner } from '../interfaces/agent-spawner.js';
import type { IAgentConnector, CapabilityRequirements, ConnectedAgent } from '../interfaces/agent-connector.js';
import type { IAgentDiscoveryRegistry } from '../interfaces/agent-discovery-registry.js';
import type { ISessionManager } from '../interfaces/session-manager.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type {
  SpawnRequest,
  SpawnResult,
  AgentHarnessConfig,
} from '../interfaces/orchestration-config.js';
import type { AgentManifest } from '../interfaces/manifest-validator.js';

/**
 * AgentSpawner — Selects and spawns coding agents on demand based on
 * task requirements.
 *
 * Checks the Agent_Discovery_Registry for idle connected agents that
 * match the capability requirements. If a match is found, the existing
 * agent is reused. If not, a new agent process is spawned using the
 * configured harness command and connected through the Agent_Connector.
 *
 * The spawner respects the Session_Manager's maximum concurrent session
 * limit when deciding whether to spawn a new agent.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
export class AgentSpawner implements IAgentSpawner {
  private readonly agentConnector: IAgentConnector;
  private readonly discoveryRegistry: IAgentDiscoveryRegistry;
  private readonly sessionManager: ISessionManager;
  private readonly auditLog: IAuditLog;

  private harnessConfig: AgentHarnessConfig;

  constructor(options: {
    agentConnector: IAgentConnector;
    discoveryRegistry: IAgentDiscoveryRegistry;
    sessionManager: ISessionManager;
    auditLog: IAuditLog;
    harnessConfig?: AgentHarnessConfig;
  }) {
    this.agentConnector = options.agentConnector;
    this.discoveryRegistry = options.discoveryRegistry;
    this.sessionManager = options.sessionManager;
    this.auditLog = options.auditLog;
    this.harnessConfig = options.harnessConfig ?? {
      command: 'node',
      args: ['--experimental-vm-modules'],
      env: {},
      defaultCapabilities: {},
    };
  }

  // ------------------------------------------------------------------
  // IAgentSpawner — spawn
  // ------------------------------------------------------------------

  /**
   * Spawn or reuse an agent for the given requirements.
   *
   * Flow:
   *  1. Check if spawning is allowed (session limits).
   *  2. Search for an idle connected agent matching the requirements.
   *  3. If found, reuse the existing agent.
   *  4. If not found, spawn a new agent process and connect it.
   *
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
   */
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const now = new Date();

    // 1. Check for idle matching agents first (reuse preference).
    const idleAgent = this.findIdleMatchingAgent(request.requirements);

    if (idleAgent) {
      // Reuse the existing idle agent.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: idleAgent.agentId,
        operatorId: request.operatorId,
        eventType: 'agent_connector',
        operation: 'agent_reused',
        resource: `agent:${idleAgent.agentId}`,
        details: {
          agentId: idleAgent.agentId,
          sessionId: idleAgent.sessionId,
          orchestrationSessionId: request.orchestrationSessionId,
          requirements: request.requirements,
          reused: true,
        },
      });

      return {
        agentId: idleAgent.agentId,
        sessionId: idleAgent.sessionId,
        reused: true,
      };
    }

    // 2. No idle match — check if we can spawn a new agent.
    const spawnCheck = this.canSpawn();
    if (!spawnCheck.allowed) {
      throw new Error(
        `Cannot spawn agent: ${spawnCheck.reason ?? 'session limit reached'}`,
      );
    }

    // 3. Spawn a new agent process via Agent_Connector.
    const agentId = `agent-${uuidv4()}`;
    const manifest = this.buildManifest(agentId, request.requirements);

    const connectedAgent = await this.agentConnector.connect({
      agentId,
      protocol: 'process-spawn',
      manifest,
      operatorId: request.operatorId,
      connectionParams: {
        command: this.harnessConfig.command,
        args: this.harnessConfig.args,
        cwd: request.workspaceContext.localPath,
        env: {
          ...this.harnessConfig.env,
          ...request.workspaceContext.environment,
        },
      },
      heartbeatIntervalMs: 30000,
      heartbeatTimeoutCount: 3,
      maxReconnectAttempts: 3,
    });

    // 4. Record the spawn in the Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId,
      operatorId: request.operatorId,
      eventType: 'agent_connector',
      operation: 'agent_spawned',
      resource: `agent:${agentId}`,
      details: {
        agentId,
        sessionId: connectedAgent.sessionId,
        orchestrationSessionId: request.orchestrationSessionId,
        requirements: request.requirements,
        workspacePath: request.workspaceContext.localPath,
        harnessCommand: this.harnessConfig.command,
        reused: false,
      },
    });

    return {
      agentId: connectedAgent.agentId,
      sessionId: connectedAgent.sessionId,
      reused: false,
    };
  }

  // ------------------------------------------------------------------
  // IAgentSpawner — canSpawn
  // ------------------------------------------------------------------

  /**
   * Check if spawning is possible given current session limits.
   *
   * Compares the number of active (running) sessions against the
   * Session_Manager's maximum concurrent session limit.
   *
   * Requirements: 3.6
   */
  canSpawn(): { allowed: boolean; reason?: string } {
    const maxSessions = this.sessionManager.getMaxConcurrentSessions();
    const activeSessions = this.sessionManager.listSessions().filter(
      (s) => s.state === 'running',
    );

    if (activeSessions.length >= maxSessions) {
      return {
        allowed: false,
        reason: `Maximum concurrent session limit reached (${maxSessions})`,
      };
    }

    return { allowed: true };
  }

  // ------------------------------------------------------------------
  // IAgentSpawner — Harness config
  // ------------------------------------------------------------------

  /**
   * Get the configured harness command for agent spawning.
   */
  getHarnessConfig(): AgentHarnessConfig {
    return { ...this.harnessConfig };
  }

  /**
   * Set the harness configuration for agent spawning.
   */
  setHarnessConfig(config: AgentHarnessConfig): void {
    this.harnessConfig = { ...config };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Find an idle connected agent whose capabilities satisfy the requirements.
   *
   * An agent is considered idle if it is connected, healthy, and has no
   * current task assigned.
   *
   * Requirements: 3.2, 3.3
   */
  private findIdleMatchingAgent(
    requirements: CapabilityRequirements,
  ): ConnectedAgent | undefined {
    // Use the Agent_Connector's findCapableAgents to get agents matching requirements.
    const capableAgents = this.agentConnector.findCapableAgents(requirements);

    // Filter to only idle agents (no current task assigned).
    const idleAgents = capableAgents.filter(
      (agent) => agent.healthStatus === 'healthy' && !agent.currentTaskId,
    );

    // Return the first idle matching agent, if any.
    return idleAgents.length > 0 ? idleAgents[0] : undefined;
  }

  /**
   * Build an AgentManifest from capability requirements.
   *
   * Creates a manifest that declares the agent's capabilities based on
   * the task requirements. This manifest is used by the Agent_Connector
   * to create the Agent_Session and register capabilities.
   *
   * Requirements: 3.5
   */
  private buildManifest(
    agentId: string,
    requirements: CapabilityRequirements,
  ): AgentManifest {
    const description = this.buildDescription(requirements);

    // Build MCP operations from tool requirements.
    const mcpOperations = (requirements.tools ?? []).map((tool) => ({
      serviceId: tool,
      operations: ['*'],
    }));

    return {
      id: `manifest-${agentId}`,
      agentIdentity: agentId,
      description,
      memoryNamespaces: [
        { namespace: `agent-${agentId}`, access: 'readwrite' as const },
      ],
      communicationChannels: ['command-center'],
      mcpOperations,
      agentCard: {
        name: agentId,
        description,
        url: `agent://${agentId}`,
        version: '1.0.0',
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: true,
        },
        skills: this.buildSkills(requirements),
        defaultInputContentTypes: ['application/json'],
        defaultOutputContentTypes: ['application/json'],
      },
    };
  }

  /**
   * Build a human-readable description from capability requirements.
   */
  private buildDescription(requirements: CapabilityRequirements): string {
    const parts: string[] = [];

    if (requirements.languages && requirements.languages.length > 0) {
      parts.push(`Languages: ${requirements.languages.join(', ')}`);
    }
    if (requirements.frameworks && requirements.frameworks.length > 0) {
      parts.push(`Frameworks: ${requirements.frameworks.join(', ')}`);
    }
    if (requirements.tools && requirements.tools.length > 0) {
      parts.push(`Tools: ${requirements.tools.join(', ')}`);
    }

    return parts.length > 0
      ? `Coding agent with capabilities: ${parts.join('; ')}`
      : 'General-purpose coding agent';
  }

  /**
   * Build ACP skills from capability requirements.
   *
   * Each language/framework combination becomes a skill entry so that
   * the Agent_Discovery_Registry can match future requests.
   */
  private buildSkills(requirements: CapabilityRequirements): Array<{
    id: string;
    name: string;
    description: string;
  }> {
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

    if (requirements.tools) {
      for (const tool of requirements.tools) {
        skills.push({
          id: `tool-${tool}`,
          name: tool,
          description: `Usage of ${tool}`,
        });
      }
    }

    // Always include a general coding skill.
    if (skills.length === 0) {
      skills.push({
        id: 'general-coding',
        name: 'general-coding',
        description: 'General-purpose coding and development',
      });
    }

    return skills;
  }
}
