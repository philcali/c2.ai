import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WebSocketManager,
  calculateBackoffDelay,
  type EventHandler,
  type StatusChangeHandler,
} from './websocket.js';
import type { ConnectionStatus } from '../types/index.js';

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

// Patch globals
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  mockWsInstances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  vi.useFakeTimers();
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  vi.useRealTimers();
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

function simulateClose(
  ws: MockWebSocketInstance,
  code = 1000,
  reason = '',
): void {
  ws.readyState = MockWebSocket.CLOSED;
  ws.onclose?.(new CloseEvent('close', { code, reason }));
}

function createManager(overrides: Partial<Parameters<typeof WebSocketManager['prototype']['connect']> extends never[]
  ? ConstructorParameters<typeof WebSocketManager>[0]
  : ConstructorParameters<typeof WebSocketManager>[0]> = {}): WebSocketManager {
  return new WebSocketManager({
    url: 'ws://test:8080/ws',
    getToken: () => 'test-token',
    onAuthRejected: vi.fn(),
    pingInterval: 30_000,
    baseDelay: 1_000,
    maxDelay: 30_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('calculateBackoffDelay', () => {
  it('returns baseDelay for attempt 0', () => {
    expect(calculateBackoffDelay(0, 1000, 30000)).toBe(1000);
  });

  it('doubles delay for each attempt', () => {
    expect(calculateBackoffDelay(1, 1000, 30000)).toBe(2000);
    expect(calculateBackoffDelay(2, 1000, 30000)).toBe(4000);
    expect(calculateBackoffDelay(3, 1000, 30000)).toBe(8000);
  });

  it('caps at maxDelay', () => {
    expect(calculateBackoffDelay(10, 1000, 30000)).toBe(30000);
    expect(calculateBackoffDelay(100, 1000, 30000)).toBe(30000);
  });
});

describe('WebSocketManager', () => {
  describe('connect()', () => {
    it('creates a WebSocket connection to the configured URL', () => {
      const manager = createManager();
      manager.connect();

      expect(mockWsInstances).toHaveLength(1);
      expect(latestWs().url).toBe('ws://test:8080/ws');
    });

    it('sends auth message on connection open', () => {
      const manager = createManager();
      manager.connect();
      simulateOpen(latestWs());

      expect(latestWs().send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(latestWs().send.mock.calls[0][0] as string);
      expect(sent.type).toBe('auth');
      expect(sent.token).toBe('test-token');
    });

    it('does not send auth message when no token is available', () => {
      const manager = createManager({ getToken: () => null });
      manager.connect();
      simulateOpen(latestWs());

      expect(latestWs().send).not.toHaveBeenCalled();
    });

    it('is a no-op when already connected', () => {
      const manager = createManager();
      manager.connect();
      simulateOpen(latestWs());

      manager.connect(); // second call
      expect(mockWsInstances).toHaveLength(1);
    });

    it('transitions status to connecting then connected', () => {
      const manager = createManager();
      const statuses: ConnectionStatus[] = [];
      manager.onStatusChange((s) => statuses.push(s));

      manager.connect();
      simulateOpen(latestWs());

      expect(statuses).toEqual(['connecting', 'connected']);
    });
  });

  describe('disconnect()', () => {
    it('closes the WebSocket and sets status to disconnected', () => {
      const manager = createManager();
      manager.connect();
      simulateOpen(latestWs());

      const ws = latestWs();
      manager.disconnect();

      expect(ws.close).toHaveBeenCalled();
      expect(manager.status).toBe('disconnected');
    });

    it('clears reconnection timers', () => {
      const manager = createManager();
      manager.connect();
      simulateOpen(latestWs());
      simulateClose(latestWs(), 1006); // abnormal close triggers reconnect

      expect(manager.status).toBe('reconnecting');

      manager.disconnect();
      expect(manager.status).toBe('disconnected');

      // Advance past any reconnect timer — should not create new connections.
      vi.advanceTimersByTime(60_000);
      // Only the original + the one from reconnect attempt should exist
      // Actually after disconnect, no new connections should be made.
      const countBefore = mockWsInstances.length;
      vi.advanceTimersByTime(60_000);
      expect(mockWsInstances.length).toBe(countBefore);
    });
  });

  describe('subscribe() / unsubscribe()', () => {
    it('sends subscribe message and tracks the channel', () => {
      const manager = createManager();
      manager.connect();
      simulateOpen(latestWs());

      manager.subscribe('task:123');

      const calls = latestWs().send.mock.calls;
      const subscribeSent = JSON.parse(calls[calls.length - 1][0] as string);
      expect(subscribeSent.type).toBe('subscribe');
      expect(subscribeSent.payload.channel).toBe('task:123');
      expect(manager.activeSubscriptions.has('task:123')).toBe(true);
    });

    it('sends unsubscribe message and removes the channel', () => {
      const manager = createManager();
      manager.connect();
      simulateOpen(latestWs());

      manager.subscribe('task:123');
      manager.unsubscribe('task:123');

      const calls = latestWs().send.mock.calls;
      const unsubSent = JSON.parse(calls[calls.length - 1][0] as string);
      expect(unsubSent.type).toBe('unsubscribe');
      expect(unsubSent.payload.channel).toBe('task:123');
      expect(manager.activeSubscriptions.has('task:123')).toBe(false);
    });
  });

  describe('ping/pong keepalive', () => {
    it('sends ping messages at the configured interval', () => {
      const manager = createManager({ pingInterval: 5_000 });
      manager.connect();
      simulateOpen(latestWs());

      // Clear the auth message call count.
      const initialCalls = latestWs().send.mock.calls.length;

      vi.advanceTimersByTime(5_000);
      const afterFirst = latestWs().send.mock.calls.length;
      expect(afterFirst).toBe(initialCalls + 1);

      const pingMsg = JSON.parse(
        latestWs().send.mock.calls[afterFirst - 1][0] as string,
      );
      expect(pingMsg.type).toBe('ping');

      vi.advanceTimersByTime(5_000);
      expect(latestWs().send.mock.calls.length).toBe(initialCalls + 2);
    });

    it('stops pinging after disconnect', () => {
      const manager = createManager({ pingInterval: 5_000 });
      manager.connect();
      simulateOpen(latestWs());

      manager.disconnect();

      const callCount = latestWs().send.mock.calls.length;
      vi.advanceTimersByTime(15_000);
      expect(latestWs().send.mock.calls.length).toBe(callCount);
    });
  });

  describe('event dispatching', () => {
    it('dispatches parsed event messages to registered handlers', () => {
      const manager = createManager();
      const handler = vi.fn<EventHandler>();
      manager.onEvent(handler);

      manager.connect();
      simulateOpen(latestWs());

      const serverEvent = {
        type: 'event',
        payload: {
          channel: 'task:abc',
          event: { type: 'task_status_change', data: { status: 'completed' }, timestamp: '2026-01-01T00:00:00Z' },
        },
      };
      simulateMessage(latestWs(), serverEvent);

      expect(handler).toHaveBeenCalledWith('task:abc', serverEvent.payload.event);
    });

    it('ignores malformed messages without crashing', () => {
      const manager = createManager();
      const handler = vi.fn<EventHandler>();
      manager.onEvent(handler);

      manager.connect();
      simulateOpen(latestWs());

      // Send raw non-JSON string.
      latestWs().onmessage?.(new MessageEvent('message', { data: 'not json' }));

      expect(handler).not.toHaveBeenCalled();
    });

    it('allows unsubscribing event handlers', () => {
      const manager = createManager();
      const handler = vi.fn<EventHandler>();
      const unsub = manager.onEvent(handler);

      manager.connect();
      simulateOpen(latestWs());

      unsub();

      simulateMessage(latestWs(), {
        type: 'event',
        payload: {
          channel: 'task:abc',
          event: { type: 'test', data: {}, timestamp: '' },
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('reconnection', () => {
    it('attempts reconnection with exponential backoff on abnormal close', () => {
      const manager = createManager({ baseDelay: 100, maxDelay: 1000 });
      manager.connect();
      simulateOpen(latestWs());
      simulateClose(latestWs(), 1006);

      expect(manager.status).toBe('reconnecting');

      // First reconnect after 100ms (attempt 0).
      vi.advanceTimersByTime(100);
      expect(mockWsInstances).toHaveLength(2);

      // Simulate that second connection also fails.
      simulateClose(latestWs(), 1006);

      // Second reconnect after 200ms (attempt 1).
      vi.advanceTimersByTime(200);
      expect(mockWsInstances).toHaveLength(3);
    });

    it('re-subscribes all channels after reconnection', () => {
      const manager = createManager({ baseDelay: 100, maxDelay: 1000 });
      manager.connect();
      simulateOpen(latestWs());

      manager.subscribe('task:1');
      manager.subscribe('session:abc');

      // Simulate disconnect.
      simulateClose(latestWs(), 1006);

      // Reconnect.
      vi.advanceTimersByTime(100);
      const newWs = latestWs();
      simulateOpen(newWs);

      // Should have: auth + 2 re-subscribe messages.
      const sentMessages = newWs.send.mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string),
      );
      const subscribeMessages = sentMessages.filter(
        (m: { type: string }) => m.type === 'subscribe',
      );
      const channels = subscribeMessages.map(
        (m: { payload: { channel: string } }) => m.payload.channel,
      );

      expect(channels).toContain('task:1');
      expect(channels).toContain('session:abc');
    });

    it('calls onReconnected callback after successful reconnection', () => {
      const onReconnected = vi.fn();
      const manager = createManager({ baseDelay: 100, onReconnected });
      manager.connect();
      simulateOpen(latestWs());

      simulateClose(latestWs(), 1006);
      vi.advanceTimersByTime(100);
      simulateOpen(latestWs());

      expect(onReconnected).toHaveBeenCalledTimes(1);
    });

    it('does not call onReconnected on initial connection', () => {
      const onReconnected = vi.fn();
      const manager = createManager({ onReconnected });
      manager.connect();
      simulateOpen(latestWs());

      expect(onReconnected).not.toHaveBeenCalled();
    });

    it('stops reconnection and calls onAuthRejected on code 4001', () => {
      const onAuthRejected = vi.fn();
      const manager = createManager({ onAuthRejected, baseDelay: 100 });
      manager.connect();
      simulateOpen(latestWs());

      simulateClose(latestWs(), 4001);

      expect(manager.status).toBe('disconnected');
      expect(onAuthRejected).toHaveBeenCalledTimes(1);

      // Should not attempt reconnection.
      vi.advanceTimersByTime(60_000);
      expect(mockWsInstances).toHaveLength(1);
    });
  });

  describe('send()', () => {
    it('sends arbitrary client messages', () => {
      const manager = createManager();
      manager.connect();
      simulateOpen(latestWs());

      manager.send({
        type: 'command',
        id: 'cmd-1',
        payload: { action: 'test', params: { foo: 'bar' } },
      });

      const calls = latestWs().send.mock.calls;
      const sent = JSON.parse(calls[calls.length - 1][0] as string);
      expect(sent.type).toBe('command');
      expect(sent.payload.action).toBe('test');
    });

    it('does not throw when socket is not open', () => {
      const manager = createManager();
      // Not connected — send should silently no-op.
      expect(() => {
        manager.send({
          type: 'command',
          id: 'cmd-1',
          payload: { action: 'test', params: {} },
        });
      }).not.toThrow();
    });
  });

  describe('status change handlers', () => {
    it('notifies all registered status handlers', () => {
      const manager = createManager();
      const handler1 = vi.fn<StatusChangeHandler>();
      const handler2 = vi.fn<StatusChangeHandler>();

      manager.onStatusChange(handler1);
      manager.onStatusChange(handler2);

      manager.connect();

      expect(handler1).toHaveBeenCalledWith('connecting');
      expect(handler2).toHaveBeenCalledWith('connecting');
    });

    it('allows unsubscribing status handlers', () => {
      const manager = createManager();
      const handler = vi.fn<StatusChangeHandler>();
      const unsub = manager.onStatusChange(handler);

      unsub();
      manager.connect();

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
