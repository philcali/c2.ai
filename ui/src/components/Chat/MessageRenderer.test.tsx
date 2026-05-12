import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatMessage, CodingTask } from '../../types/index.js';
import type { UseTaskResult } from '../../hooks/useTask.js';

// ---------------------------------------------------------------------------
// Mock useTask hook
// ---------------------------------------------------------------------------

const defaultTaskResult: UseTaskResult = {
  task: undefined,
  isLoading: false,
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
};

let mockTaskResult: UseTaskResult = { ...defaultTaskResult };

vi.mock('../../hooks/useTask.js', () => ({
  useTask: () => mockTaskResult,
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

import { MessageRenderer } from './MessageRenderer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ts = '2026-06-01T10:00:00Z';

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

const sampleTask: CodingTask = {
  id: 'task-abc',
  operatorId: 'op-1',
  status: 'in_progress',
  assignedAgentId: 'agent-1',
  steps: [
    {
      id: 'step-1',
      taskId: 'task-abc',
      sequenceIndex: 0,
      instructions: 'Implement the feature',
      status: 'executing',
      artifacts: [],
      feedbackHistory: [],
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    },
    {
      id: 'step-2',
      taskId: 'task-abc',
      sequenceIndex: 1,
      instructions: 'Write tests',
      status: 'pending',
      artifacts: [],
      feedbackHistory: [],
      retryCount: 0,
      createdAt: ts,
      updatedAt: ts,
    },
  ],
  currentStepIndex: 0,
  createdAt: ts,
  updatedAt: ts,
};

beforeEach(() => {
  mockTaskResult = { ...defaultTaskResult };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageRenderer', () => {
  // ---- Operator messages ----

  it('renders operator message with content and timestamp', () => {
    const msg: ChatMessage = {
      type: 'operator',
      id: 'op-1',
      content: 'Hello, start a new task',
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('message-op-1')).toBeInTheDocument();
    expect(screen.getByText('Hello, start a new task')).toBeInTheDocument();

    const time = screen.getAllByRole('time')[0];
    expect(time).toHaveAttribute('datetime', ts);
  });

  // ---- System messages (plain) ----

  it('renders system message with plain text', () => {
    const msg: ChatMessage = {
      type: 'system',
      id: 'sys-1',
      content: 'Sure, creating a task for you.',
      timestamp: ts,
      format: 'plain',
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('message-sys-1')).toBeInTheDocument();
    expect(screen.getByText('Sure, creating a task for you.')).toBeInTheDocument();
  });

  // ---- System messages (markdown) ----

  it('renders system message with markdown bold', () => {
    const msg: ChatMessage = {
      type: 'system',
      id: 'sys-md-1',
      content: 'This is **bold** text',
      timestamp: ts,
      format: 'markdown',
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    const bold = screen.getByText('bold');
    expect(bold.tagName).toBe('STRONG');
  });

  it('renders system message with markdown code blocks', () => {
    const msg: ChatMessage = {
      type: 'system',
      id: 'sys-md-2',
      content: '```typescript\nconst x = 1;\n```',
      timestamp: ts,
      format: 'markdown',
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    expect(screen.getByText('typescript')).toBeInTheDocument();
  });

  it('renders system message with markdown links', () => {
    const msg: ChatMessage = {
      type: 'system',
      id: 'sys-md-3',
      content: 'Check [the docs](https://example.com) for details',
      timestamp: ts,
      format: 'markdown',
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders system message with inline code', () => {
    const msg: ChatMessage = {
      type: 'system',
      id: 'sys-md-4',
      content: 'Use `npm install` to install',
      timestamp: ts,
      format: 'markdown',
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    const code = screen.getByText('npm install');
    expect(code.tagName).toBe('CODE');
  });

  it('renders system message with italic text', () => {
    const msg: ChatMessage = {
      type: 'system',
      id: 'sys-md-5',
      content: 'This is *italic* text',
      timestamp: ts,
      format: 'markdown',
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    const italic = screen.getByText('italic');
    expect(italic.tagName).toBe('EM');
  });

  it('renders system message with unordered list', () => {
    const msg: ChatMessage = {
      type: 'system',
      id: 'sys-md-6',
      content: '- item one\n- item two\n- item three',
      timestamp: ts,
      format: 'markdown',
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByText('item one')).toBeInTheDocument();
    expect(screen.getByText('item two')).toBeInTheDocument();
    expect(screen.getByText('item three')).toBeInTheDocument();

    const list = screen.getByRole('list');
    expect(list.querySelectorAll('li')).toHaveLength(3);
  });

  // ---- Task created messages ----

  it('renders task_created message with TaskCard when task is loaded', () => {
    mockTaskResult = {
      ...defaultTaskResult,
      task: sampleTask,
    };

    const msg: ChatMessage = {
      type: 'task_created',
      id: 'tc-1',
      taskId: 'task-abc',
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('message-tc-1')).toBeInTheDocument();
    expect(screen.getByTestId('task-card-task-abc')).toBeInTheDocument();
    expect(screen.getByTestId('task-status')).toBeInTheDocument();
  });

  it('renders task_created message with loading state when task is not yet loaded', () => {
    mockTaskResult = {
      ...defaultTaskResult,
      isLoading: true,
      task: undefined,
    };

    const msg: ChatMessage = {
      type: 'task_created',
      id: 'tc-2',
      taskId: 'task-xyz',
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('task-loading-task-xyz')).toBeInTheDocument();
  });

  it('renders ReviewControls when current step is in review state', () => {
    const reviewTask: CodingTask = {
      ...sampleTask,
      steps: [
        {
          ...sampleTask.steps[0],
          status: 'review',
        },
        sampleTask.steps[1],
      ],
    };

    mockTaskResult = {
      ...defaultTaskResult,
      task: reviewTask,
    };

    const msg: ChatMessage = {
      type: 'task_created',
      id: 'tc-3',
      taskId: 'task-abc',
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('review-controls')).toBeInTheDocument();
    expect(screen.getByTestId('review-approve-btn')).toBeInTheDocument();
    expect(screen.getByTestId('review-retry-btn')).toBeInTheDocument();
    expect(screen.getByTestId('review-redirect-btn')).toBeInTheDocument();
  });

  it('does not render ReviewControls when step is not in review state', () => {
    mockTaskResult = {
      ...defaultTaskResult,
      task: sampleTask, // step status is 'executing', not 'review'
    };

    const msg: ChatMessage = {
      type: 'task_created',
      id: 'tc-4',
      taskId: 'task-abc',
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.queryByTestId('review-controls')).not.toBeInTheDocument();
  });

  // ---- Error messages ----

  it('renders error message with code badge and message text, has role="alert"', () => {
    const msg: ChatMessage = {
      type: 'error',
      id: 'err-1',
      code: 'SEND_FAILED',
      message: 'Failed to send message',
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('message-err-1')).toBeInTheDocument();
    expect(screen.getByText('SEND_FAILED')).toBeInTheDocument();
    expect(screen.getByText('Failed to send message')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  // ---- Memory result messages ----

  it('renders memory_result message with formatted data', () => {
    const data = { namespace: 'test', key: 'value', count: 42 };
    const msg: ChatMessage = {
      type: 'memory_result',
      id: 'mem-1',
      data,
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('message-mem-1')).toBeInTheDocument();
    // The data should be rendered as formatted JSON inside a <pre>
    const container = screen.getByTestId('message-mem-1');
    const pre = container.querySelector('pre');
    expect(pre).toBeInTheDocument();
    expect(pre!.textContent).toContain('"namespace": "test"');
    expect(pre!.textContent).toContain('"count": 42');
  });

  it('renders memory_result message with string data', () => {
    const msg: ChatMessage = {
      type: 'memory_result',
      id: 'mem-2',
      data: 'plain string result',
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByText('plain string result')).toBeInTheDocument();
  });

  it('renders memory_result with summary and entries as table', () => {
    const data = {
      summary: 'Found 2 entries',
      entries: [
        { namespace: 'ns1', key: 'k1', value: 'v1', timestamp: ts, tags: [] },
        { namespace: 'ns2', key: 'k2', value: 'v2', timestamp: ts, tags: [] },
      ],
    };
    const msg: ChatMessage = {
      type: 'memory_result',
      id: 'mem-3',
      data,
      timestamp: ts,
    };

    renderWithProviders(<MessageRenderer message={msg} />);

    expect(screen.getByTestId('memory-summary')).toHaveTextContent('Found 2 entries');
    expect(screen.getByTestId('memory-table')).toBeInTheDocument();
    expect(screen.getByText('ns1')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
  });

  // ---- Styling distinction ----

  it('operator messages have distinct styling from system messages', () => {
    const opMsg: ChatMessage = {
      type: 'operator',
      id: 'op-style',
      content: 'Operator text',
      timestamp: ts,
    };
    const sysMsg: ChatMessage = {
      type: 'system',
      id: 'sys-style',
      content: 'System text',
      timestamp: ts,
      format: 'plain',
    };

    const { rerender } = renderWithProviders(<MessageRenderer message={opMsg} />);
    const opEl = screen.getByTestId('message-op-style');
    const opClasses = opEl.className;

    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MessageRenderer message={sysMsg} />
      </QueryClientProvider>,
    );
    const sysEl = screen.getByTestId('message-sys-style');
    const sysClasses = sysEl.className;

    // They should have different class names (different styling)
    expect(opClasses).not.toBe(sysClasses);
  });

  // ---- All messages display timestamps ----

  it('all message types display timestamps', () => {
    // Set up task mock for task_created message
    mockTaskResult = { ...defaultTaskResult, task: sampleTask };

    const messages: ChatMessage[] = [
      { type: 'operator', id: 'ts-op', content: 'op', timestamp: ts },
      { type: 'system', id: 'ts-sys', content: 'sys', timestamp: ts, format: 'plain' },
      { type: 'task_created', id: 'ts-task', taskId: 'tid', timestamp: ts },
      { type: 'error', id: 'ts-err', code: 'E', message: 'err', timestamp: ts },
      { type: 'memory_result', id: 'ts-mem', data: 'data', timestamp: ts },
    ];

    for (const msg of messages) {
      const { unmount } = renderWithProviders(<MessageRenderer message={msg} />);
      const timeEls = screen.getAllByRole('time');
      expect(timeEls.length).toBeGreaterThan(0);
      expect(timeEls[timeEls.length - 1]).toHaveAttribute('datetime', ts);
      unmount();
    }
  });
});
