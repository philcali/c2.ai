import { useState, useCallback, useRef, type KeyboardEvent, type ChangeEvent } from 'react';
import styles from './ChatInput.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChatInputProps {
  /** Callback when the user submits a message. */
  onSend: (content: string) => void;
  /** Whether a message is currently being sent (disables input). */
  isSending: boolean;
}

// ---------------------------------------------------------------------------
// ChatInput component
// ---------------------------------------------------------------------------

/**
 * Multi-line text input with Enter to send and Shift+Enter for new line.
 *
 * Features:
 * - Auto-resizes the textarea as the user types (up to a max height)
 * - Disables textarea and send button while a message is in flight
 * - Does not send empty/whitespace-only messages
 * - Includes a send button for mouse/touch users
 *
 * Requirements: 3.2, 3.5
 */
export function ChatInput({ onSend, isSending }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize the textarea to fit content.
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset height so scrollHeight recalculates correctly.
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      autoResize();
    },
    [autoResize],
  );

  const send = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || isSending) return;
    onSend(trimmed);
    setValue('');
    // Reset textarea height after clearing.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.style.height = 'auto';
      }
    });
  }, [value, isSending, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  return (
    <div className={styles.container} data-testid="chat-input">
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={isSending}
        rows={1}
        aria-label="Type a message"
        data-testid="chat-textarea"
      />
      <button
        className={styles.sendButton}
        onClick={send}
        disabled={isSending || value.trim().length === 0}
        aria-label="Send message"
        data-testid="chat-send-button"
      >
        ↑
      </button>
    </div>
  );
}
