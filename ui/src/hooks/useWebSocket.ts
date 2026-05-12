import { useEffect, useCallback, useSyncExternalStore } from 'react';
import {
  WebSocketManager,
  type EventHandler,
} from '../api/websocket.js';
import type { ConnectionStatus, TaskEvent } from '../types/index.js';
import type { ChatMessage } from '../types/chat.js';
import type { WorkspaceEntry } from '../types/workspace.js';
import { useTaskStore } from '../stores/taskStore.js';
import { useSessionStore } from '../stores/sessionStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useWorkspaceStore } from '../stores/workspaceStore.js';

// ---------------------------------------------------------------------------
// Singleton manager
// ---------------------------------------------------------------------------

let managerInstance: WebSocketManager | null = null;
/** Incremented each time the manager is created or destroyed, used to trigger re-subscription. */
let managerVersion = 0;
/** Listeners notified when managerVersion changes. */
const managerListeners = new Set<() => void>();

function notifyManagerChange(): void {
  managerVersion += 1;
  for (const listener of managerListeners) {
    listener();
  }
}

/**
 * Initialise (or return) the singleton WebSocketManager.
 *
 * Call this once at the application root after authentication succeeds.
 * Subsequent calls with the same options return the existing instance.
 */
export function getOrCreateManager(options: {
  url?: string;
  getToken: () => string | null;
  onAuthRejected: () => void;
  onReconnected?: () => void;
}): WebSocketManager {
  if (!managerInstance) {
    managerInstance = new WebSocketManager(options);
    notifyManagerChange();
  }
  return managerInstance;
}

/**
 * Tear down the singleton manager.
 *
 * Useful on logout to ensure a fresh connection on the next login.
 */
export function destroyManager(): void {
  if (managerInstance) {
    managerInstance.disconnect();
    managerInstance = null;
    notifyManagerChange();
  }
}

// ---------------------------------------------------------------------------
// Status subscription helpers for useSyncExternalStore
// ---------------------------------------------------------------------------

const DISCONNECTED: ConnectionStatus = 'disconnected';

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

/**
 * Route an incoming WebSocket event to the appropriate Zustand store.
 *
 * Channel naming convention (from the design):
 * - `task:{taskId}`      → task events
 * - `session:state`      → global session lifecycle events
 * - `session:{sessionId}` → per-session messages and workspace updates
 */
function routeEvent(
  channel: string,
  event: { type: string; data: unknown; timestamp: string },
): void {
  // -- Task events --
  if (channel.startsWith('task:')) {
    const taskEvent = event.data as TaskEvent;
    useTaskStore.getState().updateTaskFromEvent(taskEvent);
    return;
  }

  // -- Global session state events --
  if (channel === 'session:state') {
    handleSessionStateEvent(event);
    return;
  }

  // -- Per-session events (messages, workspace) --
  if (channel.startsWith('session:')) {
    const sessionId = channel.slice('session:'.length);
    handleSessionChannelEvent(sessionId, event);
    return;
  }
}

/**
 * Handle global session lifecycle events (session_created, session_terminated, etc.).
 */
function handleSessionStateEvent(
  event: { type: string; data: unknown; timestamp: string },
): void {
  const sessionStore = useSessionStore.getState();
  const data = event.data as Record<string, unknown>;

  switch (event.type) {
    case 'session_created': {
      const session = data as {
        id: string;
        title: string;
        lastMessagePreview: string;
        updatedAt: string;
        hasActiveTasks: boolean;
      };
      sessionStore.addSession({
        id: session.id,
        title: session.title ?? 'New Session',
        lastMessagePreview: session.lastMessagePreview ?? '',
        updatedAt: session.updatedAt ?? event.timestamp,
        hasActiveTasks: session.hasActiveTasks ?? false,
      });
      break;
    }

    case 'session_terminated':
    case 'session_paused':
    case 'session_resumed': {
      const sessionId = data.sessionId as string;
      if (sessionId) {
        const hasActiveTasks =
          event.type === 'session_resumed'
            ? true
            : event.type === 'session_terminated'
              ? false
              : undefined;

        const patch: Record<string, unknown> = {
          updatedAt: event.timestamp,
        };
        if (hasActiveTasks !== undefined) {
          patch.hasActiveTasks = hasActiveTasks;
        }
        sessionStore.updateSession(sessionId, patch);
      }
      break;
    }
  }
}

/**
 * Handle per-session channel events (new messages, workspace updates).
 */
function handleSessionChannelEvent(
  sessionId: string,
  event: { type: string; data: unknown; timestamp: string },
): void {
  switch (event.type) {
    case 'new_message': {
      const message = event.data as ChatMessage;
      useChatStore.getState().addMessage(sessionId, message);
      break;
    }

    case 'workspace_update': {
      const data = event.data as {
        repository: string;
        path: string;
        filesAccessed?: string[];
        filesModified?: string[];
        isNew?: boolean;
      };

      const workspaceStore = useWorkspaceStore.getState();
      const existing = workspaceStore.workspaces.get(sessionId);
      const alreadyTracked = existing?.some(
        (w) => w.repository === data.repository && w.path === data.path,
      );

      if (!alreadyTracked || data.isNew) {
        const entry: WorkspaceEntry = {
          repository: data.repository,
          path: data.path,
          filesAccessed: data.filesAccessed ?? [],
          filesModified: data.filesModified ?? [],
        };
        workspaceStore.addWorkspace(sessionId, entry);
      } else {
        workspaceStore.updateWorkspace(
          sessionId,
          data.repository,
          data.path,
          {
            filesAccessed: data.filesAccessed,
            filesModified: data.filesModified,
          },
        );
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseWebSocketResult {
  /** Current WebSocket connection status. */
  status: ConnectionStatus;
  /** Subscribe to a backend event channel. */
  subscribe: (channel: string) => void;
  /** Unsubscribe from a backend event channel. */
  unsubscribe: (channel: string) => void;
}

/**
 * React hook that wraps the singleton WebSocketManager.
 *
 * - Exposes the current connection `status` reactively.
 * - Wires incoming server events to the appropriate Zustand stores.
 * - Provides `subscribe` / `unsubscribe` helpers for components.
 *
 * The hook expects the manager to already be initialised via
 * `getOrCreateManager()`. If no manager exists yet it returns a
 * disconnected status and no-op subscription functions.
 */
export function useWebSocket(): UseWebSocketResult {
  // -- Reactive status via useSyncExternalStore --
  // We subscribe to both the manager version (creation/destruction) and
  // the manager's own status changes so the hook re-renders in both cases.
  const subscribeToStatus = useCallback(
    (onStoreChange: () => void) => {
      // Listen for manager creation/destruction.
      managerListeners.add(onStoreChange);

      // Listen for status changes on the current manager (if any).
      let unsubManager: (() => void) | null = null;
      if (managerInstance) {
        unsubManager = managerInstance.onStatusChange(onStoreChange);
      }

      return () => {
        managerListeners.delete(onStoreChange);
        unsubManager?.();
      };
    },
    [],
  );

  const getSnapshot = useCallback((): ConnectionStatus => {
    if (!managerInstance) return DISCONNECTED;
    return managerInstance.status;
  }, []);

  const status = useSyncExternalStore(subscribeToStatus, getSnapshot, getSnapshot);

  // -- Wire event routing --
  useEffect(() => {
    if (!managerInstance) return;

    const handler: EventHandler = (channel, event) => {
      routeEvent(channel, event);
    };

    return managerInstance.onEvent(handler);
  }, [status]); // re-run when status changes (which includes when manager is created)

  // -- Stable subscribe / unsubscribe callbacks --
  const subscribe = useCallback((channel: string) => {
    managerInstance?.subscribe(channel);
  }, []);

  const unsubscribe = useCallback((channel: string) => {
    managerInstance?.unsubscribe(channel);
  }, []);

  return { status, subscribe, unsubscribe };
}
