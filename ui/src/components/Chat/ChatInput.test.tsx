import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from './ChatInput.js';

describe('ChatInput', () => {
  it('renders textarea and send button', () => {
    render(<ChatInput onSend={vi.fn()} isSending={false} />);

    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    expect(screen.getByTestId('chat-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('chat-send-button')).toBeInTheDocument();
  });

  it('calls onSend with trimmed content when Enter is pressed', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} isSending={false} />);

    const textarea = screen.getByTestId('chat-textarea');

    // Type a message using fireEvent for direct value setting
    fireEvent.change(textarea, { target: { value: '  Hello world  ' } });

    // Press Enter to send
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('Hello world');
  });

  it('does not send on Shift+Enter (inserts new line)', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} isSending={false} />);

    const textarea = screen.getByTestId('chat-textarea');

    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send empty messages', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} isSending={false} />);

    const textarea = screen.getByTestId('chat-textarea');

    // Try to send with empty input
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send whitespace-only messages', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} isSending={false} />);

    const textarea = screen.getByTestId('chat-textarea');

    fireEvent.change(textarea, { target: { value: '   \n  \t  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('clears input after sending', () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} isSending={false} />);

    const textarea = screen.getByTestId('chat-textarea') as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('Hello');
    expect(textarea.value).toBe('');
  });

  it('disables textarea and button when isSending is true', () => {
    render(<ChatInput onSend={vi.fn()} isSending={true} />);

    expect(screen.getByTestId('chat-textarea')).toBeDisabled();
    expect(screen.getByTestId('chat-send-button')).toBeDisabled();
  });

  it('send button has accessible label', () => {
    render(<ChatInput onSend={vi.fn()} isSending={false} />);

    expect(screen.getByLabelText('Send message')).toBeInTheDocument();
  });

  it('textarea has accessible label', () => {
    render(<ChatInput onSend={vi.fn()} isSending={false} />);

    expect(screen.getByLabelText('Type a message')).toBeInTheDocument();
  });

  it('sends message when send button is clicked', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} isSending={false} />);

    const textarea = screen.getByTestId('chat-textarea');

    fireEvent.change(textarea, { target: { value: 'Click send' } });

    await user.click(screen.getByTestId('chat-send-button'));

    expect(onSend).toHaveBeenCalledWith('Click send');
  });

  it('send button is disabled when input is empty', () => {
    render(<ChatInput onSend={vi.fn()} isSending={false} />);

    expect(screen.getByTestId('chat-send-button')).toBeDisabled();
  });
});
