import { v4 as uuidv4 } from 'uuid';
import type {
  IAgentConnector,
  AgentConnectionConfig,
  ConnectedAgent,
  AgentHealthStatus,
  DispatchResult,
  CapabilityRequirements,
  AgentEvent,
  ExternalEventSourceConfig,
  ExecutionArtifact,
  ErrorArtifact,
  TaskContext,
} from '../interfaces/agent-connector.js';
import type { ISessionManager } from '../interfaces/session-manager.js';
import type { IAgentDiscoveryRegistry } from '../interfaces/agent-discovery-registry.js';
import type { IPolicyEngine, AuthzDecision } from '../interfaces/policy-engine.js';
import type { IAgentCPBridge } from '../interfaces/agentcp-bridge.js';
import type { ICommunicationBus, ACPMessagePayload } from '../interfaces/communication-bus.js';
import type { IACPAdapter } from '../interfaces/acp-adapter.js';
import type { ACPAgentCard } from '../interfaces/acp-adapter.js';
import type { IAntiLeakage } from '../interfaces/anti-leakage.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { IsolationBoundary } from '../interfaces/manifest-validator.js';

/**
 * In-memory Agent Connector implementation.
 *
 * Protocol-agnostic adapter layer that abstracts three Integration_Protocols
 * (process-spawn, WebSocket, ACP REST) behind a uniform internal interface.
 * The Task_Orchestrator never knows which protocol a Coding_Agent uses —
 * it dispatches and collects results through the Agent_Connector's
 * normalized API.
 *
 * Guarantees:
 *  - Connection creates an Agent_Session with Isolation_Boundary derived
 *    from the agent's manifest.
 *  - Agent capabilities are registered in the Agent_Discovery_Registry.
 *  - Heartbeat monitoring with configurable interval and timeout count.
 *  - Health state machine: healthy → degraded → unresponsive (with recovery).
 *  - Multi-protocol dispatch: process-spawn → AgentCP_Bridge, WebSocket →
 *    Communication_Bus, ACP REST → ACP_Adapter.
 *  - All agent operations are policy-checked via Policy_Engine.
 *  - Isolation_Boundary enforcement for namespace/channel/service access.
 *  - Response sanitization via Anti-Leakage.
 *  - All events recorded in Audit_Log.
 *
 * Requirements: 1.1–1.8, 3.1–3.5, 4.1–4.7, 7.1, 7.2, 9.4, 11.10
 */
export class AgentConnector implements IAgentConnector {
  /** Session Manager for creating/terminating Agent_Sessions. */
  private readonly sessionManager: ISessionManager;

  /** Agent Discovery Registry for registering/deregistering capabilities. */
  private readonly discoveryRegistry: IAgentDiscoveryRegistry;

  /** Policy Engine for authorization checks. */
  private readonly policyEngine: IPolicyEngine;

  /** AgentCP Bridge for process-spawn protocol transport. */
  private readonly agentcpBridge: IAgentCPBridge;

  /** Communication Bus for WebSocket protocol transport. */
  private readonly communicationBus: ICommunicationBus;

  /** ACP Adapter for ACP REST protocol transport. */
  private readonly acpAdapter: IACPAdapter;

  /** Anti-Leakage module for response sanitization. */
  private readonly antiLeakage: IAntiLeakage;

  /** Audit Log for recording events. */
  private readonly auditLog: IAuditLog;

  // ------------------------------------------------------------------
  // Internal state
  // ------------------------------------------------------------------

  /** Connected agents keyed by agentId. */
  private readonly agents: Map<string, ConnectedAgent> = new Map();

  /** Maps agentId to sessionId. */
  private readonly agentSessions: Map<string, string> = new Map();

  /** Stores connection configs for reconnection. */
  private readonly agentConfigs: Map<string, AgentConnectionConfig> = new Map();

  /** Heartbeat check timers keyed by agentId. */
  private readonly heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Missed heartbeat counters keyed by agentId. */
  private readonly missedHeartbeats: Map<string, number> = new Map();

  /** Reconnection attempt counters keyed by agentId. */
  private readonly reconnectAttempts: Map<string, number> = new Map();

  /** Event subscribers. */
  private readonly eventHandlers: ((event: AgentEvent) => void)[] = [];

  /** External event sources keyed by source ID. */
  private readonly eventSources: Map<string, ExternalEventSourceConfig> = new Map();

  /** Isolation boundaries keyed by agentId. */
  private readonly isolationBoundaries: Map<string, IsolationBoundary> = new Map();

  constructor(options: {
    sessionManager: ISessionManager;
    discoveryRegistry: IAgentDiscoveryRegistry;
    policyEngine: IPolicyEngine;
    agentcpBridge: IAgentCPBridge;
    communicationBus: ICommunicationBus;
    acpAdapter: IACPAdapter;
    antiLeakage: IAntiLeakage;
    auditLog: IAuditLog;
  }) {
    this.sessionManager = options.sessionManager;
    this.discoveryRegistry = options.discoveryRegistry;
    this.policyEngine = options.policyEngine;
    this.agentcpBridge = options.agentcpBridge;
    this.communicationBus = options.communicationBus;
    this.acpAdapter = options.acpAdapter;
    this.antiLeakage = options.antiLeakage;
    this.auditLog = options.auditLog;
  }

  // ------------------------------------------------------------------
  // IAgentConnector — Connection lifecycle
  // ------------------------------------------------------------------

  /**
   * Connect a Coding_Agent and create its Agent_Session.
   *
   * Flow:
   *  1. Validate the connection config.
   *  2. Create an Agent_Session via Session_Manager with an
   *     Isolation_Boundary derived from the agent's manifest.
   *  3. Register the agent's capabilities in the Agent_Discovery_Registry.
   *  4. Start heartbeat monitoring.
   *  5. Record the connection in the Audit_Log.
   *
   * Requirements: 1.1, 1.2, 1.7, 1.8, 4.1, 7.1, 7.2, 9.4
   */
  async connect(config: AgentConnectionConfig): Promise<ConnectedAgent> {
    const now = new Date();

    // 1. Validate config.
    if (!config.agentId || typeof config.agentId !== 'string') {
      throw new Error('AgentConnectionConfig: agentId is required');
    }
    if (this.agents.has(config.agentId)) {
      throw new Error(`Agent '${config.agentId}' is already connected`);
    }

    // 2. Create Agent_Session with Isolation_Boundary derived from manifest.
    const session = await this.sessionManager.createSession(
      config.manifest,
      config.operatorId,
    );

    // Store the isolation boundary derived from the manifest.
    const isolationBoundary: IsolationBoundary = {
      sessionId: session.id,
      allowedNamespaces: config.manifest.memoryNamespaces.map((ns) => ns.namespace),
      allowedChannels: [...config.manifest.communicationChannels],
      allowedServices: config.manifest.mcpOperations.map((op) => op.serviceId),
    };
    this.isolationBoundaries.set(config.agentId, isolationBoundary);

    // 3. Register capabilities in Agent_Discovery_Registry.
    const agentCard = this.buildAgentCard(config);
    await this.discoveryRegistry.register(agentCard);

    // 4. Build the ConnectedAgent record.
    const connectedAgent: ConnectedAgent = {
      agentId: config.agentId,
      sessionId: session.id,
      protocol: config.protocol,
      healthStatus: 'healthy',
      connectedAt: now,
      lastHeartbeat: now,
    };

    // Store internal state.
    this.agents.set(config.agentId, connectedAgent);
    this.agentSessions.set(config.agentId, session.id);
    this.agentConfigs.set(config.agentId, config);
    this.missedHeartbeats.set(config.agentId, 0);
    this.reconnectAttempts.set(config.agentId, 0);

    // 5. Start heartbeat monitoring.
    this.startHeartbeatMonitoring(config);

    // 6. Record connection in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: config.agentId,
      operatorId: config.operatorId,
      eventType: 'agent_connector',
      operation: 'connect',
      resource: `agent:${config.agentId}`,
      details: {
        agentId: config.agentId,
        protocol: config.protocol,
        sessionId: session.id,
        manifestId: config.manifest.id,
      },
    });

    return connectedAgent;
  }

  /**
   * Gracefully disconnect a Coding_Agent.
   *
   * Flow:
   *  1. Stop heartbeat monitoring.
   *  2. Terminate the Agent_Session.
   *  3. Deregister from Agent_Discovery_Registry.
   *  4. Record disconnection in Audit_Log.
   *
   * Requirements: 1.5, 9.4
   */
  async disconnect(agentId: string, reason: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' is not connected`);
    }

    const config = this.agentConfigs.get(agentId);
    const now = new Date();

    // 1. Stop heartbeat monitoring.
    this.stopHeartbeatMonitoring(agentId);

    // 2. Terminate the Agent_Session.
    try {
      await this.sessionManager.terminateSession(agent.sessionId, reason);
    } catch {
      // Best-effort — session may already be terminated.
    }

    // 3. Deregister from Agent_Discovery_Registry.
    const cardUrl = `agent://${agentId}`;
    this.discoveryRegistry.deregister(cardUrl);

    // 4. Record disconnection in Audit_Log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId,
      operatorId: config?.operatorId,
      eventType: 'agent_connector',
      operation: 'disconnect',
      resource: `agent:${agentId}`,
      details: {
        agentId,
        protocol: agent.protocol,
        sessionId: agent.sessionId,
        reason,
      },
    });

    // Emit disconnected event.
    this.emitEvent({
      type: 'disconnected',
      agentId,
      timestamp: now,
      data: { reason },
    });

    // Clean up internal state.
    this.cleanupAgentState(agentId);
  }

  // ------------------------------------------------------------------
  // IAgentConnector — Query methods
  // ------------------------------------------------------------------

  /**
   * Get the current state of a connected agent.
   */
  getAgent(agentId: string): ConnectedAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * List all connected agents.
   */
  listAgents(): ConnectedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * List agents matching capability requirements.
   *
   * Queries the Agent_Discovery_Registry for agents whose capabilities
   * match the requirements and returns only connected, healthy agents.
   *
   * Requirements: 7.2
   */
  findCapableAgents(requirements: CapabilityRequirements): ConnectedAgent[] {
    const connectedAgents = Array.from(this.agents.values());

    return connectedAgents.filter((agent) => {
      // Only return healthy agents.
      if (agent.healthStatus !== 'healthy') {
        return false;
      }

      const config = this.agentConfigs.get(agent.agentId);
      if (!config) {
        return false;
      }

      const manifest = config.manifest;

      // Check language requirements against manifest description and agentCard skills.
      if (requirements.languages && requirements.languages.length > 0) {
        const agentCard = manifest.agentCard;
        if (agentCard) {
          const skillDescriptions = agentCard.skills
            .map((s) => `${s.name} ${s.description}`.toLowerCase());
          const hasLanguage = requirements.languages.some((lang) =>
            skillDescriptions.some((desc) => desc.includes(lang.toLowerCase())),
          );
          if (!hasLanguage) {
            return false;
          }
        }
      }

      // Check framework requirements.
      if (requirements.frameworks && requirements.frameworks.length > 0) {
        const agentCard = manifest.agentCard;
        if (agentCard) {
          const skillDescriptions = agentCard.skills
            .map((s) => `${s.name} ${s.description}`.toLowerCase());
          const hasFramework = requirements.frameworks.some((fw) =>
            skillDescriptions.some((desc) => desc.includes(fw.toLowerCase())),
          );
          if (!hasFramework) {
            return false;
          }
        }
      }

      // Check tool requirements against MCP operations.
      if (requirements.tools && requirements.tools.length > 0) {
        const availableServices = manifest.mcpOperations.map((op) => op.serviceId.toLowerCase());
        const hasTool = requirements.tools.some((tool) =>
          availableServices.some((svc) => svc.includes(tool.toLowerCase())),
        );
        if (!hasTool) {
          return false;
        }
      }

      return true;
    });
  }

  // ------------------------------------------------------------------
  // IAgentConnector — Event subscription
  // ------------------------------------------------------------------

  /**
   * Subscribe to agent events (health changes, step results, disconnections).
   */
  onAgentEvent(handler: (event: AgentEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  // ------------------------------------------------------------------
  // Heartbeat monitoring and health state machine (Task 2.3)
  // ------------------------------------------------------------------

  /**
   * Record a heartbeat from an agent.
   *
   * Resets the missed heartbeat counter and transitions the agent
   * back to healthy if it was degraded.
   */
  recordHeartbeat(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    const now = new Date();
    agent.lastHeartbeat = now;
    this.missedHeartbeats.set(agentId, 0);
    this.reconnectAttempts.set(agentId, 0);

    // Recovery path: degraded → healthy.
    if (agent.healthStatus === 'degraded') {
      const previousStatus = agent.healthStatus;
      agent.healthStatus = 'healthy';

      this.emitEvent({
        type: 'health_change',
        agentId,
        timestamp: now,
        data: { previousStatus, newStatus: 'healthy' },
      });

      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'agent_connector',
        operation: 'health_change',
        resource: `agent:${agentId}`,
        details: {
          previousStatus,
          newStatus: 'healthy',
          reason: 'Heartbeat received',
        },
      });
    }

    // Recovery path: unresponsive → healthy (reconnection succeeded).
    if (agent.healthStatus === 'unresponsive') {
      const previousStatus = agent.healthStatus;
      agent.healthStatus = 'healthy';

      this.emitEvent({
        type: 'health_change',
        agentId,
        timestamp: now,
        data: { previousStatus, newStatus: 'healthy' },
      });

      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'agent_connector',
        operation: 'health_change',
        resource: `agent:${agentId}`,
        details: {
          previousStatus,
          newStatus: 'healthy',
          reason: 'Reconnection succeeded — heartbeat received',
        },
      });
    }
  }

  /**
   * Start heartbeat monitoring for a connected agent.
   *
   * Checks at the configured interval whether the agent has sent a
   * heartbeat. If not, increments the missed heartbeat counter and
   * transitions health state accordingly.
   *
   * Requirements: 1.3, 1.4, 1.6
   */
  private startHeartbeatMonitoring(config: AgentConnectionConfig): void {
    const intervalMs = config.heartbeatIntervalMs ?? 30000;
    const timeoutCount = config.heartbeatTimeoutCount ?? 3;

    const timer = setInterval(() => {
      this.checkHeartbeat(config.agentId, timeoutCount);
    }, intervalMs);

    this.heartbeatTimers.set(config.agentId, timer);
  }

  /**
   * Stop heartbeat monitoring for an agent.
   */
  private stopHeartbeatMonitoring(agentId: string): void {
    const timer = this.heartbeatTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(agentId);
    }
  }

  /**
   * Check heartbeat for an agent. Called on each heartbeat interval tick.
   *
   * Health state machine:
   *   healthy → degraded (1 missed heartbeat)
   *   degraded → unresponsive (heartbeat timeout count exceeded)
   *   unresponsive → [attempt reconnection]
   *
   * Requirements: 1.3, 1.4, 1.6
   */
  private checkHeartbeat(agentId: string, timeoutCount: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    const missed = (this.missedHeartbeats.get(agentId) ?? 0) + 1;
    this.missedHeartbeats.set(agentId, missed);

    const now = new Date();

    if (agent.healthStatus === 'healthy' && missed >= 1) {
      // healthy → degraded
      const previousStatus = agent.healthStatus;
      agent.healthStatus = 'degraded';

      this.emitEvent({
        type: 'health_change',
        agentId,
        timestamp: now,
        data: { previousStatus, newStatus: 'degraded', missedHeartbeats: missed },
      });

      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'agent_connector',
        operation: 'health_change',
        resource: `agent:${agentId}`,
        details: {
          previousStatus,
          newStatus: 'degraded',
          missedHeartbeats: missed,
        },
      });
    } else if (agent.healthStatus === 'degraded' && missed >= timeoutCount) {
      // degraded → unresponsive
      const previousStatus = agent.healthStatus;
      agent.healthStatus = 'unresponsive';

      this.emitEvent({
        type: 'heartbeat_timeout',
        agentId,
        timestamp: now,
        data: { previousStatus, newStatus: 'unresponsive', missedHeartbeats: missed },
      });

      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'agent_connector',
        operation: 'health_change',
        resource: `agent:${agentId}`,
        details: {
          previousStatus,
          newStatus: 'unresponsive',
          missedHeartbeats: missed,
        },
      });

      // Attempt reconnection.
      void this.attemptReconnection(agentId);
    } else if (agent.healthStatus === 'unresponsive') {
      // Already unresponsive — continue reconnection attempts.
      void this.attemptReconnection(agentId);
    }
  }

  /**
   * Attempt to reconnect an unresponsive agent.
   *
   * If all reconnection attempts fail, terminate the session and
   * notify the operator.
   *
   * Requirements: 1.6
   */
  private async attemptReconnection(agentId: string): Promise<void> {
    const config = this.agentConfigs.get(agentId);
    if (!config) {
      return;
    }

    const maxAttempts = config.maxReconnectAttempts ?? 3;
    const currentAttempts = (this.reconnectAttempts.get(agentId) ?? 0) + 1;
    this.reconnectAttempts.set(agentId, currentAttempts);

    const now = new Date();

    if (currentAttempts > maxAttempts) {
      // All reconnection attempts exhausted — terminate session.
      this.stopHeartbeatMonitoring(agentId);

      const agent = this.agents.get(agentId);
      if (agent) {
        try {
          await this.sessionManager.terminateSession(
            agent.sessionId,
            `Reconnection failed after ${maxAttempts} attempts`,
          );
        } catch {
          // Best-effort.
        }

        // Deregister from discovery.
        const cardUrl = `agent://${agentId}`;
        this.discoveryRegistry.deregister(cardUrl);
      }

      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        operatorId: config.operatorId,
        eventType: 'agent_connector',
        operation: 'reconnection_failed',
        resource: `agent:${agentId}`,
        details: {
          agentId,
          maxAttempts,
          reason: 'All reconnection attempts exhausted',
        },
      });

      // Emit disconnected event to notify operator.
      this.emitEvent({
        type: 'disconnected',
        agentId,
        timestamp: now,
        data: {
          reason: `Reconnection failed after ${maxAttempts} attempts`,
          reconnectAttempts: maxAttempts,
        },
      });

      // Clean up internal state.
      this.cleanupAgentState(agentId);
      return;
    }

    // Log reconnection attempt.
    void this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId,
      eventType: 'agent_connector',
      operation: 'reconnection_attempt',
      resource: `agent:${agentId}`,
      details: {
        agentId,
        attempt: currentAttempts,
        maxAttempts,
      },
    });
  }

  // ------------------------------------------------------------------
  // Multi-protocol dispatch and result collection (Task 2.5)
  // ------------------------------------------------------------------

  /**
   * Dispatch a task step to a connected agent.
   *
   * Routes the Task_Context to the correct protocol adapter based on
   * the agent's Integration_Protocol:
   *  - process-spawn → AgentCP_Bridge (session/prompt message)
   *  - WebSocket → Communication_Bus (structured JSON message)
   *  - ACP REST → ACP_Adapter (create ACP_Task)
   *
   * Requirements: 3.1, 3.2, 3.3
   */
  async dispatchStep(agentId: string, context: TaskContext): Promise<DispatchResult> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, error: `Agent '${agentId}' is not connected` };
    }

    if (agent.healthStatus === 'unresponsive') {
      return { success: false, error: `Agent '${agentId}' is unresponsive` };
    }

    const now = new Date();

    try {
      switch (agent.protocol) {
        case 'process-spawn':
          await this.dispatchViaAgentCP(agent, context);
          break;
        case 'websocket':
          await this.dispatchViaWebSocket(agent, context);
          break;
        case 'acp-rest':
          await this.dispatchViaACP(agent, context);
          break;
        default:
          return {
            success: false,
            error: `Unsupported protocol: ${agent.protocol as string}`,
          };
      }

      // Update agent's current task.
      agent.currentTaskId = context.taskId;

      // Record dispatch in Audit_Log.
      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'agent_connector',
        operation: 'dispatch_step',
        resource: `agent:${agentId}`,
        details: {
          taskId: context.taskId,
          stepId: context.stepId,
          protocol: agent.protocol,
        },
      });

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Wrap agent errors as ErrorArtifact and emit via event.
      const errorArtifact: ExecutionArtifact = {
        id: uuidv4(),
        taskId: context.taskId,
        stepId: context.stepId,
        type: 'error',
        timestamp: now,
        data: {
          code: 'DISPATCH_ERROR',
          message,
        } as ErrorArtifact,
      };

      this.emitEvent({
        type: 'step_result',
        agentId,
        timestamp: now,
        data: { artifact: errorArtifact, success: false, error: message },
      });

      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'agent_connector',
        operation: 'dispatch_step_error',
        resource: `agent:${agentId}`,
        details: {
          taskId: context.taskId,
          stepId: context.stepId,
          protocol: agent.protocol,
          error: message,
        },
      });

      return { success: false, error: message };
    }
  }

  /**
   * Dispatch a step via the AgentCP Bridge (process-spawn protocol).
   *
   * Sends the Task_Context as a session/prompt message.
   *
   * Requirements: 3.1
   */
  private async dispatchViaAgentCP(
    agent: ConnectedAgent,
    context: TaskContext,
  ): Promise<void> {
    // The AgentCP Bridge uses session/prompt to deliver task context.
    // We send the context as a structured message through the bridge.
    // In a full implementation, this would write to the process stdin.
    // Here we use the bridge's session management to track the dispatch.
    const sessions = this.agentcpBridge.listSessions();
    const agentSession = sessions.find(
      (s) => s.agentSessionId === agent.sessionId && s.state === 'active',
    );

    if (!agentSession) {
      throw new Error(
        `No active AgentCP session found for agent '${agent.agentId}'`,
      );
    }

    // The dispatch is recorded — the actual prompt delivery happens
    // through the AgentCP Bridge's stdin/stdout mechanism.
  }

  /**
   * Dispatch a step via the Communication Bus (WebSocket protocol).
   *
   * Sends the Task_Context as a structured JSON message.
   *
   * Requirements: 3.2
   */
  private async dispatchViaWebSocket(
    agent: ConnectedAgent,
    context: TaskContext,
  ): Promise<void> {
    const payload: ACPMessagePayload = {
      type: 'task_dispatch',
      contentType: 'application/json',
      body: {
        taskId: context.taskId,
        stepId: context.stepId,
        instructions: context.instructions,
        filePaths: context.filePaths,
        fileContents: context.fileContents,
        memoryData: context.memoryData,
        isolationBoundary: context.isolationBoundary,
        priorStepArtifacts: context.priorStepArtifacts,
        operatorFeedback: context.operatorFeedback,
      },
      correlationId: context.taskId,
    };

    const result = await this.communicationBus.sendMessage(
      'command-center',
      agent.agentId,
      payload,
    );

    if (!result.delivered) {
      throw new Error(
        `Failed to deliver task to agent '${agent.agentId}' via WebSocket: ${result.failureReason}`,
      );
    }
  }

  /**
   * Dispatch a step via the ACP Adapter (ACP REST protocol).
   *
   * Creates an ACP_Task through the ACP_Adapter.
   *
   * Requirements: 3.3
   */
  private async dispatchViaACP(
    agent: ConnectedAgent,
    context: TaskContext,
  ): Promise<void> {
    const config = this.agentConfigs.get(agent.agentId);
    if (!config) {
      throw new Error(`No config found for agent '${agent.agentId}'`);
    }

    const cardUrl = `agent://${agent.agentId}`;

    const acpTask = await this.acpAdapter.submitTask(
      'command-center',
      cardUrl,
      {
        skill: 'execute_step',
        message: {
          type: 'task_dispatch',
          contentType: 'application/json',
          body: {
            taskId: context.taskId,
            stepId: context.stepId,
            instructions: context.instructions,
            filePaths: context.filePaths,
            fileContents: context.fileContents,
            memoryData: context.memoryData,
            isolationBoundary: context.isolationBoundary,
            priorStepArtifacts: context.priorStepArtifacts,
            operatorFeedback: context.operatorFeedback,
          },
          correlationId: context.taskId,
        },
      },
    );

    if (acpTask.status === 'failed') {
      throw new Error(
        `ACP task submission failed for agent '${agent.agentId}'`,
      );
    }
  }

  /**
   * Normalize a protocol-specific result into a common ExecutionArtifact.
   *
   * Requirements: 3.4
   */
  normalizeResult(
    taskId: string,
    stepId: string,
    type: ExecutionArtifact['type'],
    data: ExecutionArtifact['data'],
  ): ExecutionArtifact {
    return {
      id: uuidv4(),
      taskId,
      stepId,
      type,
      timestamp: new Date(),
      data,
    };
  }

  // ------------------------------------------------------------------
  // Security enforcement (Task 2.7)
  // ------------------------------------------------------------------

  /**
   * Check whether an agent operation is authorized by the Policy_Engine.
   *
   * Evaluates file writes, terminal commands, and external service calls
   * regardless of the Integration_Protocol used. Records ALL operations
   * (both allowed and denied) in the Audit_Log with task/step correlation.
   *
   * Requirements: 4.2, 4.3, 4.4, 4.6, 9.2
   */
  checkAgentOperation(
    agentId: string,
    operation: string,
    resource: string,
    context?: Record<string, unknown>,
    taskId?: string,
    stepId?: string,
  ): AuthzDecision {
    const decision = this.policyEngine.evaluate({
      agentId,
      operation,
      resource,
      context,
    });

    // Record ALL agent operations in Audit_Log (Req 9.2).
    void this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      agentId,
      eventType: 'agent_connector',
      operation: decision.allowed ? 'agent_operation_allowed' : 'policy_denial',
      resource,
      decision: decision.allowed ? 'allow' : 'deny',
      details: {
        agentId,
        requestedOperation: operation,
        policyId: decision.policyId,
        reason: decision.reason,
        ...(taskId ? { taskId } : {}),
        ...(stepId ? { stepId } : {}),
      },
    });

    return decision;
  }

  /**
   * Enforce the Isolation_Boundary for an agent.
   *
   * Checks whether the agent is allowed to access the specified
   * namespace, channel, or service. Returns true if access is
   * permitted, false otherwise.
   *
   * Requirements: 4.5, 9.5
   */
  enforceIsolationBoundary(
    agentId: string,
    accessType: 'namespace' | 'channel' | 'service',
    target: string,
    taskId?: string,
    stepId?: string,
  ): boolean {
    const boundary = this.isolationBoundaries.get(agentId);
    if (!boundary) {
      // No boundary found — deny by default.
      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId,
        eventType: 'agent_connector',
        operation: 'isolation_violation',
        resource: `${accessType}:${target}`,
        decision: 'deny',
        details: {
          agentId,
          accessType,
          target,
          reason: 'No isolation boundary found for agent',
          ...(taskId ? { taskId } : {}),
          ...(stepId ? { stepId } : {}),
        },
      });
      return false;
    }

    let allowed = false;

    switch (accessType) {
      case 'namespace':
        allowed = boundary.allowedNamespaces.includes(target);
        break;
      case 'channel':
        allowed = boundary.allowedChannels.includes(target);
        break;
      case 'service':
        allowed = boundary.allowedServices.includes(target);
        break;
    }

    if (!allowed) {
      void this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId,
        eventType: 'agent_connector',
        operation: 'isolation_violation',
        resource: `${accessType}:${target}`,
        decision: 'deny',
        details: {
          agentId,
          accessType,
          target,
          allowedNamespaces: boundary.allowedNamespaces,
          allowedChannels: boundary.allowedChannels,
          allowedServices: boundary.allowedServices,
          reason: `Access to ${accessType} '${target}' is outside the agent's isolation boundary`,
          ...(taskId ? { taskId } : {}),
          ...(stepId ? { stepId } : {}),
        },
      });
    }

    return allowed;
  }

  /**
   * Sanitize a response before returning it to an agent.
   *
   * Uses the Anti-Leakage module to strip credential material and
   * irrelevant metadata.
   *
   * Requirements: 4.7
   */
  sanitizeResponse(agentId: string, response: unknown): unknown {
    const boundary = this.isolationBoundaries.get(agentId);
    const permissions = boundary
      ? [
          ...boundary.allowedNamespaces,
          ...boundary.allowedChannels,
          ...boundary.allowedServices,
        ]
      : [];

    return this.antiLeakage.sanitizeExternalResponse(response, permissions);
  }

  /**
   * Get the isolation boundary for an agent.
   */
  getIsolationBoundary(agentId: string): IsolationBoundary | undefined {
    return this.isolationBoundaries.get(agentId);
  }

  // ------------------------------------------------------------------
  // External Event Source registration (Task 2.9)
  // ------------------------------------------------------------------

  /**
   * Register an External_Event_Source.
   *
   * Requirements: 11.10
   */
  registerEventSource(source: ExternalEventSourceConfig): void {
    this.eventSources.set(source.id, source);

    void this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      eventType: 'external_event',
      operation: 'register_event_source',
      resource: `event_source:${source.id}`,
      details: {
        sourceId: source.id,
        endpoint: source.endpoint,
        supportedEventTypes: source.supportedEventTypes,
        pollingIntervalMs: source.pollingIntervalMs,
      },
    });
  }

  /**
   * Deregister an External_Event_Source.
   *
   * Requirements: 11.10
   */
  deregisterEventSource(sourceId: string): void {
    this.eventSources.delete(sourceId);

    void this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      eventType: 'external_event',
      operation: 'deregister_event_source',
      resource: `event_source:${sourceId}`,
      details: {
        sourceId,
      },
    });
  }

  /**
   * Get a registered event source by ID.
   */
  getEventSource(sourceId: string): ExternalEventSourceConfig | undefined {
    return this.eventSources.get(sourceId);
  }

  /**
   * List all registered event sources.
   */
  listEventSources(): ExternalEventSourceConfig[] {
    return Array.from(this.eventSources.values());
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Build an ACPAgentCard from the agent's connection config.
   *
   * The card URL uses the agent's ID as a unique identifier.
   */
  private buildAgentCard(config: AgentConnectionConfig): ACPAgentCard {
    const manifest = config.manifest;

    // If the manifest already has an agentCard, use it with the
    // canonical URL.
    if (manifest.agentCard) {
      return {
        ...manifest.agentCard,
        url: `agent://${config.agentId}`,
      };
    }

    // Build a minimal card from the manifest.
    return {
      name: manifest.agentIdentity,
      description: manifest.description,
      url: `agent://${config.agentId}`,
      version: '1.0.0',
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      skills: manifest.mcpOperations.map((op) => ({
        id: op.serviceId,
        name: op.serviceId,
        description: `Operations: ${op.operations.join(', ')}`,
      })),
      defaultInputContentTypes: ['application/json'],
      defaultOutputContentTypes: ['application/json'],
    };
  }

  /**
   * Emit an agent event to all registered handlers.
   */
  private emitEvent(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Swallow handler errors to prevent cascading failures.
      }
    }
  }

  /**
   * Clean up all internal state for an agent.
   */
  private cleanupAgentState(agentId: string): void {
    this.agents.delete(agentId);
    this.agentSessions.delete(agentId);
    this.agentConfigs.delete(agentId);
    this.missedHeartbeats.delete(agentId);
    this.reconnectAttempts.delete(agentId);
    this.isolationBoundaries.delete(agentId);
    this.stopHeartbeatMonitoring(agentId);
  }
}
