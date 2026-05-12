import { create } from 'zustand';
import type { SessionSummary } from '../types/index.js';

/**
 * Actions exposed by the session store.
 */
export interface SessionActions {
  /** Replace the full session list (e.g. after initial fetch). */
  setSessions: (sessions: SessionSummary[]) => void;
  /** Set the currently active session by ID. */
  setActiveSession: (sessionId: string | null) => void;
  /** Append a newly created session to the list. */
  addSession: (session: SessionSummary) => void;
  /** Update an existing session entry (partial merge by ID). */
  updateSession: (sessionId: string, patch: Partial<SessionSummary>) => void;
  /** Update the search query used for filtering. */
  setSearchQuery: (query: string) => void;
  /** Set the loading flag. */
  setLoading: (isLoading: boolean) => void;
}

export interface SessionStoreState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  searchQuery: string;
  isLoading: boolean;
}

export type SessionStore = SessionStoreState & SessionActions;

/**
 * Derive the filtered session list.
 *
 * Sessions are filtered by case-insensitive substring match on `title`
 * and `lastMessagePreview`, then sorted by `updatedAt` descending.
 */
export function filteredSessions(state: SessionStoreState): SessionSummary[] {
  const query = state.searchQuery.toLowerCase();

  const filtered =
    query.length === 0
      ? state.sessions
      : state.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(query) ||
            s.lastMessagePreview.toLowerCase().includes(query),
        );

  // Sort descending by updatedAt (most recent first).
  return [...filtered].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export const useSessionStore = create<SessionStore>((set) => ({
  // -- State --
  sessions: [],
  activeSessionId: null,
  searchQuery: '',
  isLoading: false,

  // -- Actions --

  setSessions: (sessions) => set({ sessions }),

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  addSession: (session) =>
    set((state) => ({ sessions: [session, ...state.sessions] })),

  updateSession: (sessionId, patch) =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, ...patch } : s,
      ),
    })),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setLoading: (isLoading) => set({ isLoading }),
}));
