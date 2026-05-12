import type {
  ClientMessage,
  ServerMessage,
  ConnectionStatus,
} from '../types/index.js';

/**
 * Callback signature for handling parsed server events.
 *
 * The handler receives the channel name and the event payload
 * exactly as delivered by the backend.
 */
export type EventHandler = (
  channel: string,
  event: { type: string; data: unknown; timestamp: string },
) => void;

/**
 * Callback invoked whenever the connection status changes.
 */
export type StatusChangeHandler = (status: ConnectionStatus) => void;

/**
 * Configuration accepted by the WebSocketManager constructor.
 */
export interface WebSocketManagerOptions {
  /** WebSocket server URL. Defaults to `ws://localhost:8080/ws`. */
  url?: string;
  /** Returns the current auth token (or null when unauthenticated). */
  getToken: () => string | null;
  /** Called when the server rejects authentication (close code 4001). */
  onAuthRejected: () => void;
  /** Ping/pong keepalive interval in milliseconds. Defaults to 30 000. */
  pingInterval?: number;
  /** Base delay for exponential backoff reconnection in ms. Defaults to 1 000. */
  baseDelay?: number;
  /** Maximum reconnection delay in ms. Defaults to 30 000. */
  maxDelay?: number;
  /** Called after a successful reconnection so the consumer can reconcile state via REST. */
  onReconnected?: () => void;
}

/** Auth-rejection close code sent by the backend. */
const AUTH_REJECTED_CODE = 4001;

/** Generate a short random ID for message correlation. */
function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Calculate the exponential backoff delay for a given attempt.
 *
 * Formula: `min(baseDelay × 2^attempt, maxDelay)`
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
}

/**
 * Manages a WebSocket connection to the Command Center backend.
 *
 * Responsibilities:
 * - Authentication handshake on connection open
 * - Channel subscription tracking with automatic re-subscription on reconnect
 * - Ping/pong keepalive
 * - Exponential backoff reconnection
 * - Dispatching parsed server events to registered handlers
 */
export class WebSocketManager {
  // -- Configuration --
  private readonly url: string;
  private readonly getToken: () => string | null;
  private readonly onAuthRejected: () => void;
  private readonly pingIntervalMs: number;
  private readonly baseDelay: number;
  private readonly maxDelay: number;
  private readonly onReconnected?: () => void;

  // -- Connection state --
  private ws: WebSocket | null = null;
  private _status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // -- Subscriptions --
  private readonly subscriptions = new Set<string>();

  // -- Handlers --
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly statusHandlers = new Set<StatusChangeHandler>();

  constructor(options: WebSocketManagerOptions) {
    this.url = options.url ?? 'ws://localhost:8080/ws';
    this.getToken = options.getToken;
    this.onAuthRejected = options.onAuthRejected;
    this.pingIntervalMs = options.pingInterval ?? 30_000;
    this.baseDelay = options.baseDelay ?? 1_000;
    this.maxDelay = options.maxDelay ?? 30_000;
    this.onReconnected = options.onReconnected;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Current connection status. */
  get status(): ConnectionStatus {
    return this._status;
  }

  /** The set of channels currently subscribed to. */
  get activeSubscriptions(): ReadonlySet<string> {
    return this.subscriptions;
  }

  /**
   * Open a WebSocket connection and perform the auth handshake.
   *
   * If a connection is already open this is a no-op.
   */
  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setStatus('connecting');
    this.ws = new WebSocket(this.url);

    this.ws.onopen = this.handleOpen;
    this.ws.onmessage = this.handleMessage;
    this.ws.onclose = this.handleClose;
    this.ws.onerror = this.handleError;
  }

  /**
   * Gracefully close the connection.
   *
   * Clears reconnection timers so no automatic reconnect occurs.
   */
  disconnect(): void {
    this.clearReconnectTimer();
    this.clearPingTimer();

    if (this.ws) {
      // Remove handlers before closing to avoid triggering reconnect logic.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }

    this.setStatus('disconnected');
  }

  /**
   * Subscribe to a backend event channel.
   *
   * The subscription is tracked so it will be automatically
   * re-established after a reconnection.
   */
  subscribe(channel: string): void {
    this.subscriptions.add(channel);
    this.sendClientMessage({
      type: 'subscribe',
      id: generateId(),
      payload: { channel },
    });
  }

  /**
   * Unsubscribe from a backend event channel.
   */
  unsubscribe(channel: string): void {
    this.subscriptions.delete(channel);
    this.sendClientMessage({
      type: 'unsubscribe',
      id: generateId(),
      payload: { channel },
    });
  }

  /**
   * Send an arbitrary client message over the WebSocket.
   */
  send(message: ClientMessage): void {
    this.sendClientMessage(message);
  }

  /**
   * Register a handler that will be called for every incoming server event.
   * Returns an unsubscribe function.
   */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Register a handler that will be called whenever the connection status changes.
   * Returns an unsubscribe function.
   */
  onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  // ---------------------------------------------------------------------------
  // Internal — connection lifecycle
  // ---------------------------------------------------------------------------

  private readonly handleOpen = (): void => {
    // Perform auth handshake.
    const token = this.getToken();
    if (token) {
      this.sendClientMessage({
        type: 'auth',
        id: generateId(),
        token,
      });
    }

    const isReconnect = this.reconnectAttempts > 0;

    this.reconnectAttempts = 0;
    this.setStatus('connected');
    this.startPingTimer();

    if (isReconnect) {
      // Re-subscribe all tracked channels.
      this.resubscribeAll();
      this.onReconnected?.();
    }
  };

  private readonly handleMessage = (event: MessageEvent): void => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      // Malformed message — log and ignore per design.
      console.warn('[WebSocketManager] Failed to parse server message:', event.data);
      return;
    }

    this.dispatchMessage(message);
  };

  private readonly handleClose = (event: CloseEvent): void => {
    this.clearPingTimer();
    this.ws = null;

    if (event.code === AUTH_REJECTED_CODE) {
      // Auth rejected — do not reconnect.
      this.setStatus('disconnected');
      this.onAuthRejected();
      return;
    }

    // Start reconnection with exponential backoff.
    this.setStatus('reconnecting');
    this.scheduleReconnect();
  };

  private readonly handleError = (_event: Event): void => {
    // The browser fires `onerror` before `onclose`, so we just log here.
    // Reconnection is handled in `handleClose`.
    console.warn('[WebSocketManager] WebSocket error');
  };

  // ---------------------------------------------------------------------------
  // Internal — reconnection
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    this.clearReconnectTimer();

    const delay = calculateBackoffDelay(
      this.reconnectAttempts,
      this.baseDelay,
      this.maxDelay,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempts += 1;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — keepalive
  // ---------------------------------------------------------------------------

  private startPingTimer(): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      this.sendClientMessage({
        type: 'ping',
        id: generateId(),
        payload: {} as Record<string, never>,
      });
    }, this.pingIntervalMs);
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — subscription management
  // ---------------------------------------------------------------------------

  private resubscribeAll(): void {
    for (const channel of this.subscriptions) {
      this.sendClientMessage({
        type: 'subscribe',
        id: generateId(),
        payload: { channel },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — message dispatch
  // ---------------------------------------------------------------------------

  private dispatchMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'event':
        for (const handler of this.eventHandlers) {
          try {
            handler(message.payload.channel, message.payload.event);
          } catch (err) {
            console.error('[WebSocketManager] Event handler error:', err);
          }
        }
        break;

      case 'pong':
        // Keepalive acknowledged — nothing to do.
        break;

      case 'error':
        console.warn('[WebSocketManager] Server error:', message.payload.code, message.payload.message);
        break;

      case 'response':
        // Generic response — currently unused by the UI.
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — helpers
  // ---------------------------------------------------------------------------

  private sendClientMessage(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    for (const handler of this.statusHandlers) {
      try {
        handler(status);
      } catch (err) {
        console.error('[WebSocketManager] Status handler error:', err);
      }
    }
  }
}
