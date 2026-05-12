import type { AgentManifest } from './manifest-validator.js';

/** Supported integration protocols */
export type IntegrationProtocol = 'process-spawn' | 'websocket' | 'acp-rest';

/** Agent health states */
export type AgentHealthStatus = 'healthy' | 'degraded' | 'unresponsive';

/** Configuration for connecting a Coding_Agent */
export interface AgentConnectionConfig {
  agentId: string;
  protocol: IntegrationProtocol;
  manifest: AgentManifest;
  operatorId: string;
  /** Protocol-specific connection parameters */
  connectionParams: ProcessSpawnParams | WebSocketParams | ACPRestParams;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatIntervalMs?: number;
  /** Number of missed heartbeats before marking unresponsive (default: 3) */
  heartbeatTimeoutCount?: number;
  /** Maximum reconnection attempts on unexpected disconnect (default: 3) */
  maxReconnectAttempts?: number;
}

export interface ProcessSpawnParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface WebSocketParams {
  url: string;
  headers?: Record<string, string>;
}

export interface ACPRestParams {
  agentUrl: string;
}

/** Runtime state of a connected agent */
export interface ConnectedAgent {
  agentId: string;
  /** Agent_Session ID in Session_Manager */
  sessionId: string;
  protocol: IntegrationProtocol;
  healthStatus: AgentHealthStatus;
  connectedAt: Date;
  lastHeartbeat: Date;
  /** ID of the task currently being executed */
  currentTaskId?: string;
}

/** Normalized execution artifact from any protocol */
export interface ExecutionArtifact {
  id: string;
  taskId: string;
  stepId: string;
  type: 'diff' | 'terminal_output' | 'tool_invocation' | 'error';
  timestamp: Date;
  data: DiffArtifact | TerminalArtifact | ToolInvocationArtifact | ErrorArtifact;
}

export interface DiffArtifact {
  filePath: string;
  beforeContent: string;
  afterContent: string;
}

export interface TerminalArtifact {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ToolInvocationArtifact {
  toolName: string;
  params: unknown;
  result: unknown;
}

export interface ErrorArtifact {
  code: string;
  message: string;
  details?: unknown;
}

/** Result of dispatching a step to an agent */
export interface DispatchResult {
  success: boolean;
  error?: string;
}

/** Result collected from an agent after step execution */
export interface StepResult {
  artifacts: ExecutionArtifact[];
  success: boolean;
  error?: string;
}

export interface CapabilityRequirements {
  languages?: string[];
  frameworks?: string[];
  tools?: string[];
}

export interface AgentEvent {
  type: 'health_change' | 'step_result' | 'disconnected' | 'heartbeat_timeout';
  agentId: string;
  timestamp: Date;
  data: unknown;
}

export interface ExternalEventSourceConfig {
  id: string;
  endpoint: string;
  credentialRef: string;
  supportedEventTypes: string[];
  pollingIntervalMs?: number;
}

export interface IAgentConnector {
  /** Connect a Coding_Agent and create its Agent_Session */
  connect(config: AgentConnectionConfig): Promise<ConnectedAgent>;

  /** Gracefully disconnect a Coding_Agent */
  disconnect(agentId: string, reason: string): Promise<void>;

  /** Dispatch a task step to a connected agent */
  dispatchStep(agentId: string, context: TaskContext): Promise<DispatchResult>;

  /** Get the current state of a connected agent */
  getAgent(agentId: string): ConnectedAgent | undefined;

  /** List all connected agents */
  listAgents(): ConnectedAgent[];

  /** List agents matching capability requirements */
  findCapableAgents(requirements: CapabilityRequirements): ConnectedAgent[];

  /** Register an External_Event_Source */
  registerEventSource(source: ExternalEventSourceConfig): void;

  /** Deregister an External_Event_Source */
  deregisterEventSource(sourceId: string): void;

  /** Subscribe to agent events (health changes, step results, disconnections) */
  onAgentEvent(handler: (event: AgentEvent) => void): void;
}

// Re-export TaskContext from task-orchestrator to avoid circular dependency
// The IAgentConnector.dispatchStep uses TaskContext which is defined in task-orchestrator
import type { TaskContext } from './task-orchestrator.js';
export type { TaskContext };
