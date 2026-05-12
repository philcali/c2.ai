/** Summary of a session displayed in the sidebar. */
export interface SessionSummary {
  id: string;
  title: string;
  lastMessagePreview: string;
  updatedAt: string;
  hasActiveTasks: boolean;
}

/** Client-side session list state managed by the session store. */
export interface SessionState {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  searchQuery: string;
  isLoading: boolean;
}
