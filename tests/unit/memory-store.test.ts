import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '../../src/subsystems/memory-store.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';

describe('MemoryStore', () => {
  let memoryStore: MemoryStore;
  let policyEngine: PolicyEngine;
  let auditLog: AuditLog;

  /** Helper to add an allow policy for a given agent, operation, and namespace. */
  function allowPolicy(
    agentId: string,
    operations: string[],
    namespaces: string[],
  ): AccessPolicy {
    const policy: AccessPolicy = {
      id: `allow-${agentId}-${operations.join('-')}-${namespaces.join('-')}`,
      version: 1,
      agentId,
      operations,
      resources: namespaces.map((ns) => `memory:${ns}`),
      effect: 'allow',
    };
    policyEngine.addPolicy(policy);
    return policy;
  }

  /** Helper to add a deny policy. */
  function denyPolicy(
    agentId: string,
    operations: string[],
    namespaces: string[],
  ): AccessPolicy {
    const policy: AccessPolicy = {
      id: `deny-${agentId}-${operations.join('-')}-${namespaces.join('-')}`,
      version: 1,
      agentId,
      operations,
      resources: namespaces.map((ns) => `memory:${ns}`),
      effect: 'deny',
    };
    policyEngine.addPolicy(policy);
    return policy;
  }

  beforeEach(() => {
    policyEngine = new PolicyEngine();
    auditLog = new AuditLog();
    memoryStore = new MemoryStore({ policyEngine, auditLog });
  });

  // ----------------------------------------------------------------
  // Write and read with valid permissions
  // ----------------------------------------------------------------

  describe('write and read with valid permissions', () => {
    it('should write and read back a simple value', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['notes']);

      const writeResult = await memoryStore.write('agent-1', 'notes', 'key-1', 'hello');
      expect(writeResult.success).toBe(true);
      expect(writeResult.key).toBe('key-1');
      expect(writeResult.timestamp).toBeInstanceOf(Date);

      const readResult = await memoryStore.read('agent-1', 'notes', 'key-1');
      expect(readResult.found).toBe(true);
      expect(readResult.entry?.value).toBe('hello');
      expect(readResult.entry?.authorAgentId).toBe('agent-1');
      expect(readResult.entry?.namespace).toBe('notes');
      expect(readResult.entry?.key).toBe('key-1');
    });

    it('should persist metadata correctly on write', async () => {
      allowPolicy('agent-2', ['write', 'read'], ['research']);

      const tags = ['important', 'draft'];
      await memoryStore.write('agent-2', 'research', 'finding-1', { data: 42 }, tags);

      const result = await memoryStore.read('agent-2', 'research', 'finding-1');
      expect(result.found).toBe(true);
      expect(result.entry?.authorAgentId).toBe('agent-2');
      expect(result.entry?.namespace).toBe('research');
      expect(result.entry?.tags).toEqual(['important', 'draft']);
      expect(result.entry?.value).toEqual({ data: 42 });
      expect(result.entry?.timestamp).toBeInstanceOf(Date);
    });

    it('should default tags to empty array when not provided', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns']);

      await memoryStore.write('agent-1', 'ns', 'k', 'v');
      const result = await memoryStore.read('agent-1', 'ns', 'k');
      expect(result.entry?.tags).toEqual([]);
    });

    it('should overwrite existing entry with same key', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns']);

      await memoryStore.write('agent-1', 'ns', 'key', 'first');
      await memoryStore.write('agent-1', 'ns', 'key', 'second');

      const result = await memoryStore.read('agent-1', 'ns', 'key');
      expect(result.found).toBe(true);
      expect(result.entry?.value).toBe('second');
    });

    it('should store entries in different namespaces independently', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns-a']);
      allowPolicy('agent-1', ['write', 'read'], ['ns-b']);

      await memoryStore.write('agent-1', 'ns-a', 'key', 'value-a');
      await memoryStore.write('agent-1', 'ns-b', 'key', 'value-b');

      const resultA = await memoryStore.read('agent-1', 'ns-a', 'key');
      const resultB = await memoryStore.read('agent-1', 'ns-b', 'key');
      expect(resultA.entry?.value).toBe('value-a');
      expect(resultB.entry?.value).toBe('value-b');
    });

    it('should return found: false for non-existent key', async () => {
      allowPolicy('agent-1', ['read'], ['ns']);

      const result = await memoryStore.read('agent-1', 'ns', 'missing');
      expect(result.found).toBe(false);
      expect(result.entry).toBeUndefined();
    });

    it('should return found: false for non-existent namespace', async () => {
      allowPolicy('agent-1', ['read'], ['no-such-ns']);

      const result = await memoryStore.read('agent-1', 'no-such-ns', 'key');
      expect(result.found).toBe(false);
    });

    it('should record successful write in audit log', async () => {
      allowPolicy('agent-1', ['write'], ['ns']);

      await memoryStore.write('agent-1', 'ns', 'k', 'v');

      const entries = await auditLog.query({
        agentId: 'agent-1',
        eventType: 'memory_operation',
        decision: 'allow',
      });
      expect(entries.length).toBe(1);
      expect(entries[0].operation).toBe('write');
      expect(entries[0].resource).toBe('memory:ns/k');
    });

    it('should handle complex value types (objects, arrays, null)', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns']);

      await memoryStore.write('agent-1', 'ns', 'obj', { nested: { deep: true } });
      await memoryStore.write('agent-1', 'ns', 'arr', [1, 2, 3]);
      await memoryStore.write('agent-1', 'ns', 'nil', null);

      const obj = await memoryStore.read('agent-1', 'ns', 'obj');
      expect(obj.entry?.value).toEqual({ nested: { deep: true } });

      const arr = await memoryStore.read('agent-1', 'ns', 'arr');
      expect(arr.entry?.value).toEqual([1, 2, 3]);

      const nil = await memoryStore.read('agent-1', 'ns', 'nil');
      expect(nil.entry?.value).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Write denial and audit logging
  // ----------------------------------------------------------------

  describe('write denial and audit logging', () => {
    it('should deny write when no policy exists (default deny)', async () => {
      // No policies added — default deny.
      const result = await memoryStore.write('agent-1', 'secret', 'key', 'data');
      expect(result.success).toBe(false);
    });

    it('should record denial in audit log on write rejection', async () => {
      await memoryStore.write('agent-1', 'secret', 'key', 'data');

      const entries = await auditLog.query({
        agentId: 'agent-1',
        eventType: 'memory_operation',
        decision: 'deny',
      });
      expect(entries.length).toBe(1);
      expect(entries[0].operation).toBe('write');
      expect(entries[0].resource).toBe('memory:secret/key');
      expect(entries[0].details).toHaveProperty('reason');
    });

    it('should deny read when no policy exists', async () => {
      const result = await memoryStore.read('agent-1', 'secret', 'key');
      expect(result.found).toBe(false);
    });

    it('should record denial in audit log on read rejection', async () => {
      await memoryStore.read('agent-1', 'secret', 'key');

      const entries = await auditLog.query({
        agentId: 'agent-1',
        eventType: 'memory_operation',
        decision: 'deny',
      });
      expect(entries.length).toBe(1);
      expect(entries[0].operation).toBe('read');
      expect(entries[0].resource).toBe('memory:secret/key');
    });

    it('should deny write when an explicit deny policy overrides allow', async () => {
      allowPolicy('agent-1', ['write'], ['ns']);
      denyPolicy('agent-1', ['write'], ['ns']);

      const result = await memoryStore.write('agent-1', 'ns', 'key', 'data');
      expect(result.success).toBe(false);

      const entries = await auditLog.query({
        agentId: 'agent-1',
        decision: 'deny',
      });
      expect(entries.length).toBe(1);
    });

    it('should not persist data when write is denied', async () => {
      // First, allow agent-1 to read but not write.
      allowPolicy('agent-1', ['read'], ['ns']);

      const writeResult = await memoryStore.write('agent-1', 'ns', 'key', 'data');
      expect(writeResult.success).toBe(false);

      // Even if we add write permission later, the key should not exist.
      allowPolicy('agent-1', ['write'], ['ns']);
      // Read should still find nothing since the denied write didn't persist.
      const readResult = await memoryStore.read('agent-1', 'ns', 'key');
      expect(readResult.found).toBe(false);
    });

    it('should deny query when policy denies read access', async () => {
      // No read policy for agent-1 on 'restricted' namespace.
      const results = await memoryStore.query('agent-1', { namespace: 'restricted' });
      expect(results).toEqual([]);

      const entries = await auditLog.query({
        agentId: 'agent-1',
        eventType: 'memory_operation',
        decision: 'deny',
      });
      expect(entries.length).toBe(1);
      expect(entries[0].operation).toBe('query');
    });

    it('should allow one agent to write but deny another from reading', async () => {
      allowPolicy('writer', ['write'], ['shared']);
      allowPolicy('writer', ['read'], ['shared']);
      // reader has no policy for 'shared'.

      await memoryStore.write('writer', 'shared', 'key', 'secret-data');

      const readResult = await memoryStore.read('reader', 'shared', 'key');
      expect(readResult.found).toBe(false);

      const denials = await auditLog.query({
        agentId: 'reader',
        decision: 'deny',
      });
      expect(denials.length).toBe(1);
    });
  });

  // ----------------------------------------------------------------
  // Query with various filter combinations
  // ----------------------------------------------------------------

  describe('query with various filter combinations', () => {
    beforeEach(async () => {
      // Set up a wildcard allow policy for the test agent.
      allowPolicy('agent-1', ['write', 'read'], ['data']);
      allowPolicy('agent-2', ['write', 'read'], ['data']);
      allowPolicy('agent-1', ['read'], ['data']);

      // Seed data with different agents, tags, and timestamps.
      await memoryStore.write('agent-1', 'data', 'entry-1', 'v1', ['tag-a']);
      await memoryStore.write('agent-1', 'data', 'entry-2', 'v2', ['tag-b']);
      await memoryStore.write('agent-2', 'data', 'entry-3', 'v3', ['tag-a', 'tag-b']);
    });

    it('should return all entries in a namespace', async () => {
      const results = await memoryStore.query('agent-1', { namespace: 'data' });
      expect(results.length).toBe(3);
    });

    it('should filter by agentId', async () => {
      const results = await memoryStore.query('agent-1', {
        namespace: 'data',
        agentId: 'agent-2',
      });
      expect(results.length).toBe(1);
      expect(results[0].authorAgentId).toBe('agent-2');
    });

    it('should filter by single tag', async () => {
      const results = await memoryStore.query('agent-1', {
        namespace: 'data',
        tags: ['tag-a'],
      });
      expect(results.length).toBe(2);
      for (const entry of results) {
        expect(entry.tags).toContain('tag-a');
      }
    });

    it('should filter by multiple tags (AND logic)', async () => {
      const results = await memoryStore.query('agent-1', {
        namespace: 'data',
        tags: ['tag-a', 'tag-b'],
      });
      expect(results.length).toBe(1);
      expect(results[0].authorAgentId).toBe('agent-2');
    });

    it('should filter by time range', async () => {
      // Write an entry with a known time window.
      const before = new Date(Date.now() - 1000);
      await memoryStore.write('agent-1', 'data', 'timed', 'time-value', ['timed']);
      const after = new Date(Date.now() + 1000);

      const results = await memoryStore.query('agent-1', {
        namespace: 'data',
        timeRange: { start: before, end: after },
        tags: ['timed'],
      });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('timed');
    });

    it('should return empty array when no entries match', async () => {
      const results = await memoryStore.query('agent-1', {
        namespace: 'data',
        tags: ['nonexistent-tag'],
      });
      expect(results).toEqual([]);
    });

    it('should combine namespace and agentId filters', async () => {
      const results = await memoryStore.query('agent-1', {
        namespace: 'data',
        agentId: 'agent-1',
      });
      expect(results.length).toBe(2);
      for (const entry of results) {
        expect(entry.authorAgentId).toBe('agent-1');
        expect(entry.namespace).toBe('data');
      }
    });

    it('should return empty for a namespace with no entries', async () => {
      allowPolicy('agent-1', ['read'], ['empty-ns']);
      const results = await memoryStore.query('agent-1', { namespace: 'empty-ns' });
      expect(results).toEqual([]);
    });
  });

  // ----------------------------------------------------------------
  // Concurrent writes to same namespace
  // ----------------------------------------------------------------

  describe('concurrent writes to same namespace', () => {
    it('should handle multiple concurrent writes without data loss', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['shared']);

      // Fire off many writes concurrently.
      const writes = Array.from({ length: 20 }, (_, i) =>
        memoryStore.write('agent-1', 'shared', `key-${i}`, `value-${i}`),
      );

      const results = await Promise.all(writes);

      // All writes should succeed.
      for (const result of results) {
        expect(result.success).toBe(true);
      }

      // All entries should be readable.
      for (let i = 0; i < 20; i++) {
        const read = await memoryStore.read('agent-1', 'shared', `key-${i}`);
        expect(read.found).toBe(true);
        expect(read.entry?.value).toBe(`value-${i}`);
      }
    });

    it('should handle concurrent writes to the same key (last write wins)', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns']);

      // Write to the same key concurrently.
      const writes = Array.from({ length: 10 }, (_, i) =>
        memoryStore.write('agent-1', 'ns', 'same-key', `value-${i}`),
      );

      const results = await Promise.all(writes);
      for (const result of results) {
        expect(result.success).toBe(true);
      }

      // One value should be stored — the last one to execute.
      const read = await memoryStore.read('agent-1', 'ns', 'same-key');
      expect(read.found).toBe(true);
      expect(typeof read.entry?.value).toBe('string');
    });

    it('should handle concurrent writes from different agents', async () => {
      allowPolicy('agent-a', ['write', 'read'], ['shared']);
      allowPolicy('agent-b', ['write', 'read'], ['shared']);

      const writesA = Array.from({ length: 5 }, (_, i) =>
        memoryStore.write('agent-a', 'shared', `a-key-${i}`, `a-val-${i}`),
      );
      const writesB = Array.from({ length: 5 }, (_, i) =>
        memoryStore.write('agent-b', 'shared', `b-key-${i}`, `b-val-${i}`),
      );

      await Promise.all([...writesA, ...writesB]);

      // All 10 entries should be present.
      const results = await memoryStore.query('agent-a', { namespace: 'shared' });
      expect(results.length).toBe(10);
    });

    it('should produce audit entries for all concurrent writes', async () => {
      allowPolicy('agent-1', ['write'], ['ns']);

      const writes = Array.from({ length: 5 }, (_, i) =>
        memoryStore.write('agent-1', 'ns', `key-${i}`, `val-${i}`),
      );
      await Promise.all(writes);

      const entries = await auditLog.query({
        agentId: 'agent-1',
        eventType: 'memory_operation',
        decision: 'allow',
      });
      expect(entries.length).toBe(5);
    });
  });

  // ----------------------------------------------------------------
  // Empty namespace and edge cases
  // ----------------------------------------------------------------

  describe('empty namespace and edge cases', () => {
    it('should handle deleteNamespace on existing namespace', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['to-delete']);

      await memoryStore.write('agent-1', 'to-delete', 'k1', 'v1');
      await memoryStore.write('agent-1', 'to-delete', 'k2', 'v2');

      await memoryStore.deleteNamespace('to-delete', 'operator-1');

      // Entries should no longer be readable.
      const result = await memoryStore.read('agent-1', 'to-delete', 'k1');
      expect(result.found).toBe(false);
    });

    it('should record deleteNamespace in audit log', async () => {
      allowPolicy('agent-1', ['write'], ['ns']);
      await memoryStore.write('agent-1', 'ns', 'k', 'v');

      await memoryStore.deleteNamespace('ns', 'operator-1');

      const entries = await auditLog.query({
        eventType: 'operator_action',
      });
      expect(entries.length).toBe(1);
      expect(entries[0].operation).toBe('delete_namespace');
      expect(entries[0].operatorId).toBe('operator-1');
      expect(entries[0].details).toHaveProperty('existed', true);
    });

    it('should handle deleteNamespace on non-existent namespace gracefully', async () => {
      await memoryStore.deleteNamespace('nonexistent', 'operator-1');

      const entries = await auditLog.query({
        eventType: 'operator_action',
      });
      expect(entries.length).toBe(1);
      expect(entries[0].details).toHaveProperty('existed', false);
    });

    it('should handle empty string key', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns']);

      const writeResult = await memoryStore.write('agent-1', 'ns', '', 'empty-key-value');
      expect(writeResult.success).toBe(true);

      const readResult = await memoryStore.read('agent-1', 'ns', '');
      expect(readResult.found).toBe(true);
      expect(readResult.entry?.value).toBe('empty-key-value');
    });

    it('should handle empty string namespace', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['']);

      const writeResult = await memoryStore.write('agent-1', '', 'key', 'value');
      expect(writeResult.success).toBe(true);

      const readResult = await memoryStore.read('agent-1', '', 'key');
      expect(readResult.found).toBe(true);
      expect(readResult.entry?.value).toBe('value');
    });

    it('should handle writing undefined as value', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns']);

      await memoryStore.write('agent-1', 'ns', 'key', undefined);
      const result = await memoryStore.read('agent-1', 'ns', 'key');
      expect(result.found).toBe(true);
      expect(result.entry?.value).toBeUndefined();
    });

    it('should handle query with no filters (wildcard)', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['ns-1']);
      allowPolicy('agent-1', ['write', 'read'], ['ns-2']);
      // Also need wildcard read for cross-namespace query.
      policyEngine.addPolicy({
        id: 'allow-agent-1-read-wildcard',
        version: 1,
        agentId: 'agent-1',
        operations: ['read'],
        resources: ['memory:*'],
        effect: 'allow',
      });

      await memoryStore.write('agent-1', 'ns-1', 'k1', 'v1');
      await memoryStore.write('agent-1', 'ns-2', 'k2', 'v2');

      const results = await memoryStore.query('agent-1', {});
      expect(results.length).toBe(2);
    });

    it('should allow re-writing to a namespace after deleteNamespace', async () => {
      allowPolicy('agent-1', ['write', 'read'], ['recycled']);

      await memoryStore.write('agent-1', 'recycled', 'k', 'original');
      await memoryStore.deleteNamespace('recycled', 'operator-1');

      await memoryStore.write('agent-1', 'recycled', 'k', 'new-value');
      const result = await memoryStore.read('agent-1', 'recycled', 'k');
      expect(result.found).toBe(true);
      expect(result.entry?.value).toBe('new-value');
    });

    it('should query across multiple namespaces when no namespace filter is set', async () => {
      allowPolicy('agent-1', ['write'], ['alpha']);
      allowPolicy('agent-1', ['write'], ['beta']);
      policyEngine.addPolicy({
        id: 'allow-agent-1-read-all',
        version: 1,
        agentId: 'agent-1',
        operations: ['read'],
        resources: ['memory:*'],
        effect: 'allow',
      });

      await memoryStore.write('agent-1', 'alpha', 'k1', 'v1', ['shared-tag']);
      await memoryStore.write('agent-1', 'beta', 'k2', 'v2', ['shared-tag']);

      const results = await memoryStore.query('agent-1', { tags: ['shared-tag'] });
      expect(results.length).toBe(2);
      const namespaces = results.map((e) => e.namespace);
      expect(namespaces).toContain('alpha');
      expect(namespaces).toContain('beta');
    });
  });
});
