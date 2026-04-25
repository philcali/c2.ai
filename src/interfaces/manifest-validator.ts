import type { AccessPolicy } from './policy-engine.js';
import type { ACPAgentCard } from './acp-adapter.js';

export interface AgentManifest {
  id: string;
  agentIdentity: string;
  description: string;
  memoryNamespaces: { namespace: string; access: 'read' | 'write' | 'readwrite' }[];
  communicationChannels: string[];
  mcpOperations: { serviceId: string; operations: string[] }[];
  agentCard?: ACPAgentCard;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ConflictResult {
  hasConflicts: boolean;
  conflicts: { policyId: string; description: string }[];
}

export interface IsolationBoundary {
  sessionId: string;
  allowedNamespaces: string[];
  allowedChannels: string[];
  allowedServices: string[];
}

export interface IManifestValidator {
  validate(manifest: AgentManifest): ValidationResult;
  checkConflicts(manifest: AgentManifest, existingPolicies: AccessPolicy[]): ConflictResult;
}
