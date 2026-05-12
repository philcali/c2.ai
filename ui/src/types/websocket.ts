/**
 * Messages sent from the client to the WebSocket server.
 */
export type ClientMessage =
  | { type: 'auth'; id: string; token: string }
  | { type: 'subscribe'; id: string; payload: { channel: string } }
  | { type: 'unsubscribe'; id: string; payload: { channel: string } }
  | { type: 'ping'; id: string; payload: Record<string, never> }
  | { type: 'command'; id: string; payload: { action: string; params: Record<string, unknown> } };

/**
 * Messages received from the WebSocket server.
 */
export type ServerMessage =
  | { type: 'response'; id: string; payload: unknown }
  | { type: 'event'; payload: { channel: string; event: { type: string; data: unknown; timestamp: string } } }
  | { type: 'error'; id?: string; payload: { code: string; message: string } }
  | { type: 'pong'; id: string; payload: Record<string, never> };

/** WebSocket connection status. */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/** Client-side WebSocket state. */
export interface WebSocketState {
  status: ConnectionStatus;
  subscriptions: Set<string>;
  reconnectAttempts: number;
}
