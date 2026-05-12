import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useShallow } from 'zustand/shallow';
import { useSessionStore, filteredSessions } from '../stores/sessionStore.js';
import { getOrCreateAuthDeps } from './useAuth.js';
import type { SessionSummary } from '../types/index.js';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const sessionKeys = {
  all: ['sessions'] as const,
  list: () => [...sessionKeys.all, 'list'] as const,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSessionsResult {
  /** Filtered and sorted session list (respects the current search query). */
  sessions: SessionSummary[];
  /** Whether the initial session fetch is in progress. */
  isLoading: boolean;
  /** The currently active session ID. */
  activeSessionId: string | null;
  /** Set the active session. */
  setActiveSession: (sessionId: string | null) => void;
  /** Update the search query used for filtering. */
  setSearchQuery: (query: string) => void;
  /** Current search query. */
  searchQuery: string;
  /** Refetch the session list from the server. */
  refetch: () => void;
}

/**
 * React hook that fetches and caches the session list using TanStack Query,
 * and syncs results into the Zustand session store.
 *
 * The returned `sessions` list is the filtered + sorted view derived from
 * the store (respecting the current search query).
 *
 * Requirements: 2.1, 2.2, 2.3
 */
export function useSessions(): UseSessionsResult {
  const { apiClient } = getOrCreateAuthDeps();

  const setSessions = useSessionStore((s) => s.setSessions);
  const setLoading = useSessionStore((s) => s.setLoading);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setSearchQuery = useSessionStore((s) => s.setSearchQuery);
  const searchQuery = useSessionStore((s) => s.searchQuery);

  const query = useQuery<SessionSummary[]>({
    queryKey: sessionKeys.list(),
    queryFn: () => apiClient.listSessions(),
  });

  // Sync query results into the Zustand store.
  useEffect(() => {
    if (query.data) {
      setSessions(query.data);
    }
  }, [query.data, setSessions]);

  useEffect(() => {
    setLoading(query.isLoading);
  }, [query.isLoading, setLoading]);

  // Derive filtered sessions from the store.
  // useShallow prevents infinite re-renders by doing a shallow comparison
  // of the returned array elements instead of reference equality.
  const sessions = useSessionStore(useShallow((state) => filteredSessions(state)));

  return {
    sessions,
    isLoading: query.isLoading,
    activeSessionId,
    setActiveSession,
    setSearchQuery,
    searchQuery,
    refetch: () => { query.refetch(); },
  };
}
