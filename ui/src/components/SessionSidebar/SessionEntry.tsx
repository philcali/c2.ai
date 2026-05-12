import type { SessionSummary } from '../../types/index.js';
import styles from './SessionEntry.module.css';

/**
 * Format an ISO-8601 timestamp into a human-friendly relative or
 * absolute string depending on how recent it is.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso; // fallback: return raw string if unparseable
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionEntryProps {
  session: SessionSummary;
  isActive: boolean;
  onClick: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A single session row in the sidebar.
 *
 * Renders the session title, last message preview, formatted timestamp,
 * and a pulsing status indicator when the session has active tasks.
 *
 * Requirements: 2.4, 2.5
 */
export function SessionEntry({ session, isActive, onClick }: SessionEntryProps) {
  const className = [styles.entry, isActive ? styles.active : '']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      onClick={() => onClick(session.id)}
      aria-current={isActive ? 'true' : undefined}
      data-testid={`session-entry-${session.id}`}
    >
      <div className={styles.header}>
        <span className={styles.title} data-testid="session-title">
          {session.title}
        </span>
        {session.hasActiveTasks && (
          <span
            className={styles.statusIndicator}
            role="status"
            aria-label="Active tasks in progress"
            data-testid="active-tasks-indicator"
          />
        )}
      </div>

      <p className={styles.preview} data-testid="session-preview">
        {session.lastMessagePreview}
      </p>

      <time
        className={styles.timestamp}
        dateTime={session.updatedAt}
        data-testid="session-timestamp"
      >
        {formatTimestamp(session.updatedAt)}
      </time>
    </button>
  );
}
