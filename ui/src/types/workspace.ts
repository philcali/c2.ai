/** A tracked workspace (git repository) accessed during a session. */
export interface WorkspaceEntry {
  repository: string;
  path: string;
  filesAccessed: string[];
  filesModified: string[];
}

/** Client-side workspace state managed by the workspace store. */
export interface WorkspaceState {
  /** sessionId → workspace entries */
  workspaces: Map<string, WorkspaceEntry[]>;
}
