import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSessionStore } from '../stores/sessionStore.js';
import { getOrCreateAuthDeps } from './useAuth.js';
import { sessionKeys } from './useSessions.js';
import type { SessionSummary } from '../types/index.js';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseSessionResult {
  /** The currently active session, or null if none is selected. */
  activeSession: SessionSummary | null;
  /** Create a new session and make it active. */
  createSession: () => void;
  /** Whether a session creation request is in flight. */
  isCreating: boolean;
  /** Error from the last createSession attempt, if any. */
  createError: string | null;
}

/**
 * React hook for single-session data and mutations.
 *
 * Provides the active session object and a `createSession` mutation
 * that creates a new session on the backend, adds it to the store,
 * and sets it as active.
 *
 * Requirements: 2.2, 2.3
 */
export function useSession(): UseSessionResult {
  const { apiClient } = getOrCreateAuthDeps();
  const queryClient = useQueryClient();

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const addSession = useSessionStore((s) => s.addSession);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);

  const activeSession =
    sessions.find((s) => s.id === activeSessionId) ?? null;

  const createMutation = useMutation<SessionSummary, Error>({
    mutationFn: () => apiClient.createSession(),
    onSuccess: (newSession) => {
      addSession(newSession);
      setActiveSession(newSession.id);
      // Invalidate the session list so the next fetch picks up the new entry.
      queryClient.invalidateQueries({ queryKey: sessionKeys.list() });
    },
  });

  return {
    activeSession,
    createSession: () => createMutation.mutate(),
    isCreating: createMutation.isPending,
    createError: createMutation.error?.message ?? null,
  };
}
