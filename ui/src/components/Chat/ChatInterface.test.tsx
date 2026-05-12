import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { ChatMessage } from '../../types/index.js';
import type { UseChatResult } from '../../hooks/useChat.js';

// ---------------------------------------------------------------------------
// Mock IntersectionObserver (not available in jsdom)
// ---------------------------------------------------------------------------

class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
}

beforeEach(() => {
  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
});

// ---------------------------------------------------------------------------
// Mock useChat hook
// ---------------------------------------------------------------------------

const defaultChatResult: UseChatResult = {
  messages: [],
  isLoading: false,
  isSending: false,
  hasMore: false,
  sendMessage: vi.fn(),
  loadMore: vi.fn(),
  sendError: null,
};

let mockChatResult: UseChatResult = { ...defaultChatResult };

vi.mock('../../hooks/useChat.js', () => ({
  useChat: () => mockChatResult,
  chatKeys: {
    all: ['chat'] as const,
    messages: (sessionId: string) => ['chat', 'messages', sessionId] as const,
  },
}));

// Mock useWebSocket to avoid useSyncExternalStore issues.
vi.mock('../../hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    status: 'disconnected' as const,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
  getOrCreateManager: vi.fn(),
  destroyManager: vi.fn(),
}));

// Mock useTask to avoid real API calls in ChatInterface tests.
vi.mock('../../hooks/useTask.js', () => ({
  useTask: () => ({
    task: undefined,
    isLoading: true,
    isExpanded: false,
    toggleExpanded: vi.fn(),
    advanceTask: vi.fn(),
    isAdvancing: false,
    retryStep: vi.fn(),
    isRetrying: false,
    redirectTask: vi.fn(),
    isRedirecting: false,
    cancelTask: vi.fn(),
    isCanceling: false,
    mutationError: null,
  }),
  taskKeys: {
    all: ['tasks'] as const,
    detail: (taskId: string) => ['tasks', 'detail', taskId] as const,
    list: (sessionId: string) => ['tasks', 'list', sessionId] as const,
  },
}));

// Mock the API client
vi.mock('../../api/client.js', () => ({
  createApiClient: () => ({
    authenticate: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [], cursor: null, hasMore: false }),
    sendMessage: vi.fn(),
    getTask: vi.fn(),
    listTasks: vi.fn(),
    advanceTask: vi.fn(),
    retryStep: vi.fn(),
    redirectTask: vi.fn(),
    cancelTask: vi.fn(),
    getArtifacts: vi.fn(),
    queryMemory: vi.fn(),
  }),
}));

import { ChatInterface } from './ChatInterface.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const sampleMessages: ChatMessage[] = [
  {
    type: 'operator',
    id: 'msg-1',
    content: 'Hello, start a new task',
    timestamp: '2026-06-01T10:00:00Z',
  },
  {
    type: 'system',
    id: 'msg-2',
    content: 'Sure, creating a task for you.',
    timestamp: '2026-06-01T10:00:05Z',
    format: 'plain',
  },
  {
    type: 'task_created',
    id: 'msg-3',
    taskId: 'task-abc',
    timestamp: '2026-06-01T10:00:10Z',
  },
  {
    type: 'error',
    id: 'msg-4',
    code: 'ERR_TIMEOUT',
    message: 'Request timed out',
    timestamp: '2026-06-01T10:00:15Z',
  },
];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset stores.
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    searchQuery: '',
    isLoading: false,
  });

  // Reset mock chat result.
  mockChatResult = { ...defaultChatResult };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatInterface', () => {
  it('renders empty state when no active session', () => {
    renderWithProviders(<ChatInterface />);

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    expect(screen.getByTestId('chat-empty-state')).toBeInTheDocument();
    expect(screen.getByText('Select a session to start chatting.')).toBeInTheDocument();
  });

  it('renders messages when a session is active', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, messages: sampleMessages };

    renderWithProviders(<ChatInterface />);

    expect(screen.getByTestId('message-msg-1')).toBeInTheDocument();
    expect(screen.getByTestId('message-msg-2')).toBeInTheDocument();
    expect(screen.getByTestId('message-msg-3')).toBeInTheDocument();
    expect(screen.getByTestId('message-msg-4')).toBeInTheDocument();

    expect(screen.getByText('Hello, start a new task')).toBeInTheDocument();
    expect(screen.getByText('Sure, creating a task for you.')).toBeInTheDocument();
    // task_created messages now render an InlineTaskCard (loading state when task not yet fetched)
    expect(screen.getByTestId('task-loading-task-abc')).toBeInTheDocument();
    expect(screen.getByText('Request timed out')).toBeInTheDocument();
  });

  it('renders messages in chronological order', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, messages: sampleMessages };

    renderWithProviders(<ChatInterface />);

    const messageList = screen.getByTestId('message-list');
    const messageElements = messageList.querySelectorAll('[data-testid^="message-msg-"]');

    expect(messageElements[0]).toHaveAttribute('data-testid', 'message-msg-1');
    expect(messageElements[1]).toHaveAttribute('data-testid', 'message-msg-2');
    expect(messageElements[2]).toHaveAttribute('data-testid', 'message-msg-3');
    expect(messageElements[3]).toHaveAttribute('data-testid', 'message-msg-4');
  });

  it('shows loading indicator when isLoading is true', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, isLoading: true };

    renderWithProviders(<ChatInterface />);

    expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading messages')).toBeInTheDocument();
  });

  it('shows sending indicator when isSending is true', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, isSending: true };

    renderWithProviders(<ChatInterface />);

    expect(screen.getByTestId('sending-indicator')).toBeInTheDocument();
    expect(screen.getByLabelText('Sending message')).toBeInTheDocument();
  });

  it('has the infinite scroll sentinel element', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, hasMore: true };

    renderWithProviders(<ChatInterface />);

    const sentinel = screen.getByTestId('scroll-sentinel');
    expect(sentinel).toBeInTheDocument();
    expect(sentinel).toHaveAttribute('aria-hidden', 'true');
  });

  it('does not show loading indicator when not loading', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, isLoading: false, messages: sampleMessages };

    renderWithProviders(<ChatInterface />);

    expect(screen.queryByTestId('loading-indicator')).not.toBeInTheDocument();
  });

  it('does not show empty state when a session is active', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult };

    renderWithProviders(<ChatInterface />);

    expect(screen.queryByTestId('chat-empty-state')).not.toBeInTheDocument();
  });

  it('renders error messages with error code and message text', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = {
      ...defaultChatResult,
      messages: [
        {
          type: 'error',
          id: 'err-1',
          code: 'SEND_FAILED',
          message: 'Failed to send message',
          timestamp: '2026-06-01T10:00:00Z',
        },
      ],
    };

    renderWithProviders(<ChatInterface />);

    expect(screen.getByText('SEND_FAILED')).toBeInTheDocument();
    expect(screen.getByText('Failed to send message')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Accessibility
  // -----------------------------------------------------------------------

  it('has accessible aria-label on the container', () => {
    renderWithProviders(<ChatInterface />);

    expect(screen.getByLabelText('Chat interface')).toBeInTheDocument();
  });

  it('has accessible message list with log role', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, messages: sampleMessages };

    renderWithProviders(<ChatInterface />);

    const messageList = screen.getByRole('log');
    expect(messageList).toBeInTheDocument();
    expect(messageList).toHaveAttribute('aria-live', 'polite');
    expect(messageList).toHaveAttribute('aria-label', 'Message list');
  });

  it('scroll-to-bottom: message area ref exists for scroll management', () => {
    useSessionStore.setState({ activeSessionId: 'sess-1' });
    mockChatResult = { ...defaultChatResult, messages: sampleMessages };

    renderWithProviders(<ChatInterface />);

    const messageArea = screen.getByTestId('message-list');
    expect(messageArea).toBeInTheDocument();
  });
});
