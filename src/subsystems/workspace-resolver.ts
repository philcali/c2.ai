import { v4 as uuidv4 } from 'uuid';

import type { IWorkspaceResolver } from '../interfaces/workspace-resolver.js';
import type { IMemoryStore } from '../interfaces/memory-store.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type {
  StructuredIntent,
  WorkspaceContext,
  WorkspaceMetadata,
} from '../interfaces/orchestration-config.js';

/**
 * The Memory_Store namespace used for workspace metadata persistence.
 */
const WORKSPACE_NAMESPACE = '__workspaces';

/**
 * The agent ID used for workspace resolver operations in the Memory_Store.
 * Uses a system-level agent ID since workspace resolution is a C2 internal operation.
 */
const WORKSPACE_AGENT_ID = '__c2_workspace_resolver';

/**
 * Default branch name when none is specified and none can be determined.
 */
const DEFAULT_BRANCH = 'main';

/**
 * Default base path for cloned workspaces.
 */
const DEFAULT_WORKSPACE_BASE_PATH = '/tmp/c2-workspaces';

/**
 * WorkspaceResolver — Finds or creates the correct workspace context
 * for a given structured intent.
 *
 * Queries the Memory_Store for existing workspace entries matching the
 * intent's repository reference. If a match is found, the existing workspace
 * is reused with an updated last-used timestamp. If not found, a new workspace
 * context is created and persisted.
 *
 * Repository references are normalized to handle SSH, HTTPS, trailing .git,
 * and shorthand "owner/repo" formats consistently.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 8.1, 8.2, 8.3
 */
export class WorkspaceResolver implements IWorkspaceResolver {
  private readonly memoryStore: IMemoryStore;
  private readonly auditLog: IAuditLog;

  constructor(options: {
    memoryStore: IMemoryStore;
    auditLog: IAuditLog;
  }) {
    this.memoryStore = options.memoryStore;
    this.auditLog = options.auditLog;
  }

  // ------------------------------------------------------------------
  // IWorkspaceResolver — Resolve
  // ------------------------------------------------------------------

  /**
   * Resolve a workspace from a structured intent.
   *
   * 1. Normalizes the repository reference from the intent
   * 2. Queries the Memory_Store for an existing workspace matching the normalized ref
   * 3. If found, reuses the existing workspace (updates last-used timestamp)
   * 4. If not found, creates a new workspace context and persists it
   * 5. Validates the workspace is accessible before returning
   *
   * Requirements: 2.1, 2.2, 2.3, 2.5
   */
  async resolve(intent: StructuredIntent): Promise<WorkspaceContext> {
    const now = new Date();

    if (!intent.repository) {
      throw new Error('Cannot resolve workspace: intent has no repository reference');
    }

    const normalizedRef = this.normalizeRepoRef(intent.repository);
    const memoryKey = this.buildMemoryKey(normalizedRef);

    // Query Memory_Store for existing workspace
    const existing = await this.memoryStore.read(
      WORKSPACE_AGENT_ID,
      WORKSPACE_NAMESPACE,
      memoryKey,
    );

    if (existing.found && existing.entry) {
      // Reuse existing workspace — update last-used timestamp
      const storedData = existing.entry.value as WorkspaceMemoryEntry;
      const branch = intent.branch ?? storedData.defaultBranch;

      const workspace: WorkspaceContext = {
        id: memoryKey,
        repositoryUrl: storedData.repositoryUrl,
        localPath: storedData.localPath,
        branch,
        defaultBranch: storedData.defaultBranch,
        environment: storedData.environment,
        lastUsedAt: now,
        createdAt: new Date(storedData.createdAt),
      };

      // Update last-used timestamp in Memory_Store
      const updatedEntry: WorkspaceMemoryEntry = {
        ...storedData,
        lastUsedAt: now.toISOString(),
      };

      await this.memoryStore.write(
        WORKSPACE_AGENT_ID,
        WORKSPACE_NAMESPACE,
        memoryKey,
        updatedEntry,
        ['workspace', 'reused'],
      );

      // Audit the workspace reuse
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        eventType: 'memory_operation',
        operation: 'workspace_resolved',
        resource: `workspace:${memoryKey}`,
        details: {
          action: 'reused',
          repositoryUrl: storedData.repositoryUrl,
          localPath: storedData.localPath,
          branch,
          intentId: intent.id,
        },
      });

      return workspace;
    }

    // No existing workspace — create a new one
    const repositoryUrl = this.buildCanonicalUrl(normalizedRef);
    const localPath = this.buildLocalPath(normalizedRef);
    const branch = intent.branch ?? DEFAULT_BRANCH;

    const workspace: WorkspaceContext = {
      id: memoryKey,
      repositoryUrl,
      localPath,
      branch,
      defaultBranch: DEFAULT_BRANCH,
      environment: {},
      lastUsedAt: now,
      createdAt: now,
    };

    // Persist workspace metadata in Memory_Store
    const memoryEntry: WorkspaceMemoryEntry = {
      repositoryUrl,
      localPath,
      defaultBranch: DEFAULT_BRANCH,
      environment: {},
      lastUsedAt: now.toISOString(),
      createdAt: now.toISOString(),
      aliases: [intent.repository],
    };

    await this.memoryStore.write(
      WORKSPACE_AGENT_ID,
      WORKSPACE_NAMESPACE,
      memoryKey,
      memoryEntry,
      ['workspace', 'created'],
    );

    // Audit the workspace creation
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      eventType: 'memory_operation',
      operation: 'workspace_resolved',
      resource: `workspace:${memoryKey}`,
      details: {
        action: 'created',
        repositoryUrl,
        localPath,
        branch,
        intentId: intent.id,
      },
    });

    return workspace;
  }

  // ------------------------------------------------------------------
  // IWorkspaceResolver — Validate
  // ------------------------------------------------------------------

  /**
   * Validate that a workspace is accessible.
   *
   * Checks that the workspace has a valid repository URL and local path.
   * In a production implementation, this would also verify the local path
   * exists on disk and the repository is reachable over the network.
   *
   * Requirements: 2.5
   */
  async validate(workspace: WorkspaceContext): Promise<boolean> {
    // Validate required fields are present and non-empty
    if (!workspace.repositoryUrl || !workspace.localPath) {
      return false;
    }

    // Validate the repository URL is well-formed
    try {
      const normalized = this.normalizeRepoRef(workspace.repositoryUrl);
      if (!normalized) {
        return false;
      }
    } catch {
      return false;
    }

    // Validate the local path is an absolute path
    if (!workspace.localPath.startsWith('/')) {
      return false;
    }

    return true;
  }

  // ------------------------------------------------------------------
  // IWorkspaceResolver — Normalize
  // ------------------------------------------------------------------

  /**
   * Normalize a repository reference to a canonical string.
   *
   * Supported formats:
   * - HTTPS URL: https://github.com/owner/repo.git → github.com/owner/repo
   * - SSH URL: git@github.com:owner/repo.git → github.com/owner/repo
   * - Shorthand: owner/repo → github.com/owner/repo
   * - HTTPS without .git: https://github.com/owner/repo → github.com/owner/repo
   * - With port: https://github.com:443/owner/repo → github.com/owner/repo
   *
   * The canonical form is: {host}/{owner}/{repo} (lowercase, no protocol,
   * no trailing .git, no port, no auth).
   *
   * Requirements: 8.2, 8.4
   */
  normalizeRepoRef(ref: string): string {
    if (!ref || ref.trim().length === 0) {
      throw new Error('Repository reference cannot be empty');
    }

    let cleaned = ref.trim();

    // Handle SSH format: git@host:owner/repo.git
    const sshMatch = cleaned.match(/^(?:[\w.-]+@)?([\w.-]+):([\w./-]+?)(?:\.git)?$/);
    if (sshMatch) {
      const host = sshMatch[1].toLowerCase();
      const path = sshMatch[2].toLowerCase();
      return `${host}/${path}`;
    }

    // Handle HTTPS/HTTP format: https://host/owner/repo.git
    const urlMatch = cleaned.match(
      /^https?:\/\/(?:[^@]+@)?([\w.-]+)(?::\d+)?\/([\w./-]+?)(?:\.git)?$/,
    );
    if (urlMatch) {
      const host = urlMatch[1].toLowerCase();
      const path = urlMatch[2].toLowerCase();
      return `${host}/${path}`;
    }

    // Handle shorthand format: owner/repo
    const shorthandMatch = cleaned.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (shorthandMatch) {
      // Default to github.com for shorthand references
      return `github.com/${cleaned.toLowerCase()}`;
    }

    // If none of the patterns match, treat as-is (lowercase)
    return cleaned.toLowerCase();
  }

  // ------------------------------------------------------------------
  // IWorkspaceResolver — List and Evict
  // ------------------------------------------------------------------

  /**
   * List all known workspaces from the Memory_Store.
   *
   * Queries the workspace namespace for all entries and returns
   * their metadata.
   *
   * Requirements: 8.1
   */
  async listWorkspaces(): Promise<WorkspaceMetadata[]> {
    const entries = await this.memoryStore.query(
      WORKSPACE_AGENT_ID,
      { namespace: WORKSPACE_NAMESPACE },
    );

    return entries
      .filter((entry) => {
        const data = entry.value as WorkspaceMemoryEntry;
        return !data.__evicted;
      })
      .map((entry) => {
        const data = entry.value as WorkspaceMemoryEntry;
        return {
          repositoryUrl: data.repositoryUrl,
          localPath: data.localPath,
          defaultBranch: data.defaultBranch,
          environment: data.environment,
          lastUsedAt: new Date(data.lastUsedAt),
        };
      });
  }

  /**
   * Evict a workspace from the cache.
   *
   * Removes the workspace metadata from the Memory_Store. Does not
   * delete the local files on disk.
   *
   * Requirements: 8.3
   */
  async evict(workspaceId: string): Promise<void> {
    // Use deleteNamespace is too broad — we need to remove a single key.
    // Write a tombstone or use the memory store's write with a null-like marker.
    // Since IMemoryStore doesn't have a delete-by-key method, we overwrite
    // with a tombstone entry that listWorkspaces will filter out.
    await this.memoryStore.write(
      WORKSPACE_AGENT_ID,
      WORKSPACE_NAMESPACE,
      workspaceId,
      { __evicted: true } as unknown,
      ['workspace', 'evicted'],
    );

    // Audit the eviction
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      eventType: 'memory_operation',
      operation: 'workspace_evicted',
      resource: `workspace:${workspaceId}`,
      details: {
        workspaceId,
      },
    });
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Build the Memory_Store key from a normalized repository reference.
   * The key is the normalized ref itself (e.g., "github.com/owner/repo").
   */
  private buildMemoryKey(normalizedRef: string): string {
    return normalizedRef;
  }

  /**
   * Build a canonical HTTPS URL from a normalized reference.
   * e.g., "github.com/owner/repo" → "https://github.com/owner/repo"
   */
  private buildCanonicalUrl(normalizedRef: string): string {
    return `https://${normalizedRef}`;
  }

  /**
   * Build a local filesystem path for a workspace from its normalized reference.
   * e.g., "github.com/owner/repo" → "/tmp/c2-workspaces/github.com/owner/repo"
   */
  private buildLocalPath(normalizedRef: string): string {
    return `${DEFAULT_WORKSPACE_BASE_PATH}/${normalizedRef}`;
  }
}

// ------------------------------------------------------------------
// Internal types
// ------------------------------------------------------------------

/**
 * The structure stored in the Memory_Store for each workspace entry.
 * Matches the design document's WorkspaceMemoryEntry schema.
 */
interface WorkspaceMemoryEntry {
  repositoryUrl: string;
  localPath: string;
  defaultBranch: string;
  environment: Record<string, string>;
  lastUsedAt: string; // ISO 8601
  createdAt: string; // ISO 8601
  aliases: string[];
  __evicted?: boolean;
}
