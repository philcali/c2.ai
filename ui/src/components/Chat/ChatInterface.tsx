import { useEffect, useRef } from 'react';
import { useChat } from '../../hooks/useChat.js';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { MessageRenderer } from './MessageRenderer.js';
import { ChatInput } from './ChatInput.js';
import styles from './ChatInterface.module.css';

// ---------------------------------------------------------------------------
// Loading dots component
// ---------------------------------------------------------------------------

function LoadingDots() {
  return (
    <span className={styles.dots} aria-hidden="true">
      <span className={styles.dot} />
      <span className={styles.dot} />
      <span className={styles.dot} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// ChatInterface component
// ---------------------------------------------------------------------------

/**
 * Chat interface — center panel displaying the message list for the
 * active session.
 *
 * Features:
 * - Renders messages in chronological order
 * - Auto-scrolls to bottom when new messages arrive
 * - Infinite scroll sentinel at top for loading older messages
 * - Loading indicator while backend is processing
 * - Sending indicator while a message is in flight
 *
 * Requirements: 3.1, 3.3, 3.6
 */
export function ChatInterface() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const { messages, isLoading, isSending, hasMore, loadMore, sendMessage } = useChat(activeSessionId);

  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const prevMessageCountRef = useRef(0);

  // Infinite scroll sentinel at the top for loading older messages.
  const { sentinelRef } = useInfiniteScroll({
    loadMore,
    hasMore,
    isLoading,
  });

  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    const area = messageAreaRef.current;
    if (!area) return;

    // Only auto-scroll when messages are appended (count increases).
    if (messages.length > prevMessageCountRef.current) {
      area.scrollTop = area.scrollHeight;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  // -----------------------------------------------------------------------
  // Empty state — no active session
  // -----------------------------------------------------------------------

  if (!activeSessionId) {
    return (
      <div
        className={styles.container}
        data-testid="chat-interface"
        aria-label="Chat interface"
      >
        <div className={styles.emptyState} data-testid="chat-empty-state">
          Select a session to start chatting.
        </div>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Active session — message list
  // -----------------------------------------------------------------------

  return (
    <div
      className={styles.container}
      data-testid="chat-interface"
      aria-label="Chat interface"
    >
      <div
        className={styles.messageArea}
        ref={messageAreaRef}
        role="log"
        aria-live="polite"
        aria-label="Message list"
        data-testid="message-list"
      >
        {/* Infinite scroll sentinel — triggers loadMore when visible */}
        <div
          ref={sentinelRef as React.RefObject<HTMLDivElement>}
          className={styles.sentinel}
          data-testid="scroll-sentinel"
          aria-hidden="true"
        />

        {/* Messages in chronological order */}
        {messages.map((msg) => (
          <MessageRenderer key={msg.id} message={msg} />
        ))}

        {/* Loading indicator — backend is processing */}
        {isLoading && (
          <div
            className={styles.loadingIndicator}
            role="status"
            aria-label="Loading messages"
            data-testid="loading-indicator"
          >
            Loading <LoadingDots />
          </div>
        )}

        {/* Sending indicator */}
        {isSending && (
          <div
            className={styles.sendingIndicator}
            role="status"
            aria-label="Sending message"
            data-testid="sending-indicator"
          >
            Sending <LoadingDots />
          </div>
        )}
      </div>

      <ChatInput onSend={sendMessage} isSending={isSending} />
    </div>
  );
}
