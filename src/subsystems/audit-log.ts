import {
  IAuditLog,
  AuditEntry,
  AuditQuery,
  AuditFilter,
} from '../interfaces/audit-log.js';

/**
 * In-memory, append-only Audit Log implementation.
 *
 * Guarantees:
 *  - Monotonically increasing sequence numbers assigned on record().
 *  - Append-only: no update or delete operations are exposed.
 *  - Query filtering by agentId, timeRange, eventType, decision, afterSequence.
 *  - Real-time streaming via AsyncIterable that yields new entries as they arrive.
 */
export class AuditLog implements IAuditLog {
  /** Append-only entry store — entries are never mutated or removed. */
  private readonly entries: AuditEntry[] = [];

  /** Next sequence number to assign. Starts at 1 so 0 means "no entries yet". */
  private nextSequence = 1;

  /**
   * Listeners waiting for new entries (used by stream()).
   * Each listener is a callback that receives a newly recorded entry.
   */
  private readonly listeners: Set<(entry: AuditEntry) => void> = new Set();

  // ------------------------------------------------------------------
  // IAuditLog implementation
  // ------------------------------------------------------------------

  async record(entry: AuditEntry): Promise<void> {
    // Stamp the entry with the next monotonically increasing sequence number.
    const stamped: AuditEntry = {
      ...entry,
      sequenceNumber: this.nextSequence++,
    };

    this.entries.push(stamped);

    // Notify any active stream listeners.
    for (const listener of this.listeners) {
      listener(stamped);
    }
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    return this.entries.filter((e) => this.matchesQuery(e, query));
  }

  stream(filter: AuditFilter): AsyncIterable<AuditEntry> {
    const listeners = this.listeners;

    // Return an AsyncIterable that yields entries matching the filter
    // as they are recorded in real time.
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<AuditEntry> {
        // Unbounded buffer of entries waiting to be consumed by the caller.
        const buffer: AuditEntry[] = [];

        // If the caller is awaiting the next entry we resolve their promise
        // directly instead of buffering.
        let waiting: ((value: IteratorResult<AuditEntry>) => void) | null =
          null;

        const listener = (entry: AuditEntry): void => {
          if (!matchesFilter(entry, filter)) {
            return;
          }

          if (waiting) {
            const resolve = waiting;
            waiting = null;
            resolve({ value: entry, done: false });
          } else {
            buffer.push(entry);
          }
        };

        listeners.add(listener);

        return {
          next(): Promise<IteratorResult<AuditEntry>> {
            // Drain buffer first.
            if (buffer.length > 0) {
              return Promise.resolve({
                value: buffer.shift()!,
                done: false,
              });
            }

            // Otherwise park until the next matching entry arrives.
            return new Promise<IteratorResult<AuditEntry>>((resolve) => {
              waiting = resolve;
            });
          },

          return(): Promise<IteratorResult<AuditEntry>> {
            listeners.delete(listener);
            // Resolve any parked waiter so it doesn't leak.
            if (waiting) {
              waiting({ value: undefined as unknown as AuditEntry, done: true });
              waiting = null;
            }
            return Promise.resolve({
              value: undefined as unknown as AuditEntry,
              done: true,
            });
          },

          throw(err?: unknown): Promise<IteratorResult<AuditEntry>> {
            listeners.delete(listener);
            if (waiting) {
              waiting({ value: undefined as unknown as AuditEntry, done: true });
              waiting = null;
            }
            return Promise.reject(err);
          },

          [Symbol.asyncIterator]() {
            return this;
          },
        };
      },
    };
  }

  getSequenceNumber(): number {
    // Return the highest assigned sequence number, or 0 if nothing recorded.
    return this.nextSequence - 1;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private matchesQuery(entry: AuditEntry, query: AuditQuery): boolean {
    return matchesFilter(entry, query);
  }
}

// ------------------------------------------------------------------
// Standalone filter helper (used by both query and stream)
// ------------------------------------------------------------------

function matchesFilter(entry: AuditEntry, filter: AuditQuery): boolean {
  if (filter.agentId !== undefined && entry.agentId !== filter.agentId) {
    return false;
  }

  if (filter.eventType !== undefined && entry.eventType !== filter.eventType) {
    return false;
  }

  if (filter.decision !== undefined && entry.decision !== filter.decision) {
    return false;
  }

  if (filter.afterSequence !== undefined && entry.sequenceNumber <= filter.afterSequence) {
    return false;
  }

  if (filter.timeRange !== undefined) {
    const ts = entry.timestamp.getTime();
    if (ts < filter.timeRange.start.getTime() || ts > filter.timeRange.end.getTime()) {
      return false;
    }
  }

  return true;
}
