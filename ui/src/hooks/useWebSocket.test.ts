import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useWebSocket,
  getOrCreateManager,
  destroyManager,
} from './useWebSocket.js';
import { WebSocketManager } from '../api/websocket.js';
import { useTaskStore } from '../stores/taskStore.js';
import { useSessionStore } from '../stores/sessionStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useWorkspaceStore } from '../stores/workspaceStore.js';
import type { CodingTask } from '../types/index.js';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface MockWebSocketInstance {
  url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let mockWsInstances: MockWebSocketInstance[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    mockWsInstances.push(this as unknown as MockWebSocketInstance);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  mockWsInstances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

  // Reset all stores to initial state.
  useTaskStore.setState({ tasks: new Map(), expandedTasks: new Set() });
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    searchQuery: '',
    isLoading: false,
  });
  useChatStore.setState({
    messages: new Map(),
    isLoading: false,
    isSending: false,
    hasMore: new Map(),
  });
  useWorkspaceStore.setState({ workspaces: new Map() });
});

afterEach(() => {
  destroyManager();
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function latestWs(): MockWebSocketInstance {
  return mockWsInstances[mockWsInstances.length - 1]!;
}

function simulateOpen(ws: MockWebSocketInstance): void {
  ws.readyState = MockWebSocket.OPEN;
  ws.onopen?.(new Event('open'));
}

function simulateMessage(ws: MockWebSocketInstance, data: unknown): void {
  ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
}

function initManager(): WebSocketManager {
  const manager = getOrCreateManager({
    url: 'ws://test:8080/ws',
    getToken: () => 'test-token',
    onAuthRejected: vi.fn(),
  });
  manager.connect();
  simulateOpen(latestWs());
  return manager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getOrCreateManager / destroyManager', () => {
  it('returns the same instance on repeated calls', () => {
    const m1 = getOrCreateManager({
      getToken: () => null,
      onAuthRejected: vi.fn(),
    });
    const m2 = getOrCreateManager({
      getToken: () => null,
      onAuthRejected: vi.fn(),
    });
    expect(m1).toBe(m2);
  });

  it('creates a new instance after destroyManager()', () => {
    const m1 = getOrCreateManager({
      getToken: () => null,
      onAuthRejected: vi.fn(),
    });
    destroyManager();
    const m2 = getOrCreateManager({
      getToken: () => null,
      onAuthRejected: vi.fn(),
    });
    expect(m1).not.toBe(m2);
  });
});

describe('useWebSocket', () => {
  it('returns disconnected status when no manager exists', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.status).toBe('disconnected');
  });

  it('returns connected status when manager is connected', () => {
    initManager();
    const { result } = renderHook(() => useWebSocket());
    expect(result.current.status).toBe('connected');
  });

  it('provides subscribe and unsubscribe functions', () => {
    initManager();
    const { result } = renderHook(() => useWebSocket());

    act(() => {
      result.current.subscribe('task:123');
    });

    const calls = latestWs().send.mock.calls;
    const lastSent = JSON.parse(calls[calls.length - 1][0] as string);
    expect(lastSent.type).toBe('subscribe');
    expect(lastSent.payload.channel).toBe('task:123');

    act(() => {
      result.current.unsubscribe('task:123');
    });

    const calls2 = latestWs().send.mock.calls;
    const lastSent2 = JSON.parse(calls2[calls2.length - 1][0] as string);
    expect(lastSent2.type).toBe('unsubscribe');
    expect(lastSent2.payload.channel).toBe('task:123');
  });
});

describe('event routing', () => {
  it('routes task events to the task store', () => {
    initManager();

    // Seed a task in the store.
    const task: CodingTask = {
      id: 'task-1',
      operatorId: 'op-1',
      status: 'in_progress',
      steps: [
        {
          id: 'step-1',
          taskId: 'task-1',
          sequenceIndex: 0,
          instructions: 'Do something',
          status: 'executing',
          artifacts: [],
          feedbackHistory: [],
          retryCount: 0,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      currentStepIndex: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    useTaskStore.getState().setTask(task);

    // Render hook to wire event routing.
    renderHook(() => useWebSocket());

    // Simulate a task event via WebSocket.
    act(() => {
      simulateMessage(latestWs(), {
        type: 'event',
        payload: {
          channel: 'task:task-1',
          event: {
            type: 'task_status_change',
            data: {
              type: 'task_status_change',
              taskId: 'task-1',
              status: 'completed',
              timestamp: '2026-01-01T01:00:00Z',
            },
            timestamp: '2026-01-01T01:00:00Z',
          },
        },
      });
    });

    const updatedTask = useTaskStore.getState().tasks.get('task-1');
    expect(updatedTask?.status).toBe('completed');
  });

  it('routes session_created events to the session store', () => {
    initManager();
    renderHook(() => useWebSocket());

    act(() => {
      simulateMessage(latestWs(), {
        type: 'event',
        payload: {
          channel: 'session:state',
          event: {
            type: 'session_created',
            data: {
              id: 'sess-new',
              title: 'New Session',
              lastMessagePreview: '',
              updatedAt: '2026-01-01T00:00:00Z',
              hasActiveTasks: false,
            },
            timestamp: '2026-01-01T00:00:00Z',
          },
        },
      });
    });

    const sessions = useSessionStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-new');
    expect(sessions[0].title).toBe('New Session');
  });

  it('routes session_terminated events to the session store', () => {
    initManager();
    useSessionStore.getState().setSessions([
      {
        id: 'sess-1',
        title: 'Session 1',
        lastMessagePreview: 'hello',
        updatedAt: '2026-01-01T00:00:00Z',
        hasActiveTasks: true,
      },
    ]);

    renderHook(() => useWebSocket());

    act(() => {
      simulateMessage(latestWs(), {
        type: 'event',
        payload: {
          channel: 'session:state',
          event: {
            type: 'session_terminated',
            data: { sessionId: 'sess-1' },
            timestamp: '2026-01-01T01:00:00Z',
          },
        },
      });
    });

    const session = useSessionStore.getState().sessions.find((s) => s.id === 'sess-1');
    expect(session?.hasActiveTasks).toBe(false);
  });

  it('routes new_message events to the chat store', () => {
    initManager();
    renderHook(() => useWebSocket());

    act(() => {
      simulateMessage(latestWs(), {
        type: 'event',
        payload: {
          channel: 'session:sess-1',
          event: {
            type: 'new_message',
            data: {
              type: 'system',
              id: 'msg-1',
              content: 'Hello from system',
              timestamp: '2026-01-01T00:00:00Z',
              format: 'plain',
            },
            timestamp: '2026-01-01T00:00:00Z',
          },
        },
      });
    });

    const messages = useChatStore.getState().messages.get('sess-1');
    expect(messages).toHaveLength(1);
    expect(messages![0].type).toBe('system');
  });

  it('routes workspace_update events to the workspace store (new workspace)', () => {
    initManager();
    renderHook(() => useWebSocket());

    act(() => {
      simulateMessage(latestWs(), {
        type: 'event',
        payload: {
          channel: 'session:sess-1',
          event: {
            type: 'workspace_update',
            data: {
              repository: 'my-repo',
              path: '/home/user/my-repo',
              filesAccessed: ['src/index.ts'],
              filesModified: [],
              isNew: true,
            },
            timestamp: '2026-01-01T00:00:00Z',
          },
        },
      });
    });

    const workspaces = useWorkspaceStore.getState().workspaces.get('sess-1');
    expect(workspaces).toHaveLength(1);
    expect(workspaces![0].repository).toBe('my-repo');
    expect(workspaces![0].filesAccessed).toEqual(['src/index.ts']);
  });

  it('routes workspace_update events to the workspace store (update existing)', () => {
    initManager();

    // Seed an existing workspace.
    useWorkspaceStore.getState().addWorkspace('sess-1', {
      repository: 'my-repo',
      path: '/home/user/my-repo',
      filesAccessed: ['src/index.ts'],
      filesModified: [],
    });

    renderHook(() => useWebSocket());

    act(() => {
      simulateMessage(latestWs(), {
        type: 'event',
        payload: {
          channel: 'session:sess-1',
          event: {
            type: 'workspace_update',
            data: {
              repository: 'my-repo',
              path: '/home/user/my-repo',
              filesModified: ['src/app.ts'],
            },
            timestamp: '2026-01-01T00:00:00Z',
          },
        },
      });
    });

    const workspaces = useWorkspaceStore.getState().workspaces.get('sess-1');
    expect(workspaces).toHaveLength(1);
    expect(workspaces![0].filesModified).toContain('src/app.ts');
  });
});
