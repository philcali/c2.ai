import type { ACPMessagePayload } from './communication-bus.js';
import type { ValidationResult } from './manifest-validator.js';

export interface ACPAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: ACPSkill[];
  defaultInputContentTypes: string[];
  defaultOutputContentTypes: string[];
}

export interface ACPSkill {
  id: string;
  name: string;
  description: string;
  inputContentTypes?: string[];
  outputContentTypes?: string[];
}

export interface ACPTaskSubmission {
  skill?: string;
  message: ACPMessagePayload;
}

export interface ACPTask {
  id: string;
  senderId: string;
  targetAgentUrl: string;
  status: ACPTaskStatus;
  message: ACPMessagePayload;
  result?: ACPMessagePayload;
  createdAt: Date;
  updatedAt: Date;
}

export type ACPTaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

export interface ACPTaskEvent {
  taskId: string;
  status: ACPTaskStatus;
  message?: ACPMessagePayload;
  timestamp: Date;
}

export interface IACPAdapter {
  registerAgent(card: ACPAgentCard): Promise<ValidationResult>;
  unregisterAgent(agentUrl: string): void;
  submitTask(senderId: string, targetAgentUrl: string, task: ACPTaskSubmission): Promise<ACPTask>;
  getTaskStatus(taskId: string): ACPTask | undefined;
  cancelTask(taskId: string, reason: string): Promise<void>;
  streamTaskUpdates(taskId: string): AsyncIterable<ACPTaskEvent>;
  listRegisteredAgents(): ACPAgentCard[];
}
