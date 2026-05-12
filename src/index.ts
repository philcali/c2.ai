/**
 * C2 AI Command Center
 *
 * Orchestrates multiple AI agent sessions with strict security isolation,
 * shared memory, inter-agent communication, and centralized policy enforcement.
 */
export const VERSION = '0.1.0';

// ------------------------------------------------------------------
// Command Center orchestrator
// ------------------------------------------------------------------

export { CommandCenter } from './command-center.js';
export type { CommandCenterConfig } from './command-center.js';

// ------------------------------------------------------------------
// Subsystem implementations
// ------------------------------------------------------------------

export { AuditLog } from './subsystems/audit-log.js';
export { PolicyEngine } from './subsystems/policy-engine.js';
export { ManifestValidator } from './subsystems/manifest-validator.js';
export { SessionManager } from './subsystems/session-manager.js';
export { MemoryStore } from './subsystems/memory-store.js';
export { AntiLeakage } from './subsystems/anti-leakage.js';
export { CommunicationBus } from './subsystems/communication-bus.js';
export { MCPGateway } from './subsystems/mcp-gateway.js';
export { AgentDiscoveryRegistry } from './subsystems/agent-discovery-registry.js';
export { ACPAdapter } from './subsystems/acp-adapter.js';
export { AgentCPBridge } from './subsystems/agentcp-bridge.js';
export { OperatorInterface } from './subsystems/operator-interface.js';
export { AgentConnector } from './subsystems/agent-connector.js';
export { TaskOrchestrator } from './subsystems/task-orchestrator.js';

// ------------------------------------------------------------------
// Operator Interface types
// ------------------------------------------------------------------

export type {
  AuthenticateFn,
  OperatorCredentials,
  RouteRequest,
  RouteResponse,
} from './subsystems/operator-interface.js';

// ------------------------------------------------------------------
// Agent Connector types
// ------------------------------------------------------------------

export type {
  IAgentConnector,
  IntegrationProtocol,
  AgentHealthStatus,
  AgentConnectionConfig,
  ProcessSpawnParams,
  WebSocketParams,
  ACPRestParams,
  ConnectedAgent,
  ExecutionArtifact,
  DiffArtifact,
  TerminalArtifact,
  ToolInvocationArtifact,
  ErrorArtifact,
  DispatchResult,
  StepResult,
  CapabilityRequirements,
  AgentEvent,
  ExternalEventSourceConfig,
} from './interfaces/agent-connector.js';

// ------------------------------------------------------------------
// Task Orchestrator types
// ------------------------------------------------------------------

export type {
  ITaskOrchestrator,
  CodingTaskStatus,
  TaskStepStatus,
  StepTriggerType,
  StepExecutionMode,
  TaskStep,
  StepTrigger,
  FeedbackEntry,
  CodingTask,
  CodingTaskSubmission,
  TaskStepDefinition,
  TaskContext,
  ArtifactQuery,
  ExternalEventPayload,
  TaskEvent,
} from './interfaces/task-orchestrator.js';
