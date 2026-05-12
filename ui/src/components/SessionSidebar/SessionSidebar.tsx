import { useCallback, type ChangeEvent } from 'react';
import { useSessions } from '../../hooks/useSessions.js';
import { useSession } from '../../hooks/useSession.js';
import { SessionEntry } from './SessionEntry.js';
import styles from './SessionSidebar.module.css';

/**
 * Session sidebar — lists all sessions with search and new-session controls.
 *
 * Renders the filtered + sorted session list from the session store,
 * a search input that updates the store's search query, and a
 * "New Session" button that creates a session via the API.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.6
 */
export function SessionSidebar() {
  const {
    sessions,
    isLoading,
    activeSessionId,
    setActiveSession,
    setSearchQuery,
    searchQuery,
  } = useSessions();

  const { createSession, isCreating } = useSession();

  // -----------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------

  const handleSearchChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    [setSearchQuery],
  );

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      if (sessionId !== activeSessionId) {
        setActiveSession(sessionId);
      }
    },
    [activeSessionId, setActiveSession],
  );

  const handleNewSession = useCallback(() => {
    if (!isCreating) {
      createSession();
    }
  }, [createSession, isCreating]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <nav className={styles.sidebar} aria-label="Sessions" data-testid="session-sidebar">
      {/* Controls */}
      <div className={styles.controls}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search sessions\u2026"
          value={searchQuery}
          onChange={handleSearchChange}
          aria-label="Search sessions"
          data-testid="session-search-input"
        />
        <button
          type="button"
          className={styles.newSessionButton}
          onClick={handleNewSession}
          disabled={isCreating}
          aria-busy={isCreating}
          data-testid="new-session-button"
        >
          {isCreating ? 'Creating\u2026' : '+ New Session'}
        </button>
      </div>

      {/* Session list */}
      {isLoading ? (
        <div className={styles.loadingState} role="status" data-testid="sessions-loading">
          Loading sessions\u2026
        </div>
      ) : sessions.length === 0 ? (
        <div className={styles.emptyState} data-testid="sessions-empty">
          {searchQuery ? 'No sessions match your search.' : 'No sessions yet. Create one to get started.'}
        </div>
      ) : (
        <ul className={styles.sessionList} data-testid="session-list" role="list">
          {sessions.map((session) => (
            <li key={session.id}>
              <SessionEntry
                session={session}
                isActive={session.id === activeSessionId}
                onClick={handleSessionClick}
              />
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
