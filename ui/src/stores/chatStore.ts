import { create } from 'zustand';
import type { ChatMessage } from '../types/index.js';

/**
 * Actions exposed by the chat store.
 */
export interface ChatActions {
  /** Append a single message to a session's message list. */
  addMessage: (sessionId: string, message: ChatMessage) => void;
  /** Replace the full message list for a session (e.g. initial load or reconciliation). */
  setMessages: (sessionId: string, messages: ChatMessage[]) => void;
  /** Prepend older messages (loaded via pagination) to a session's list. */
  prependMessages: (sessionId: string, messages: ChatMessage[]) => void;
  /** Set the global loading flag (fetching messages). */
  setLoading: (isLoading: boolean) => void;
  /** Set the sending flag (message being sent). */
  setSending: (isSending: boolean) => void;
  /** Set whether a session has more (older) messages to load. */
  setHasMore: (sessionId: string, hasMore: boolean) => void;
}

export interface ChatStoreState {
  /** sessionId → messages */
  messages: Map<string, ChatMessage[]>;
  isLoading: boolean;
  isSending: boolean;
  /** sessionId → whether older messages exist */
  hasMore: Map<string, boolean>;
}

export type ChatStore = ChatStoreState & ChatActions;

export const useChatStore = create<ChatStore>((set) => ({
  // -- State --
  messages: new Map(),
  isLoading: false,
  isSending: false,
  hasMore: new Map(),

  // -- Actions --

  addMessage: (sessionId, message) =>
    set((state) => {
      const updated = new Map(state.messages);
      const existing = updated.get(sessionId) ?? [];
      // Deduplicate: skip if a message with this ID already exists.
      if (existing.some((m) => m.id === message.id)) {
        return state;
      }
      updated.set(sessionId, [...existing, message]);
      return { messages: updated };
    }),

  setMessages: (sessionId, messages) =>
    set((state) => {
      const updated = new Map(state.messages);
      updated.set(sessionId, messages);
      return { messages: updated };
    }),

  prependMessages: (sessionId, messages) =>
    set((state) => {
      const updated = new Map(state.messages);
      const existing = updated.get(sessionId) ?? [];
      updated.set(sessionId, [...messages, ...existing]);
      return { messages: updated };
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setSending: (isSending) => set({ isSending }),

  setHasMore: (sessionId, hasMore) =>
    set((state) => {
      const updated = new Map(state.hasMore);
      updated.set(sessionId, hasMore);
      return { hasMore: updated };
    }),
}));
