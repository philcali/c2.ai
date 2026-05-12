import { create } from 'zustand';
import type { WorkspaceEntry } from '../types/index.js';

/**
 * Actions exposed by the workspace store.
 */
export interface WorkspaceActions {
  /** Add a new workspace entry for a session. */
  addWorkspace: (sessionId: string, entry: WorkspaceEntry) => void;
  /**
   * Update an existing workspace entry (matched by repository + path).
   * Merges `filesAccessed` and `filesModified` arrays, deduplicating entries.
   */
  updateWorkspace: (
    sessionId: string,
    repository: string,
    path: string,
    patch: Partial<Pick<WorkspaceEntry, 'filesAccessed' | 'filesModified'>>,
  ) => void;
}

export interface WorkspaceStoreState {
  /** sessionId → workspace entries */
  workspaces: Map<string, WorkspaceEntry[]>;
}

export type WorkspaceStore = WorkspaceStoreState & WorkspaceActions;

/** Deduplicate an array of strings. */
function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  // -- State --
  workspaces: new Map(),

  // -- Actions --

  addWorkspace: (sessionId, entry) =>
    set((state) => {
      const updated = new Map(state.workspaces);
      const existing = updated.get(sessionId) ?? [];
      updated.set(sessionId, [...existing, entry]);
      return { workspaces: updated };
    }),

  updateWorkspace: (sessionId, repository, path, patch) =>
    set((state) => {
      const updated = new Map(state.workspaces);
      const entries = updated.get(sessionId);
      if (!entries) return state;

      const updatedEntries = entries.map((entry) => {
        if (entry.repository !== repository || entry.path !== path) return entry;

        return {
          ...entry,
          filesAccessed: patch.filesAccessed
            ? unique([...entry.filesAccessed, ...patch.filesAccessed])
            : entry.filesAccessed,
          filesModified: patch.filesModified
            ? unique([...entry.filesModified, ...patch.filesModified])
            : entry.filesModified,
        };
      });

      updated.set(sessionId, updatedEntries);
      return { workspaces: updated };
    }),
}));
