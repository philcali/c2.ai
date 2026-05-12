import { useState, useCallback } from 'react';
import { useWorkspaceStore } from '../../stores/workspaceStore.js';
import type { WorkspaceEntry } from '../../types/index.js';
import styles from './WorkspaceIndicator.module.css';

/** Stable empty array to avoid re-render loops when no workspaces exist. */
const EMPTY_WORKSPACES: WorkspaceEntry[] = [];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkspaceIndicatorProps {
  /** The active session ID whose workspaces should be displayed. */
  sessionId: string | null;
}

// ---------------------------------------------------------------------------
// Sub-component: single workspace entry
// ---------------------------------------------------------------------------

interface WorkspaceEntryItemProps {
  entry: WorkspaceEntry;
}

function WorkspaceEntryItem({ entry }: WorkspaceEntryItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);

  const hasFiles =
    entry.filesAccessed.length > 0 || entry.filesModified.length > 0;

  return (
    <li className={styles.workspaceEntry} data-testid={`workspace-entry-${entry.repository}`}>
      <div
        className={styles.workspaceHeader}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`Workspace ${entry.repository}`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={styles.repoIcon} aria-hidden="true">
          📁
        </span>
        <div className={styles.workspaceInfo}>
          <span className={styles.repoName} data-testid="workspace-repo-name">
            {entry.repository}
          </span>
          <span className={styles.repoPath} data-testid="workspace-repo-path">
            {entry.path}
          </span>
        </div>
        {hasFiles && (
          <span
            className={`${styles.entryExpandIcon} ${isExpanded ? styles.entryExpandIconExpanded : ''}`}
            aria-hidden="true"
          >
            ▶
          </span>
        )}
      </div>

      {isExpanded && hasFiles && (
        <div className={styles.fileDetails} data-testid="workspace-file-details">
          {entry.filesAccessed.length > 0 && (
            <div className={styles.fileSection}>
              <div className={styles.fileSectionLabel}>Accessed</div>
              <ul className={styles.fileList} data-testid="workspace-files-accessed">
                {entry.filesAccessed.map((file) => (
                  <li key={file} className={styles.fileItem}>
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {entry.filesModified.length > 0 && (
            <div className={styles.fileSection}>
              <div className={styles.fileSectionLabel}>Modified</div>
              <ul className={styles.fileList} data-testid="workspace-files-modified">
                {entry.filesModified.map((file) => (
                  <li key={file} className={`${styles.fileItem} ${styles.fileItemModified}`}>
                    {file}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Collapsible panel that displays tracked workspaces (git repositories)
 * for the active session. Each workspace entry can be expanded to show
 * files accessed and modified.
 *
 * The component reads from the workspace Zustand store, which is updated
 * in real-time via WebSocket events.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */
export function WorkspaceIndicator({ sessionId }: WorkspaceIndicatorProps) {
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const workspacesFromStore = useWorkspaceStore((s) =>
    sessionId ? s.workspaces.get(sessionId) : undefined,
  );
  const workspaces = workspacesFromStore ?? EMPTY_WORKSPACES;

  const togglePanel = useCallback(() => setIsPanelOpen((prev) => !prev), []);

  return (
    <div className={styles.workspaceIndicator} data-testid="workspace-indicator">
      {/* Panel header — always visible */}
      <div
        className={styles.panelHeader}
        role="button"
        tabIndex={0}
        aria-expanded={isPanelOpen}
        aria-label="Workspaces panel"
        onClick={togglePanel}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            togglePanel();
          }
        }}
      >
        <span
          className={`${styles.expandIcon} ${isPanelOpen ? styles.expandIconExpanded : ''}`}
          aria-hidden="true"
        >
          ▶
        </span>
        <span className={styles.panelTitle}>Workspaces</span>
        <span className={styles.workspaceCount} data-testid="workspace-count">
          {workspaces.length}
        </span>
      </div>

      {/* Workspace list — visible when panel is open */}
      {isPanelOpen && (
        <>
          {workspaces.length === 0 ? (
            <div className={styles.emptyState} data-testid="workspace-empty">
              No workspaces tracked yet
            </div>
          ) : (
            <ul className={styles.workspaceList} data-testid="workspace-list">
              {workspaces.map((entry) => (
                <WorkspaceEntryItem
                  key={`${entry.repository}:${entry.path}`}
                  entry={entry}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
