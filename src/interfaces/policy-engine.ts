import type { ValidationResult } from './manifest-validator.js';

export interface AuthzRequest {
  agentId: string;
  operation: string;
  resource: string;
  context?: Record<string, unknown>;
}

export interface AuthzDecision {
  allowed: boolean;
  policyId?: string;
  reason: string;
}

export interface PolicyCondition {
  field: string;
  operator: string;
  value: unknown;
}

export interface AccessPolicy {
  id: string;
  version: number;
  agentId: string | '*';
  operations: string[];
  resources: string[];
  conditions?: PolicyCondition[];
  effect: 'allow' | 'deny';
}

export type PolicyScope = 'memory' | 'communication' | 'mcp_gateway' | 'acp_task' | 'agentcp_operation';

export interface IPolicyEngine {
  evaluate(request: AuthzRequest): AuthzDecision;
  addPolicy(policy: AccessPolicy): ValidationResult;
  updatePolicy(policyId: string, policy: AccessPolicy): ValidationResult;
  removePolicy(policyId: string): void;
  getPolicy(policyId: string): AccessPolicy | undefined;
  listPolicies(scope?: PolicyScope): AccessPolicy[];
  getPolicyVersion(policyId: string, version: number): AccessPolicy | undefined;
  rollbackPolicy(policyId: string, version: number): ValidationResult;
}
