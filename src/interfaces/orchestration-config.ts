import type { CapabilityRequirements } from './agent-connector.js';
import type { TaskStepDefinition } from './task-orchestrator.js';

export interface OrchestrationLlmConfig {
  provider: 'openai-compatible' | 'anthropic' | 'custom';
  endpoint: string;
  model: string;
  apiKeyRef: string;
  systemPrompt?: string;
  roles?: Record<string, { model?: string; systemPrompt?: string }>;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentHarnessConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  defaultCapabilities: CapabilityRequirements;
}

export interface StructuredIntent {
  id: string;
  sourceType: 'operator' | 'platform_event';
  sourceId: string;
  repository?: string;
  branch?: string;
  action: string;
  constraints?: Record<string, unknown>;
  issueRef?: string;
  prRef?: string;
  confidence: number;
  rawInput: string;
  parsedAt: Date;
}

export interface ClarificationRequest {
  sessionId: string;
  question: string;
  options?: string[];
  context: string;
}

export interface WorkspaceContext {
  id: string;
  repositoryUrl: string;
  localPath: string;
  branch: string;
  defaultBranch: string;
  environment: Record<string, string>;
  lastUsedAt: Date;
  createdAt: Date;
}

export interface WorkspaceMetadata {
  repositoryUrl: string;
  localPath: string;
  defaultBranch: string;
  environment: Record<string, string>;
  lastUsedAt: Date;
}

export type OrchestrationState =
  | 'intent_received'
  | 'pending_approval'
  | 'resolving_workspace'
  | 'spawning_agent'
  | 'planning_task'
  | 'executing'
  | 'completed'
  | 'failed';

export interface OrchestrationSession {
  id: string;
  state: OrchestrationState;
  intent: StructuredIntent;
  operatorId: string;
  workspaceContext?: WorkspaceContext;
  agentId?: string;
  agentSessionId?: string;
  codingTaskId?: string;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface OrchestrationEvent {
  sessionId: string;
  fromState: OrchestrationState;
  toState: OrchestrationState;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface PlanningContext {
  intent: StructuredIntent;
  workspace: WorkspaceContext;
  agentCapabilities: CapabilityRequirements;
  operatorPreferences?: {
    reviewMode: 'manual' | 'auto-advance';
    maxSteps?: number;
  };
}

export interface GeneratedPlan {
  steps: TaskStepDefinition[];
  reasoning: string;
  estimatedDuration?: string;
}

export interface PlatformEvent {
  id: string;
  sourceId: string;
  eventType: string;
  payload: unknown;
  signature?: string;
  receivedAt: Date;
}

export interface EventSourceRegistration {
  id: string;
  platform: 'github' | 'gitlab' | 'custom';
  webhookSecret: string;
  allowedEventTypes: string[];
  ownerOperatorId: string;
  repositories?: string[];
}

export interface SpawnRequest {
  workspaceContext: WorkspaceContext;
  requirements: CapabilityRequirements;
  operatorId: string;
  orchestrationSessionId: string;
}

export interface SpawnResult {
  agentId: string;
  sessionId: string;
  reused: boolean;
}
