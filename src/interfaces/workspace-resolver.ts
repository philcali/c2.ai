import type { StructuredIntent, WorkspaceContext, WorkspaceMetadata } from './orchestration-config.js';

/**
 * IWorkspaceResolver — Finds or creates the correct workspace context
 * for a given structured intent.
 *
 * The Workspace_Resolver queries the Memory_Store for existing workspace
 * entries matching the intent's repository reference. If a match is found,
 * the existing workspace is reused. If not, a new workspace context is
 * created and persisted.
 *
 * Repository references are normalized to handle SSH, HTTPS, trailing .git,
 * and shorthand formats consistently.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 8.1, 8.2, 8.3
 */
export interface IWorkspaceResolver {
  /**
   * Resolve a workspace from a structured intent.
   *
   * Queries the Memory_Store for an existing workspace matching the intent's
   * repository reference. If found, reuses the existing workspace context
   * (updating the last-used timestamp). If not found, creates a new workspace
   * context by cloning the repository and persisting the metadata.
   *
   * @param intent - The structured intent containing repository and branch info
   * @returns The resolved workspace context
   * @throws Error if the repository is not reachable or workspace cannot be created
   */
  resolve(intent: StructuredIntent): Promise<WorkspaceContext>;

  /**
   * Validate that a workspace is accessible.
   *
   * Checks that the workspace's local path exists and the repository
   * is reachable.
   *
   * @param workspace - The workspace context to validate
   * @returns true if the workspace is accessible, false otherwise
   */
  validate(workspace: WorkspaceContext): Promise<boolean>;

  /**
   * Normalize a repository reference to a canonical URL.
   *
   * Handles SSH URLs, HTTPS URLs, trailing .git, and shorthand
   * "owner/repo" formats, producing a consistent canonical form.
   *
   * @param ref - The repository reference in any supported format
   * @returns The normalized canonical URL string
   */
  normalizeRepoRef(ref: string): string;

  /**
   * List all known workspaces from the Memory_Store.
   *
   * @returns Array of workspace metadata entries
   */
  listWorkspaces(): Promise<WorkspaceMetadata[]>;

  /**
   * Evict a workspace from the cache.
   *
   * Removes the workspace metadata from the Memory_Store. Does not
   * delete the local files on disk.
   *
   * @param workspaceId - The ID of the workspace to evict
   */
  evict(workspaceId: string): Promise<void>;
}
