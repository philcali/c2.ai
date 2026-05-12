import { useCallback, useEffect, useRef } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useChatStore } from '../stores/chatStore.js';
import { getOrCreateAuthDeps } from './useAuth.js';
import type { ChatMessage, PaginatedMessages } from '../types/index.js';

// Stable empty array to avoid creating a new reference on every selector call.
const EMPTY_MESSAGES: ChatMessage[] = [];

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const chatKeys = {
  all: ['chat'] as const,
  messages: (sessionId: string) =>
    [...chatKeys.all, 'messages', sessionId] as const,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseChatResult {
  /** Messages for the active session (from the Zustand store). */
  messages: ChatMessage[];
  /** Whether the initial message fetch is in progress. */
  isLoading: boolean;
  /** Whether a message is currently being sent. */
  isSending: boolean;
  /** Whether older messages are available for pagination. */
  hasMore: boolean;
  /** Send a new message with optimistic update. */
  sendMessage: (content: string) => void;
  /** Load older messages (cursor-based pagination). */
  loadMore: () => void;
  /** Error from the last send attempt, if any. */
  sendError: string | null;
}

/**
 * React hook for chat message fetching and sending within a session.
 *
 * - Uses TanStack Query to fetch the initial page of messages.
 * - Implements `sendMessage()` with an optimistic update: the message
 *   appears immediately with a temporary ID, and is replaced by the
 *   server response on success.
 * - Implements `loadMore()` for cursor-based pagination of older messages.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.6
 */
export function useChat(sessionId: string | null): UseChatResult {
  const { apiClient } = getOrCreateAuthDeps();

  const storeMessages = useChatStore((s) =>
    sessionId ? (s.messages.get(sessionId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const storeHasMore = useChatStore((s) =>
    sessionId ? (s.hasMore.get(sessionId) ?? true) : false,
  );
  const setMessages = useChatStore((s) => s.setMessages);
  const prependMessages = useChatStore((s) => s.prependMessages);
  const addMessage = useChatStore((s) => s.addMessage);
  const setHasMore = useChatStore((s) => s.setHasMore);
  const setLoading = useChatStore((s) => s.setLoading);
  const setSending = useChatStore((s) => s.setSending);

  // Track the pagination cursor for loadMore.
  const cursorRef = useRef<string | null>(null);

  // -- Initial message fetch --
  const messagesQuery = useQuery<PaginatedMessages>({
    queryKey: chatKeys.messages(sessionId ?? '__none__'),
    queryFn: async () => {
      if (!sessionId) throw new Error('No active session');
      return apiClient.getSessionMessages(sessionId);
    },
    enabled: !!sessionId,
  });

  // Sync initial fetch results into the store.
  useEffect(() => {
    if (messagesQuery.data && sessionId) {
      const current = useChatStore.getState().messages.get(sessionId);
      // Only set if the store doesn't have messages yet (avoid overwriting
      // messages that arrived via WebSocket after the initial fetch).
      if (!current || current.length === 0) {
        setMessages(sessionId, messagesQuery.data.messages);
        setHasMore(sessionId, messagesQuery.data.hasMore);
        cursorRef.current = messagesQuery.data.cursor;
      }
    }
  }, [messagesQuery.data, sessionId, setMessages, setHasMore]);

  // -- Send message mutation with optimistic update --
  const sendMutation = useMutation<ChatMessage, Error, string, { optimisticId: string }>({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('No active session');
      setSending(true);
      try {
        return await apiClient.sendMessage(sessionId, content);
      } finally {
        setSending(false);
      }
    },
    onMutate: (content: string): { optimisticId: string } => {
      if (!sessionId) return { optimisticId: '' };

      // Optimistic message with a temporary ID.
      const optimistic: ChatMessage = {
        type: 'operator',
        id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content,
        timestamp: new Date().toISOString(),
      };
      addMessage(sessionId, optimistic);

      return { optimisticId: optimistic.id };
    },
    onSuccess: (serverMessage, _content, context) => {
      if (!sessionId || !context) return;

      // The server message may have already arrived via WebSocket.
      // Remove the optimistic message and ensure the server message
      // exists exactly once.
      const current = useChatStore.getState().messages.get(sessionId) ?? [];
      const alreadyExists = current.some((msg) => msg.id === serverMessage.id);

      let updated: ChatMessage[];
      if (alreadyExists) {
        // WebSocket delivered it first — just remove the optimistic entry.
        updated = current.filter((msg) => msg.id !== context.optimisticId);
      } else {
        // Replace the optimistic message with the server response.
        updated = current.map((msg) =>
          msg.id === context.optimisticId ? serverMessage : msg,
        );
      }
      setMessages(sessionId, updated);
    },
    onError: (_error, _content, context) => {
      if (!sessionId || !context) return;

      // Mark the optimistic message as an error so the UI can show a
      // retry indicator.
      const current = useChatStore.getState().messages.get(sessionId) ?? [];
      const updated = current.map((msg) =>
        msg.id === context.optimisticId
          ? ({
              type: 'error' as const,
              id: context.optimisticId,
              code: 'SEND_FAILED',
              message: 'Failed to send message',
              timestamp: msg.timestamp,
            })
          : msg,
      );
      setMessages(sessionId, updated);
    },
  });

  // -- Load older messages --
  const loadMore = useCallback(() => {
    if (!sessionId || !storeHasMore || messagesQuery.isFetching) return;

    setLoading(true);
    apiClient
      .getSessionMessages(sessionId, cursorRef.current ?? undefined)
      .then((page: PaginatedMessages) => {
        prependMessages(sessionId, page.messages);
        setHasMore(sessionId, page.hasMore);
        cursorRef.current = page.cursor;
      })
      .catch(() => {
        // Silently fail — the user can retry by scrolling up again.
      })
      .finally(() => {
        setLoading(false);
      });
  }, [sessionId, storeHasMore, messagesQuery.isFetching, apiClient, setLoading, prependMessages, setHasMore]);

  return {
    messages: storeMessages,
    isLoading: messagesQuery.isLoading,
    isSending: sendMutation.isPending,
    hasMore: storeHasMore,
    sendMessage: (content: string) => sendMutation.mutate(content),
    loadMore,
    sendError: sendMutation.error?.message ?? null,
  };
}
