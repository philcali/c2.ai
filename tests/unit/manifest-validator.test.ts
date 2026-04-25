import { describe, it, expect, beforeEach } from 'vitest';
import { ManifestValidator } from '../../src/subsystems/manifest-validator.js';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';
import type { ACPAgentCard } from '../../src/interfaces/acp-adapter.js';

/** Returns a minimal valid manifest for use as a baseline in tests. */
function validManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    id: 'agent-alpha',
    agentIdentity: 'Alpha Agent',
    description: 'A test agent',
    memoryNamespaces: [{ namespace: 'notes', access: 'readwrite' }],
    communicationChannels: ['general'],
    mcpOperations: [{ serviceId: 'github', operations: ['read_repo'] }],
    ...overrides,
  };
}

/** Returns a minimal valid ACP Agent Card. */
function validAgentCard(overrides?: Partial<ACPAgentCard>): ACPAgentCard {
  return {
    name: 'Test Agent',
    description: 'A test ACP agent',
    url: 'https://agent.example.com',
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [{ id: 'skill-1', name: 'Summarize', description: 'Summarizes text' }],
    defaultInputContentTypes: ['application/json'],
    defaultOutputContentTypes: ['application/json'],
    ...overrides,
  };
}

/** Helper to create a deny policy. */
function denyPolicy(overrides?: Partial<AccessPolicy>): AccessPolicy {
  return {
    id: 'deny-policy-1',
    version: 1,
    agentId: '*',
    operations: ['*'],
    resources: ['*'],
    effect: 'deny',
    ...overrides,
  };
}

describe('ManifestValidator', () => {
  let validator: ManifestValidator;

  beforeEach(() => {
    validator = new ManifestValidator();
  });

  // ----------------------------------------------------------------
  // Valid manifest acceptance
  // ----------------------------------------------------------------

  describe('valid manifest acceptance', () => {
    it('should accept a fully valid manifest', () => {
      const result = validator.validate(validManifest());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should accept a manifest with empty arrays for optional collections', () => {
      const result = validator.validate(
        validManifest({
          memoryNamespaces: [],
          communicationChannels: [],
          mcpOperations: [],
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should accept a manifest with all memory access modes', () => {
      const result = validator.validate(
        validManifest({
          memoryNamespaces: [
            { namespace: 'ns-read', access: 'read' },
            { namespace: 'ns-write', access: 'write' },
            { namespace: 'ns-rw', access: 'readwrite' },
          ],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('should accept a manifest with multiple MCP operations per service', () => {
      const result = validator.validate(
        validManifest({
          mcpOperations: [
            { serviceId: 'github', operations: ['read_repo', 'create_issue', 'list_prs'] },
          ],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('should accept a manifest with a valid agentCard', () => {
      const result = validator.validate(
        validManifest({ agentCard: validAgentCard() }),
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should accept a manifest without an agentCard', () => {
      const manifest = validManifest();
      delete manifest.agentCard;
      const result = validator.validate(manifest);
      expect(result.valid).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Rejection of manifests with missing required fields
  // ----------------------------------------------------------------

  describe('rejection of manifests with missing or invalid required fields', () => {
    it('should reject a manifest with empty id', () => {
      const result = validator.validate(validManifest({ id: '' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'id'"))).toBe(true);
    });

    it('should reject a manifest with whitespace-only id', () => {
      const result = validator.validate(validManifest({ id: '   ' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'id'"))).toBe(true);
    });

    it('should reject a manifest with empty agentIdentity', () => {
      const result = validator.validate(validManifest({ agentIdentity: '' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'agentIdentity'"))).toBe(true);
    });

    it('should reject a manifest with empty description', () => {
      const result = validator.validate(validManifest({ description: '' }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'description'"))).toBe(true);
    });

    it('should collect multiple errors when several fields are invalid', () => {
      const result = validator.validate(
        validManifest({ id: '', agentIdentity: '', description: '' }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('should reject a manifest with non-string id', () => {
      const result = validator.validate(
        validManifest({ id: 123 as unknown as string }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'id'"))).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Rejection of manifests with invalid memoryNamespaces
  // ----------------------------------------------------------------

  describe('rejection of manifests with invalid memoryNamespaces', () => {
    it('should reject a namespace entry with empty namespace string', () => {
      const result = validator.validate(
        validManifest({
          memoryNamespaces: [{ namespace: '', access: 'read' }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('memoryNamespaces[0]'))).toBe(true);
    });

    it('should reject a namespace entry with invalid access mode', () => {
      const result = validator.validate(
        validManifest({
          memoryNamespaces: [
            { namespace: 'ns', access: 'execute' as 'read' },
          ],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'access'"))).toBe(true);
    });

    it('should reject when memoryNamespaces is not an array', () => {
      const result = validator.validate(
        validManifest({
          memoryNamespaces: 'not-an-array' as unknown as AgentManifest['memoryNamespaces'],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('memoryNamespaces'))).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Rejection of manifests with invalid communicationChannels
  // ----------------------------------------------------------------

  describe('rejection of manifests with invalid communicationChannels', () => {
    it('should reject an empty string channel', () => {
      const result = validator.validate(
        validManifest({ communicationChannels: [''] }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('communicationChannels[0]'))).toBe(true);
    });

    it('should reject when communicationChannels is not an array', () => {
      const result = validator.validate(
        validManifest({
          communicationChannels: 42 as unknown as string[],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('communicationChannels'))).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Rejection of manifests with invalid mcpOperations
  // ----------------------------------------------------------------

  describe('rejection of manifests with invalid mcpOperations', () => {
    it('should reject an mcpOperation with empty serviceId', () => {
      const result = validator.validate(
        validManifest({
          mcpOperations: [{ serviceId: '', operations: ['read'] }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'serviceId'"))).toBe(true);
    });

    it('should reject an mcpOperation with empty operations array', () => {
      const result = validator.validate(
        validManifest({
          mcpOperations: [{ serviceId: 'github', operations: [] }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'operations'"))).toBe(true);
    });

    it('should reject an mcpOperation with empty string in operations', () => {
      const result = validator.validate(
        validManifest({
          mcpOperations: [{ serviceId: 'github', operations: ['read', ''] }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('operation'))).toBe(true);
    });

    it('should reject when mcpOperations is not an array', () => {
      const result = validator.validate(
        validManifest({
          mcpOperations: {} as unknown as AgentManifest['mcpOperations'],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('mcpOperations'))).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Rejection of undefined namespaces, channels, services
  // ----------------------------------------------------------------

  describe('rejection of manifests with undefined namespaces, channels, services', () => {
    it('should reject a manifest referencing an undefined namespace', () => {
      const v = new ManifestValidator({
        knownNamespaces: ['notes', 'research'],
      });
      const result = v.validate(
        validManifest({
          memoryNamespaces: [{ namespace: 'unknown-ns', access: 'read' }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'unknown-ns'"))).toBe(true);
    });

    it('should accept a manifest referencing a known namespace', () => {
      const v = new ManifestValidator({
        knownNamespaces: ['notes', 'research'],
      });
      const result = v.validate(
        validManifest({
          memoryNamespaces: [{ namespace: 'notes', access: 'read' }],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('should reject a manifest referencing an undefined channel', () => {
      const v = new ManifestValidator({
        knownChannels: ['general', 'alerts'],
      });
      const result = v.validate(
        validManifest({ communicationChannels: ['unknown-channel'] }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'unknown-channel'"))).toBe(true);
    });

    it('should accept a manifest referencing a known channel', () => {
      const v = new ManifestValidator({
        knownChannels: ['general', 'alerts'],
      });
      const result = v.validate(
        validManifest({ communicationChannels: ['general'] }),
      );
      expect(result.valid).toBe(true);
    });

    it('should reject a manifest referencing an undefined service', () => {
      const v = new ManifestValidator({
        knownServices: ['github', 'slack'],
      });
      const result = v.validate(
        validManifest({
          mcpOperations: [{ serviceId: 'unknown-svc', operations: ['read'] }],
        }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("'unknown-svc'"))).toBe(true);
    });

    it('should accept a manifest referencing a known service', () => {
      const v = new ManifestValidator({
        knownServices: ['github', 'slack'],
      });
      const result = v.validate(
        validManifest({
          mcpOperations: [{ serviceId: 'github', operations: ['read'] }],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('should not check known resources when registry is not configured', () => {
      // Default validator has no known-resources registry.
      const result = validator.validate(
        validManifest({
          memoryNamespaces: [{ namespace: 'anything', access: 'read' }],
          communicationChannels: ['any-channel'],
          mcpOperations: [{ serviceId: 'any-service', operations: ['op'] }],
        }),
      );
      expect(result.valid).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Agent Card validation
  // ----------------------------------------------------------------

  describe('agentCard validation', () => {
    it('should reject an agentCard with missing name', () => {
      const card = validAgentCard();
      delete (card as unknown as Record<string, unknown>).name;
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("agentCard: 'name'"))).toBe(true);
    });

    it('should reject an agentCard with missing url', () => {
      const card = validAgentCard();
      delete (card as unknown as Record<string, unknown>).url;
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("agentCard: 'url'"))).toBe(true);
    });

    it('should reject an agentCard with missing version', () => {
      const card = validAgentCard();
      delete (card as unknown as Record<string, unknown>).version;
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("agentCard: 'version'"))).toBe(true);
    });

    it('should reject an agentCard with missing capabilities', () => {
      const card = validAgentCard();
      delete (card as unknown as Record<string, unknown>).capabilities;
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("agentCard: 'capabilities'"))).toBe(true);
    });

    it('should reject an agentCard with non-boolean capability fields', () => {
      const card = validAgentCard();
      (card.capabilities as Record<string, unknown>).streaming = 'yes';
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('capabilities.streaming'))).toBe(true);
    });

    it('should reject an agentCard with missing skills', () => {
      const card = validAgentCard();
      delete (card as unknown as Record<string, unknown>).skills;
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("agentCard: 'skills'"))).toBe(true);
    });

    it('should reject an agentCard with a skill missing id', () => {
      const card = validAgentCard();
      card.skills = [{ id: '', name: 'Summarize', description: 'Summarizes' }];
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('skills[0].id'))).toBe(true);
    });

    it('should reject an agentCard with a skill missing name', () => {
      const card = validAgentCard();
      card.skills = [{ id: 'skill-1', name: '', description: 'Summarizes' }];
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('skills[0].name'))).toBe(true);
    });

    it('should reject an agentCard with empty defaultInputContentTypes', () => {
      const card = validAgentCard();
      card.defaultInputContentTypes = [];
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('defaultInputContentTypes'))).toBe(true);
    });

    it('should reject an agentCard with empty defaultOutputContentTypes', () => {
      const card = validAgentCard();
      card.defaultOutputContentTypes = [];
      const result = validator.validate(validManifest({ agentCard: card }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('defaultOutputContentTypes'))).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Conflict detection with specific policy scenarios
  // ----------------------------------------------------------------

  describe('conflict detection with specific policy scenarios', () => {
    it('should detect no conflicts when no deny policies exist', () => {
      const allowPolicies: AccessPolicy[] = [
        {
          id: 'allow-all',
          version: 1,
          agentId: '*',
          operations: ['*'],
          resources: ['*'],
          effect: 'allow',
        },
      ];
      const result = validator.checkConflicts(validManifest(), allowPolicies);
      expect(result.hasConflicts).toBe(false);
      expect(result.conflicts).toEqual([]);
    });

    it('should detect no conflicts when deny policy targets a different agent', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({ agentId: 'other-agent', resources: ['memory:notes'] }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(false);
    });

    it('should detect memory namespace conflict with wildcard deny', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-all-memory',
          agentId: '*',
          operations: ['read', 'write'],
          resources: ['memory:notes'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0].policyId).toBe('deny-all-memory');
      expect(result.conflicts[0].description).toContain('notes');
    });

    it('should detect memory namespace conflict matching by manifest id', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-alpha-memory',
          agentId: 'agent-alpha',
          operations: ['write'],
          resources: ['memory:notes'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.some((c) => c.description.includes('write'))).toBe(true);
    });

    it('should detect memory namespace conflict matching by agentIdentity', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-identity',
          agentId: 'Alpha Agent',
          operations: ['read'],
          resources: ['memory:notes'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
    });

    it('should detect communication channel conflict', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-channel',
          agentId: '*',
          operations: ['send'],
          resources: ['communication:general'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.some((c) => c.description.includes('general'))).toBe(true);
      expect(result.conflicts.some((c) => c.description.includes('send'))).toBe(true);
    });

    it('should detect MCP service operation conflict', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-github',
          agentId: '*',
          operations: ['read_repo'],
          resources: ['mcp:github'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.some((c) => c.description.includes('github'))).toBe(true);
      expect(result.conflicts.some((c) => c.description.includes('read_repo'))).toBe(true);
    });

    it('should detect conflicts with wildcard resource in deny policy', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-everything',
          agentId: '*',
          operations: ['*'],
          resources: ['*'],
        }),
      ];
      const manifest = validManifest();
      const result = validator.checkConflicts(manifest, policies);
      expect(result.hasConflicts).toBe(true);
      // Should have conflicts for memory, communication, and MCP.
      expect(result.conflicts.length).toBeGreaterThanOrEqual(3);
    });

    it('should detect conflicts with prefix wildcard resource', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-memory-prefix',
          agentId: '*',
          operations: ['read'],
          resources: ['memory:*'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.some((c) => c.policyId === 'deny-memory-prefix')).toBe(true);
    });

    it('should detect no conflict when deny policy operation does not match', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-delete',
          agentId: '*',
          operations: ['delete'],
          resources: ['memory:notes'],
        }),
      ];
      // Manifest requests readwrite on notes — 'delete' is not read or write.
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(false);
    });

    it('should detect no conflict when deny policy resource does not match', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-other-ns',
          agentId: '*',
          operations: ['read', 'write'],
          resources: ['memory:secret-ns'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(false);
    });

    it('should report multiple conflicts from a single deny policy', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-broad',
          agentId: '*',
          operations: ['read', 'write', 'send', 'receive'],
          resources: ['memory:notes', 'communication:general'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
      // readwrite on notes = 2 conflicts (read + write), send + receive on general = 2 conflicts.
      expect(result.conflicts.length).toBe(4);
      expect(result.conflicts.every((c) => c.policyId === 'deny-broad')).toBe(true);
    });

    it('should report conflicts from multiple deny policies', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-memory',
          agentId: '*',
          operations: ['write'],
          resources: ['memory:notes'],
        }),
        denyPolicy({
          id: 'deny-channel',
          agentId: '*',
          operations: ['send'],
          resources: ['communication:general'],
        }),
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(true);
      const policyIds = result.conflicts.map((c) => c.policyId);
      expect(policyIds).toContain('deny-memory');
      expect(policyIds).toContain('deny-channel');
    });

    it('should detect no conflicts for an empty manifest (no permissions requested)', () => {
      const policies: AccessPolicy[] = [
        denyPolicy({ agentId: '*', operations: ['*'], resources: ['*'] }),
      ];
      const result = validator.checkConflicts(
        validManifest({
          memoryNamespaces: [],
          communicationChannels: [],
          mcpOperations: [],
        }),
        policies,
      );
      expect(result.hasConflicts).toBe(false);
    });

    it('should detect no conflicts when policies array is empty', () => {
      const result = validator.checkConflicts(validManifest(), []);
      expect(result.hasConflicts).toBe(false);
    });

    it('should ignore allow policies during conflict detection', () => {
      const policies: AccessPolicy[] = [
        {
          id: 'allow-notes',
          version: 1,
          agentId: '*',
          operations: ['read', 'write'],
          resources: ['memory:notes'],
          effect: 'allow',
        },
      ];
      const result = validator.checkConflicts(validManifest(), policies);
      expect(result.hasConflicts).toBe(false);
    });

    it('should detect read-only conflict for read-only namespace access', () => {
      const manifest = validManifest({
        memoryNamespaces: [{ namespace: 'logs', access: 'read' }],
      });
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-read-logs',
          agentId: '*',
          operations: ['read'],
          resources: ['memory:logs'],
        }),
      ];
      const result = validator.checkConflicts(manifest, policies);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.length).toBe(1);
      expect(result.conflicts[0].description).toContain('read');
    });

    it('should not detect write conflict for read-only namespace access', () => {
      const manifest = validManifest({
        memoryNamespaces: [{ namespace: 'logs', access: 'read' }],
      });
      const policies: AccessPolicy[] = [
        denyPolicy({
          id: 'deny-write-logs',
          agentId: '*',
          operations: ['write'],
          resources: ['memory:logs'],
        }),
      ];
      const result = validator.checkConflicts(manifest, policies);
      expect(result.hasConflicts).toBe(false);
    });
  });
});
