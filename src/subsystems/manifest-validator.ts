import type {
  IManifestValidator,
  AgentManifest,
  ValidationResult,
  ConflictResult,
} from '../interfaces/manifest-validator.js';
import type { AccessPolicy } from '../interfaces/policy-engine.js';

/**
 * In-memory Agent Manifest Validator.
 *
 * Validates manifest structure and detects permission conflicts with existing
 * policies before an Agent_Session is created.
 *
 * Guarantees:
 *  - Manifests with missing required fields are rejected with descriptive errors.
 *  - Manifests referencing undefined namespaces, channels, or services are
 *    rejected when a known-resources registry is provided.
 *  - Permission conflicts with existing deny policies are detected and reported.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */
export class ManifestValidator implements IManifestValidator {
  /**
   * Optional sets of known valid resources.
   * When provided, the validator rejects manifests that reference resources
   * not present in these sets. When omitted, structural validation only.
   */
  private readonly knownNamespaces: Set<string> | undefined;
  private readonly knownChannels: Set<string> | undefined;
  private readonly knownServices: Set<string> | undefined;

  constructor(options?: {
    knownNamespaces?: string[];
    knownChannels?: string[];
    knownServices?: string[];
  }) {
    this.knownNamespaces = options?.knownNamespaces
      ? new Set(options.knownNamespaces)
      : undefined;
    this.knownChannels = options?.knownChannels
      ? new Set(options.knownChannels)
      : undefined;
    this.knownServices = options?.knownServices
      ? new Set(options.knownServices)
      : undefined;
  }

  // ------------------------------------------------------------------
  // IManifestValidator implementation
  // ------------------------------------------------------------------

  /**
   * Validate manifest structure and resource references.
   *
   * Checks:
   *  1. Required fields: id, agentIdentity, description.
   *  2. memoryNamespaces: each entry must have a non-empty namespace and a
   *     valid access mode ('read' | 'write' | 'readwrite'). If known
   *     namespaces are configured, rejects undefined namespaces.
   *  3. communicationChannels: each entry must be a non-empty string. If
   *     known channels are configured, rejects undefined channels.
   *  4. mcpOperations: each entry must have a non-empty serviceId and a
   *     non-empty operations array. If known services are configured,
   *     rejects undefined services.
   *  5. agentCard (optional): if present, validates required ACP Agent Card
   *     fields (name, url, version, capabilities, skills, content types).
   */
  validate(manifest: AgentManifest): ValidationResult {
    const errors: string[] = [];

    // --- Required scalar fields ---
    this.validateRequiredString(manifest.id, 'id', errors);
    this.validateRequiredString(manifest.agentIdentity, 'agentIdentity', errors);
    this.validateRequiredString(manifest.description, 'description', errors);

    // --- memoryNamespaces ---
    this.validateMemoryNamespaces(manifest, errors);

    // --- communicationChannels ---
    this.validateCommunicationChannels(manifest, errors);

    // --- mcpOperations ---
    this.validateMcpOperations(manifest, errors);

    // --- agentCard (optional) ---
    if (manifest.agentCard !== undefined) {
      this.validateAgentCard(manifest.agentCard, errors);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Detect permission conflicts between a manifest's requested permissions
   * and existing access policies.
   *
   * A conflict exists when an existing deny policy would block a permission
   * that the manifest requests. This lets operators catch issues before
   * session creation rather than at runtime.
   */
  checkConflicts(
    manifest: AgentManifest,
    existingPolicies: AccessPolicy[],
  ): ConflictResult {
    const conflicts: { policyId: string; description: string }[] = [];

    // Only deny policies can create conflicts — allow policies are additive.
    const denyPolicies = existingPolicies.filter((p) => p.effect === 'deny');

    for (const policy of denyPolicies) {
      // Policy must apply to this agent (or wildcard).
      if (
        policy.agentId !== '*' &&
        policy.agentId !== manifest.id &&
        policy.agentId !== manifest.agentIdentity
      ) {
        continue;
      }

      // Check memory namespace conflicts.
      this.checkMemoryConflicts(manifest, policy, conflicts);

      // Check communication channel conflicts.
      this.checkChannelConflicts(manifest, policy, conflicts);

      // Check MCP service operation conflicts.
      this.checkMcpConflicts(manifest, policy, conflicts);
    }

    return {
      hasConflicts: conflicts.length > 0,
      conflicts,
    };
  }

  // ------------------------------------------------------------------
  // Structural validation helpers
  // ------------------------------------------------------------------

  private validateRequiredString(
    value: unknown,
    fieldName: string,
    errors: string[],
  ): void {
    if (value === undefined || value === null) {
      errors.push(`'${fieldName}' is required.`);
    } else if (typeof value !== 'string') {
      errors.push(`'${fieldName}' must be a string.`);
    } else if (value.trim() === '') {
      errors.push(`'${fieldName}' must not be empty.`);
    }
  }

  private validateMemoryNamespaces(
    manifest: AgentManifest,
    errors: string[],
  ): void {
    if (!Array.isArray(manifest.memoryNamespaces)) {
      errors.push("'memoryNamespaces' must be an array.");
      return;
    }

    const validAccessModes = ['read', 'write', 'readwrite'];

    for (let i = 0; i < manifest.memoryNamespaces.length; i++) {
      const entry = manifest.memoryNamespaces[i];

      if (!entry || typeof entry !== 'object') {
        errors.push(`memoryNamespaces[${i}]: must be an object with 'namespace' and 'access'.`);
        continue;
      }

      if (
        typeof entry.namespace !== 'string' ||
        entry.namespace.trim() === ''
      ) {
        errors.push(`memoryNamespaces[${i}]: 'namespace' must be a non-empty string.`);
      } else if (
        this.knownNamespaces &&
        !this.knownNamespaces.has(entry.namespace)
      ) {
        errors.push(
          `memoryNamespaces[${i}]: namespace '${entry.namespace}' is not a recognized namespace.`,
        );
      }

      if (!validAccessModes.includes(entry.access)) {
        errors.push(
          `memoryNamespaces[${i}]: 'access' must be one of ${validAccessModes.join(', ')}, got '${String(entry.access)}'.`,
        );
      }
    }
  }

  private validateCommunicationChannels(
    manifest: AgentManifest,
    errors: string[],
  ): void {
    if (!Array.isArray(manifest.communicationChannels)) {
      errors.push("'communicationChannels' must be an array.");
      return;
    }

    for (let i = 0; i < manifest.communicationChannels.length; i++) {
      const channel = manifest.communicationChannels[i];

      if (typeof channel !== 'string' || channel.trim() === '') {
        errors.push(
          `communicationChannels[${i}]: must be a non-empty string.`,
        );
      } else if (this.knownChannels && !this.knownChannels.has(channel)) {
        errors.push(
          `communicationChannels[${i}]: channel '${channel}' is not a recognized channel.`,
        );
      }
    }
  }

  private validateMcpOperations(
    manifest: AgentManifest,
    errors: string[],
  ): void {
    if (!Array.isArray(manifest.mcpOperations)) {
      errors.push("'mcpOperations' must be an array.");
      return;
    }

    for (let i = 0; i < manifest.mcpOperations.length; i++) {
      const entry = manifest.mcpOperations[i];

      if (!entry || typeof entry !== 'object') {
        errors.push(
          `mcpOperations[${i}]: must be an object with 'serviceId' and 'operations'.`,
        );
        continue;
      }

      if (
        typeof entry.serviceId !== 'string' ||
        entry.serviceId.trim() === ''
      ) {
        errors.push(
          `mcpOperations[${i}]: 'serviceId' must be a non-empty string.`,
        );
      } else if (
        this.knownServices &&
        !this.knownServices.has(entry.serviceId)
      ) {
        errors.push(
          `mcpOperations[${i}]: service '${entry.serviceId}' is not a recognized service.`,
        );
      }

      if (
        !Array.isArray(entry.operations) ||
        entry.operations.length === 0
      ) {
        errors.push(
          `mcpOperations[${i}]: 'operations' must be a non-empty array of strings.`,
        );
      } else if (
        entry.operations.some(
          (op: unknown) => typeof op !== 'string' || (op as string).trim() === '',
        )
      ) {
        errors.push(
          `mcpOperations[${i}]: each operation must be a non-empty string.`,
        );
      }
    }
  }

  private validateAgentCard(card: unknown, errors: string[]): void {
    if (!card || typeof card !== 'object') {
      errors.push("'agentCard' must be an object if provided.");
      return;
    }

    const c = card as Record<string, unknown>;

    if (typeof c.name !== 'string' || (c.name as string).trim() === '') {
      errors.push("agentCard: 'name' is required and must be a non-empty string.");
    }
    if (typeof c.url !== 'string' || (c.url as string).trim() === '') {
      errors.push("agentCard: 'url' is required and must be a non-empty string.");
    }
    if (typeof c.version !== 'string' || (c.version as string).trim() === '') {
      errors.push("agentCard: 'version' is required and must be a non-empty string.");
    }

    // capabilities
    if (!c.capabilities || typeof c.capabilities !== 'object') {
      errors.push("agentCard: 'capabilities' is required and must be an object.");
    } else {
      const caps = c.capabilities as Record<string, unknown>;
      if (typeof caps.streaming !== 'boolean') {
        errors.push("agentCard: capabilities.streaming must be a boolean.");
      }
      if (typeof caps.pushNotifications !== 'boolean') {
        errors.push("agentCard: capabilities.pushNotifications must be a boolean.");
      }
      if (typeof caps.stateTransitionHistory !== 'boolean') {
        errors.push("agentCard: capabilities.stateTransitionHistory must be a boolean.");
      }
    }

    // skills
    if (!Array.isArray(c.skills)) {
      errors.push("agentCard: 'skills' must be an array.");
    } else {
      for (let i = 0; i < (c.skills as unknown[]).length; i++) {
        const skill = (c.skills as Record<string, unknown>[])[i];
        if (!skill || typeof skill !== 'object') {
          errors.push(`agentCard: skills[${i}] must be an object.`);
          continue;
        }
        if (typeof skill.id !== 'string' || (skill.id as string).trim() === '') {
          errors.push(`agentCard: skills[${i}].id is required and must be a non-empty string.`);
        }
        if (typeof skill.name !== 'string' || (skill.name as string).trim() === '') {
          errors.push(`agentCard: skills[${i}].name is required and must be a non-empty string.`);
        }
      }
    }

    // defaultInputContentTypes
    if (!Array.isArray(c.defaultInputContentTypes)) {
      errors.push("agentCard: 'defaultInputContentTypes' must be an array.");
    } else if ((c.defaultInputContentTypes as unknown[]).length === 0) {
      errors.push("agentCard: 'defaultInputContentTypes' must not be empty.");
    }

    // defaultOutputContentTypes
    if (!Array.isArray(c.defaultOutputContentTypes)) {
      errors.push("agentCard: 'defaultOutputContentTypes' must be an array.");
    } else if ((c.defaultOutputContentTypes as unknown[]).length === 0) {
      errors.push("agentCard: 'defaultOutputContentTypes' must not be empty.");
    }
  }

  // ------------------------------------------------------------------
  // Conflict detection helpers
  // ------------------------------------------------------------------

  /**
   * Check if any deny policy blocks memory namespace operations requested
   * by the manifest.
   */
  private checkMemoryConflicts(
    manifest: AgentManifest,
    policy: AccessPolicy,
    conflicts: { policyId: string; description: string }[],
  ): void {
    for (const ns of manifest.memoryNamespaces) {
      const requestedOps = this.accessToOperations(ns.access);

      for (const op of requestedOps) {
        if (
          this.policyMatchesResource(policy, `memory:${ns.namespace}`) &&
          this.policyMatchesOperation(policy, op)
        ) {
          conflicts.push({
            policyId: policy.id,
            description:
              `Deny policy '${policy.id}' blocks '${op}' on memory namespace '${ns.namespace}' ` +
              `requested by manifest '${manifest.id}'.`,
          });
        }
      }
    }
  }

  /**
   * Check if any deny policy blocks communication channel access requested
   * by the manifest.
   */
  private checkChannelConflicts(
    manifest: AgentManifest,
    policy: AccessPolicy,
    conflicts: { policyId: string; description: string }[],
  ): void {
    for (const channel of manifest.communicationChannels) {
      // Agents need both send and receive on their declared channels.
      for (const op of ['send', 'receive']) {
        if (
          this.policyMatchesResource(policy, `communication:${channel}`) &&
          this.policyMatchesOperation(policy, op)
        ) {
          conflicts.push({
            policyId: policy.id,
            description:
              `Deny policy '${policy.id}' blocks '${op}' on communication channel '${channel}' ` +
              `requested by manifest '${manifest.id}'.`,
          });
        }
      }
    }
  }

  /**
   * Check if any deny policy blocks MCP service operations requested
   * by the manifest.
   */
  private checkMcpConflicts(
    manifest: AgentManifest,
    policy: AccessPolicy,
    conflicts: { policyId: string; description: string }[],
  ): void {
    for (const svc of manifest.mcpOperations) {
      for (const op of svc.operations) {
        if (
          this.policyMatchesResource(policy, `mcp:${svc.serviceId}`) &&
          this.policyMatchesOperation(policy, op)
        ) {
          conflicts.push({
            policyId: policy.id,
            description:
              `Deny policy '${policy.id}' blocks operation '${op}' on MCP service '${svc.serviceId}' ` +
              `requested by manifest '${manifest.id}'.`,
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Policy matching helpers (mirrors PolicyEngine logic for resources)
  // ------------------------------------------------------------------

  /**
   * Check if a policy's resource list matches a given resource string.
   * Supports exact match, wildcard '*', and prefix matching with trailing '*'.
   */
  private policyMatchesResource(
    policy: AccessPolicy,
    resource: string,
  ): boolean {
    return policy.resources.some((res) => {
      if (res === '*') return true;
      if (res.endsWith('*')) {
        return resource.startsWith(res.slice(0, -1));
      }
      return res === resource;
    });
  }

  /**
   * Check if a policy's operation list matches a given operation.
   * Supports exact match and wildcard '*'.
   */
  private policyMatchesOperation(
    policy: AccessPolicy,
    operation: string,
  ): boolean {
    return policy.operations.some((op) => op === '*' || op === operation);
  }

  /**
   * Convert a memory access mode to the set of operations it implies.
   */
  private accessToOperations(access: 'read' | 'write' | 'readwrite'): string[] {
    switch (access) {
      case 'read':
        return ['read'];
      case 'write':
        return ['write'];
      case 'readwrite':
        return ['read', 'write'];
    }
  }
}
