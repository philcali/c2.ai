import { v4 as uuidv4 } from 'uuid';
import type {
  IMemoryStore,
  MemoryEntry,
  MemoryQuery,
  WriteResult,
  ReadResult,
} from '../interfaces/memory-store.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IAuditLog } from '../interfaces/audit-log.js';

/**
 * In-memory, namespaced Memory Store with policy-controlled access.
 *
 * Guarantees:
 *  - All read/write operations are checked against the Policy Engine.
 *  - Denied operations are recorded in the Audit Log.
 *  - Successful writes persist metadata: authorAgentId, timestamp, namespace, tags.
 *  - Query supports filtering by namespace, agentId, timeRange, and tags.
 *  - Concurrent writes to the same namespace are handled safely via
 *    synchronous in-memory Map operations (single-threaded Node.js event loop).
 *  - deleteNamespace() is an operator-level administration action.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
export class MemoryStore implements IMemoryStore {
  /**
   * Two-level map: namespace → key → MemoryEntry.
   * Using a Map of Maps keeps namespace operations (delete, query) efficient.
   */
  private readonly store: Map<string, Map<string, MemoryEntry>> = new Map();

  /** Policy Engine for authorization checks. */
  private readonly policyEngine: IPolicyEngine;

  /** Audit Log for recording operations and denials. */
  private readonly auditLog: IAuditLog;

  constructor(options: {
    policyEngine: IPolicyEngine;
    auditLog: IAuditLog;
  }) {
    this.policyEngine = options.policyEngine;
    this.auditLog = options.auditLog;
  }

  // ------------------------------------------------------------------
  // IMemoryStore — Write
  // ------------------------------------------------------------------

  async write(
    agentId: string,
    namespace: string,
    key: string,
    value: unknown,
    tags?: string[],
  ): Promise<WriteResult> {
    const now = new Date();

    // Policy check: agent must have write permission for this namespace.
    const decision = this.policyEngine.evaluate({
      agentId,
      operation: 'write',
      resource: `memory:${namespace}`,
    });

    if (!decision.allowed) {
      // Record denial in audit log.
      await this.auditLog.record({
        sequenceNumber: 0, // assigned by AuditLog
        timestamp: now,
        agentId,
        eventType: 'memory_operation',
        operation: 'write',
        resource: `memory:${namespace}/${key}`,
        decision: 'deny',
        details: {
          reason: decision.reason,
          policyId: decision.policyId,
        },
      });

      return {
        success: false,
        key,
        timestamp: now,
      };
    }

    // Build the memory entry with full metadata.
    const entry: MemoryEntry = {
      namespace,
      key,
      value,
      authorAgentId: agentId,
      timestamp: now,
      tags: tags ?? [],
    };

    // Get or create the namespace bucket.
    let namespaceBucket = this.store.get(namespace);
    if (!namespaceBucket) {
      namespaceBucket = new Map<string, MemoryEntry>();
      this.store.set(namespace, namespaceBucket);
    }

    // Store the entry (overwrites any existing entry with the same key).
    namespaceBucket.set(key, entry);

    // Record successful write in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId,
      eventType: 'memory_operation',
      operation: 'write',
      resource: `memory:${namespace}/${key}`,
      decision: 'allow',
      details: {
        namespace,
        key,
        tags: entry.tags,
      },
    });

    return {
      success: true,
      key,
      timestamp: now,
    };
  }

  // ------------------------------------------------------------------
  // IMemoryStore — Read
  // ------------------------------------------------------------------

  async read(
    agentId: string,
    namespace: string,
    key: string,
  ): Promise<ReadResult> {
    const now = new Date();

    // Policy check: agent must have read permission for this namespace.
    const decision = this.policyEngine.evaluate({
      agentId,
      operation: 'read',
      resource: `memory:${namespace}`,
    });

    if (!decision.allowed) {
      // Record denial in audit log.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'memory_operation',
        operation: 'read',
        resource: `memory:${namespace}/${key}`,
        decision: 'deny',
        details: {
          reason: decision.reason,
          policyId: decision.policyId,
        },
      });

      return { found: false };
    }

    // Look up the entry.
    const namespaceBucket = this.store.get(namespace);
    if (!namespaceBucket) {
      return { found: false };
    }

    const entry = namespaceBucket.get(key);
    if (!entry) {
      return { found: false };
    }

    return { found: true, entry };
  }

  // ------------------------------------------------------------------
  // IMemoryStore — Query
  // ------------------------------------------------------------------

  async query(
    agentId: string,
    query: MemoryQuery,
  ): Promise<MemoryEntry[]> {
    // Policy check: agent must have read permission for the queried namespace.
    // If no namespace is specified, we check a wildcard resource.
    const resourceToCheck = query.namespace
      ? `memory:${query.namespace}`
      : 'memory:*';

    const decision = this.policyEngine.evaluate({
      agentId,
      operation: 'read',
      resource: resourceToCheck,
    });

    if (!decision.allowed) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId,
        eventType: 'memory_operation',
        operation: 'query',
        resource: resourceToCheck,
        decision: 'deny',
        details: {
          reason: decision.reason,
          policyId: decision.policyId,
          query,
        },
      });

      return [];
    }

    const results: MemoryEntry[] = [];

    // Determine which namespaces to scan.
    const namespacesToScan = query.namespace
      ? [query.namespace]
      : Array.from(this.store.keys());

    for (const ns of namespacesToScan) {
      const bucket = this.store.get(ns);
      if (!bucket) {
        continue;
      }

      for (const entry of bucket.values()) {
        if (this.matchesQuery(entry, query)) {
          results.push(entry);
        }
      }
    }

    return results;
  }

  // ------------------------------------------------------------------
  // IMemoryStore — Delete Namespace (operator-level)
  // ------------------------------------------------------------------

  async deleteNamespace(
    namespace: string,
    operatorId: string,
  ): Promise<void> {
    const existed = this.store.delete(namespace);

    // Record the administrative action in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      operatorId,
      eventType: 'operator_action',
      operation: 'delete_namespace',
      resource: `memory:${namespace}`,
      details: {
        namespace,
        existed,
      },
    });
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Check whether a MemoryEntry matches all specified query filters.
   * An entry matches if it satisfies every non-undefined filter criterion.
   */
  private matchesQuery(entry: MemoryEntry, query: MemoryQuery): boolean {
    // Namespace filter
    if (query.namespace !== undefined && entry.namespace !== query.namespace) {
      return false;
    }

    // Agent ID filter
    if (query.agentId !== undefined && entry.authorAgentId !== query.agentId) {
      return false;
    }

    // Time range filter
    if (query.timeRange !== undefined) {
      const ts = entry.timestamp.getTime();
      if (
        ts < query.timeRange.start.getTime() ||
        ts > query.timeRange.end.getTime()
      ) {
        return false;
      }
    }

    // Tags filter — entry must contain ALL queried tags
    if (query.tags !== undefined && query.tags.length > 0) {
      for (const tag of query.tags) {
        if (!entry.tags.includes(tag)) {
          return false;
        }
      }
    }

    return true;
  }
}
