import type WebSocket from 'ws';

export type EventChannel =
  | 'session:state'
  | 'audit:stream'
  | 'agent:messages'
  | `session:${string}`;

export interface WebSocketMessage {
  type: 'command' | 'subscribe' | 'unsubscribe' | 'ping';
  id: string;
  payload: unknown;
}

export interface WebSocketResponse {
  type: 'response' | 'event' | 'error' | 'pong';
  id?: string;
  payload: unknown;
}

export interface SystemEvent {
  channel: EventChannel;
  type: string;
  data: unknown;
  timestamp: Date;
}

export interface IOperatorInterface {
  handleConnection(socket: WebSocket, operatorId: string): void;
  broadcastEvent(channel: EventChannel, event: SystemEvent): void;
}
