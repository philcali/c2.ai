/**
 * Discriminated union of all chat message types.
 *
 * Each variant carries a `type` discriminant so renderers can
 * exhaustively switch on the message kind.
 */
export type ChatMessage =
  | { type: 'operator'; id: string; content: string; timestamp: string }
  | { type: 'system'; id: string; content: string; timestamp: string; format: 'markdown' | 'plain' }
  | { type: 'task_created'; id: string; taskId: string; timestamp: string }
  | { type: 'error'; id: string; code: string; message: string; timestamp: string }
  | { type: 'memory_result'; id: string; data: unknown; timestamp: string };

/** Client-side chat state managed by the chat store. */
export interface ChatState {
  /** sessionId → messages */
  messages: Map<string, ChatMessage[]>;
  isLoading: boolean;
  isSending: boolean;
  /** sessionId → whether older messages exist */
  hasMore: Map<string, boolean>;
}

/** Paginated message response from the backend. */
export interface PaginatedMessages {
  messages: ChatMessage[];
  /** null means no more pages */
  cursor: string | null;
  hasMore: boolean;
}
