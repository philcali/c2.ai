import type {
  IPolicyEngine,
  AuthzRequest,
  AuthzDecision,
  AccessPolicy,
  PolicyScope,
  PolicyCondition,
} from '../interfaces/policy-engine.js';
import type { ValidationResult } from '../interfaces/manifest-validator.js';

/**
 * Maps each PolicyScope to the resource prefix pattern it governs.
 * Used by listPolicies() to filter policies by scope.
 */
const SCOPE_RESOURCE_PREFIXES: Record<PolicyScope, string> = {
  memory: 'memory:',
  communication: 'communication:',
  mcp_gateway: 'mcp:',
  acp_task: 'acp:',
  agentcp_operation: 'agentcp:',
};

/**
 * In-memory Policy Engine with default-deny evaluation.
 *
 * Guarantees:
 *  - Default-deny: operations are denied unless an explicit allow policy matches
 *    and no deny policy overrides it.
 *  - Deny policies always take precedence over allow policies.
 *  - Policy syntax is validated on add/update; malformed policies are rejected.
 *  - Full version history is maintained for each policy, supporting rollback.
 *  - Evaluation is synchronous and targets sub-50ms for in-memory policies.
 */
export class PolicyEngine implements IPolicyEngine {
  /** Current (latest) version of each policy, keyed by policy ID. */
  private readonly policies: Map<string, AccessPolicy> = new Map();

  /**
   * Full version history for each policy, keyed by policy ID.
   * Each array is ordered by version number (index 0 = version 1).
   */
  private readonly versionHistory: Map<string, AccessPolicy[]> = new Map();

  // ------------------------------------------------------------------
  // IPolicyEngine — Evaluation
  // ------------------------------------------------------------------

  evaluate(request: AuthzRequest): AuthzDecision {
    let matchingAllow: AccessPolicy | undefined;
    let matchingDeny: AccessPolicy | undefined;

    for (const policy of this.policies.values()) {
      if (!this.policyMatchesRequest(policy, request)) {
        continue;
      }

      if (policy.effect === 'deny') {
        // First matching deny is enough — deny overrides allow.
        matchingDeny = policy;
        break;
      }

      if (policy.effect === 'allow' && !matchingAllow) {
        matchingAllow = policy;
      }
    }

    // Deny policies take precedence.
    if (matchingDeny) {
      return {
        allowed: false,
        policyId: matchingDeny.id,
        reason: `Denied by policy '${matchingDeny.id}'`,
      };
    }

    // Allow only if an explicit allow policy matched.
    if (matchingAllow) {
      return {
        allowed: true,
        policyId: matchingAllow.id,
        reason: `Allowed by policy '${matchingAllow.id}'`,
      };
    }

    // Default deny — no matching allow policy.
    return {
      allowed: false,
      reason: 'Default deny: no matching allow policy',
    };
  }

  // ------------------------------------------------------------------
  // IPolicyEngine — Policy CRUD
  // ------------------------------------------------------------------

  addPolicy(policy: AccessPolicy): ValidationResult {
    const validation = this.validatePolicy(policy);
    if (!validation.valid) {
      return validation;
    }

    if (this.policies.has(policy.id)) {
      return {
        valid: false,
        errors: [`Policy with id '${policy.id}' already exists. Use updatePolicy() instead.`],
      };
    }

    // Normalize version to 1 for new policies.
    const stored: AccessPolicy = { ...policy, version: 1 };
    this.policies.set(stored.id, stored);
    this.versionHistory.set(stored.id, [stored]);

    return { valid: true, errors: [] };
  }

  updatePolicy(policyId: string, policy: AccessPolicy): ValidationResult {
    const validation = this.validatePolicy(policy);
    if (!validation.valid) {
      return validation;
    }

    const existing = this.policies.get(policyId);
    if (!existing) {
      return {
        valid: false,
        errors: [`Policy '${policyId}' not found.`],
      };
    }

    const history = this.versionHistory.get(policyId)!;
    const nextVersion = history.length + 1;

    const updated: AccessPolicy = { ...policy, id: policyId, version: nextVersion };
    this.policies.set(policyId, updated);
    history.push(updated);

    return { valid: true, errors: [] };
  }

  removePolicy(policyId: string): void {
    this.policies.delete(policyId);
    // Keep version history for audit purposes — only remove the active policy.
  }

  getPolicy(policyId: string): AccessPolicy | undefined {
    return this.policies.get(policyId);
  }

  listPolicies(scope?: PolicyScope): AccessPolicy[] {
    const all = Array.from(this.policies.values());

    if (scope === undefined) {
      return all;
    }

    const prefix = SCOPE_RESOURCE_PREFIXES[scope];
    return all.filter((p) =>
      p.resources.some((r) => r.startsWith(prefix)),
    );
  }

  // ------------------------------------------------------------------
  // IPolicyEngine — Versioning
  // ------------------------------------------------------------------

  getPolicyVersion(policyId: string, version: number): AccessPolicy | undefined {
    const history = this.versionHistory.get(policyId);
    if (!history) {
      return undefined;
    }
    // Versions are 1-indexed; array is 0-indexed.
    return history[version - 1];
  }

  rollbackPolicy(policyId: string, version: number): ValidationResult {
    const history = this.versionHistory.get(policyId);
    if (!history) {
      return {
        valid: false,
        errors: [`Policy '${policyId}' not found.`],
      };
    }

    if (version < 1 || version > history.length) {
      return {
        valid: false,
        errors: [
          `Version ${version} does not exist for policy '${policyId}'. ` +
          `Valid range: 1–${history.length}.`,
        ],
      };
    }

    const target = history[version - 1];

    // Rollback creates a new version that is a copy of the target version.
    const nextVersion = history.length + 1;
    const rolledBack: AccessPolicy = { ...target, version: nextVersion };

    this.policies.set(policyId, rolledBack);
    history.push(rolledBack);

    return { valid: true, errors: [] };
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Check whether a policy matches an authorization request.
   * A policy matches when:
   *  1. The policy's agentId is '*' (wildcard) or equals the request's agentId.
   *  2. At least one of the policy's operations matches the request's operation.
   *  3. At least one of the policy's resources matches the request's resource.
   *  4. All policy conditions (if any) are satisfied by the request context.
   */
  private policyMatchesRequest(policy: AccessPolicy, request: AuthzRequest): boolean {
    // Agent match
    if (policy.agentId !== '*' && policy.agentId !== request.agentId) {
      return false;
    }

    // Operation match (supports '*' wildcard in individual operations)
    const operationMatch = policy.operations.some(
      (op) => op === '*' || op === request.operation,
    );
    if (!operationMatch) {
      return false;
    }

    // Resource match (supports '*' wildcard and prefix matching with trailing '*')
    const resourceMatch = policy.resources.some((res) => {
      if (res === '*') return true;
      if (res.endsWith('*')) {
        return request.resource.startsWith(res.slice(0, -1));
      }
      return res === request.resource;
    });
    if (!resourceMatch) {
      return false;
    }

    // Condition match
    if (policy.conditions && policy.conditions.length > 0) {
      return policy.conditions.every((cond) =>
        this.evaluateCondition(cond, request.context ?? {}),
      );
    }

    return true;
  }

  /**
   * Evaluate a single policy condition against the request context.
   */
  private evaluateCondition(
    condition: PolicyCondition,
    context: Record<string, unknown>,
  ): boolean {
    const actual = context[condition.field];

    switch (condition.operator) {
      case 'equals':
        return actual === condition.value;
      case 'not_equals':
        return actual !== condition.value;
      case 'in':
        return Array.isArray(condition.value) && condition.value.includes(actual);
      case 'not_in':
        return Array.isArray(condition.value) && !condition.value.includes(actual);
      case 'exists':
        return actual !== undefined;
      case 'not_exists':
        return actual === undefined;
      default:
        // Unknown operator — condition fails (safe default).
        return false;
    }
  }

  /**
   * Validate policy structure and syntax.
   * Returns a ValidationResult with descriptive errors for any issues found.
   */
  private validatePolicy(policy: AccessPolicy): ValidationResult {
    const errors: string[] = [];

    if (!policy.id || typeof policy.id !== 'string' || policy.id.trim() === '') {
      errors.push('Policy id is required and must be a non-empty string.');
    }

    if (policy.effect !== 'allow' && policy.effect !== 'deny') {
      errors.push(`Policy effect must be 'allow' or 'deny', got '${String(policy.effect)}'.`);
    }

    if (
      policy.agentId === undefined ||
      policy.agentId === null ||
      (typeof policy.agentId !== 'string')
    ) {
      errors.push('Policy agentId is required and must be a string or \'*\'.');
    } else if (policy.agentId.trim() === '') {
      errors.push('Policy agentId must not be empty.');
    }

    if (!Array.isArray(policy.operations) || policy.operations.length === 0) {
      errors.push('Policy operations must be a non-empty array of strings.');
    } else if (policy.operations.some((op) => typeof op !== 'string' || op.trim() === '')) {
      errors.push('Each policy operation must be a non-empty string.');
    }

    if (!Array.isArray(policy.resources) || policy.resources.length === 0) {
      errors.push('Policy resources must be a non-empty array of strings.');
    } else if (policy.resources.some((r) => typeof r !== 'string' || r.trim() === '')) {
      errors.push('Each policy resource must be a non-empty string.');
    }

    if (policy.conditions !== undefined) {
      if (!Array.isArray(policy.conditions)) {
        errors.push('Policy conditions must be an array if provided.');
      } else {
        for (let i = 0; i < policy.conditions.length; i++) {
          const cond = policy.conditions[i];
          if (!cond.field || typeof cond.field !== 'string') {
            errors.push(`Condition at index ${i}: field is required and must be a string.`);
          }
          if (!cond.operator || typeof cond.operator !== 'string') {
            errors.push(`Condition at index ${i}: operator is required and must be a string.`);
          }
          const validOperators = ['equals', 'not_equals', 'in', 'not_in', 'exists', 'not_exists'];
          if (cond.operator && !validOperators.includes(cond.operator)) {
            errors.push(
              `Condition at index ${i}: operator '${cond.operator}' is not valid. ` +
              `Valid operators: ${validOperators.join(', ')}.`,
            );
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
