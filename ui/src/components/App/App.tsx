import { useState, useCallback, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import { useTheme } from '../../hooks/useTheme.js';
import { useAuth } from '../../hooks/useAuth.js';
import { useWebSocket, getOrCreateManager, destroyManager } from '../../hooks/useWebSocket.js';
import { getOrCreateAuthDeps } from '../../hooks/useAuth.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useChatStore } from '../../stores/chatStore.js';
import { AuthGuard } from '../AuthGuard/AuthGuard.js';
import { SessionSidebar } from '../SessionSidebar/SessionSidebar.js';
import { ChatInterface } from '../Chat/ChatInterface.js';
import { ConnectionBanner } from '../ConnectionBanner/ConnectionBanner.js';
import { WorkspaceIndicator } from '../Workspace/WorkspaceIndicator.js';
import '../../styles/theme.css';
import styles from './App.module.css';

// ---------------------------------------------------------------------------
// Query client — created once outside the component to avoid re-creation
// ---------------------------------------------------------------------------

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// ---------------------------------------------------------------------------
// Stable empty array to avoid re-render loops in selectors.
// ---------------------------------------------------------------------------

const EMPTY_TASK_IDS: string[] = [];

// ---------------------------------------------------------------------------
// WebSocket initializer — connects after authentication and manages
// channel subscriptions for the active session and its tasks.
// ---------------------------------------------------------------------------

function useWebSocketLifecycle() {
  const { token, isAuthenticated } = useAuth();
  const { subscribe, unsubscribe } = useWebSocket();
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const { apiClient } = getOrCreateAuthDeps();

  // Track the previous session ID so we can unsubscribe on change.
  const prevSessionIdRef = useRef<string | null>(null);
  // Track task channel subscriptions so we can clean up.
  const taskSubsRef = useRef<Set<string>>(new Set());

  // -- Initialize / tear down the WebSocket manager on auth changes --
  useEffect(() => {
    if (!isAuthenticated || !token) {
      destroyManager();
      return;
    }

    const manager = getOrCreateManager({
      getToken: () => token,
      onAuthRejected: () => {
        const { useAuthStore } = getOrCreateAuthDeps();
        useAuthStore.getState().logout();
      },
      onReconnected: () => {
        // Reconcile state via REST after reconnection.
        const currentSessionId = useSessionStore.getState().activeSessionId;
        if (currentSessionId) {
          apiClient.getSessionMessages(currentSessionId).then((page) => {
            useChatStore.getState().setMessages(currentSessionId, page.messages);
          }).catch(() => { /* silent */ });
        }
      },
    });

    if (manager) {
      manager.connect();
    }

    // Subscribe to the global session state channel.
    subscribe('session:state');

    return () => {
      unsubscribe('session:state');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, token]);

  // -- Subscribe to per-session channel when active session changes --
  useEffect(() => {
    const prev = prevSessionIdRef.current;

    // Unsubscribe from previous session channel.
    if (prev && prev !== activeSessionId) {
      unsubscribe(`session:${prev}`);
    }

    // Subscribe to new session channel.
    if (activeSessionId) {
      subscribe(`session:${activeSessionId}`);
    }

    prevSessionIdRef.current = activeSessionId;
  }, [activeSessionId, subscribe, unsubscribe]);

  // -- Subscribe to task channels for tasks in the active session's messages --
  // Read messages reactively from the chat store so we subscribe to new
  // task channels as task_created messages arrive.
  // We extract just the task IDs to avoid re-rendering on every message change.
  // useShallow ensures we only re-render when the array contents change.
  const taskIdsInSession = useChatStore(useShallow((s) => {
    if (!activeSessionId) return EMPTY_TASK_IDS;
    const msgs = s.messages.get(activeSessionId);
    if (!msgs) return EMPTY_TASK_IDS;
    const ids: string[] = [];
    for (const msg of msgs) {
      if (msg.type === 'task_created') {
        ids.push(msg.taskId);
      }
    }
    return ids;
  }));

  useEffect(() => {
    if (!activeSessionId) return;

    const currentTaskIds = new Set(taskIdsInSession);

    // Subscribe to new task channels.
    for (const taskId of currentTaskIds) {
      const channel = `task:${taskId}`;
      if (!taskSubsRef.current.has(channel)) {
        subscribe(channel);
        taskSubsRef.current.add(channel);
      }
    }

    // Unsubscribe from task channels no longer relevant.
    for (const channel of taskSubsRef.current) {
      const taskId = channel.slice('task:'.length);
      if (!currentTaskIds.has(taskId)) {
        unsubscribe(channel);
        taskSubsRef.current.delete(channel);
      }
    }
  }, [activeSessionId, taskIdsInSession, subscribe, unsubscribe]);
}

// ---------------------------------------------------------------------------
// Inner layout (needs hooks that depend on providers above)
// ---------------------------------------------------------------------------

function AppLayout() {
  const { mode, toggleTheme } = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // Initialize WebSocket and manage channel subscriptions.
  useWebSocketLifecycle();

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  return (
    <div className={styles.appShell} data-testid="app-shell">
      {/* Connection status banner */}
      <ConnectionBanner />

      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            type="button"
            className={styles.sidebarToggle}
            onClick={handleToggleSidebar}
            aria-label="Toggle sidebar"
            aria-expanded={sidebarOpen}
          >
            ☰
          </button>
          <h1 className={styles.headerTitle}>Command Center</h1>
        </div>

        <button
          type="button"
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-label={`Switch to ${mode === 'light' ? 'dark' : 'light'} mode`}
        >
          {mode === 'light' ? '🌙' : '☀️'}
        </button>
      </header>

      {/* Three-column layout */}
      <div className={styles.layout}>
        {/* Sidebar overlay backdrop (mobile) */}
        <div
          className={`${styles.overlay} ${!sidebarOpen ? styles.overlayHidden : ''}`}
          onClick={handleCloseSidebar}
          data-testid="sidebar-overlay"
          aria-hidden="true"
        />

        {/* Sidebar (left) */}
        <aside
          className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}
          data-testid="sidebar"
          aria-label="Session sidebar"
        >
          <SessionSidebar />
          {/* Workspace indicator shown inside sidebar on mobile */}
          <div className={styles.sidebarWorkspace}>
            <WorkspaceIndicator sessionId={activeSessionId} />
          </div>
        </aside>

        {/* Chat (center) */}
        <main className={styles.main} data-testid="chat-area">
          <ChatInterface />
        </main>

        {/* Workspace indicator (right) */}
        <aside
          className={styles.workspacePanel}
          data-testid="workspace-panel"
          aria-label="Workspace indicator"
        >
          <WorkspaceIndicator sessionId={activeSessionId} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App component
// ---------------------------------------------------------------------------

/**
 * Application root.
 *
 * Wraps the entire UI in:
 * 1. TanStack QueryClientProvider (server-state cache)
 * 2. AuthGuard (redirects to login when unauthenticated)
 * 3. AppLayout (responsive three-column shell)
 *
 * Requirements: 10.1, 10.2, 10.3, 11.1
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGuard>
        <AppLayout />
      </AuthGuard>
    </QueryClientProvider>
  );
}
