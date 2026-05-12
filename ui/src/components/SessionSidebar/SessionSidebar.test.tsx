import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { destroyAuthDeps, getOrCreateAuthDeps } from '../../hooks/useAuth.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { SessionSummary } from '../../types/index.js';

const sampleSessions: SessionSummary[] = [
  {
    id: 'sess-1',
    title: 'First Session',
    lastMessagePreview: 'Hello from session 1',
    updatedAt: '2026-05-01T10:00:00Z',
    hasActiveTasks: false,
  },
  {
    id: 'sess-2',
    title: 'Second Session',
    lastMessagePreview: 'Working on feature X',
    updatedAt: '2026-05-02T10:00:00Z',
    hasActiveTasks: true,
  },
  {
    id: 'sess-3',
    title: 'Third Session',
    lastMessagePreview: 'Debugging issue Y',
    updatedAt: '2026-05-01T15:00:00Z',
    hasActiveTasks: false,
  },
];

// Mock the API client — listSessions returns the sample sessions.
vi.mock('../../api/client.js', () => ({
  createApiClient: () => ({
    authenticate: vi.fn(),
    listSessions: vi.fn().mockResolvedValue(sampleSessions),
    createSession: vi.fn().mockResolvedValue({
      id: 'new-1',
      title: 'New Session',
      lastMessagePreview: '',
      updatedAt: new Date().toISOString(),
      hasActiveTasks: false,
    }),
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

import { SessionSidebar } from './SessionSidebar.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  destroyAuthDeps();
  // Ensure auth deps are initialized for the hooks.
  getOrCreateAuthDeps();
  // Reset session store.
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    searchQuery: '',
    isLoading: false,
  });
});

describe('SessionSidebar', () => {
  it('renders the sidebar with search input and new session button', () => {
    renderWithProviders(<SessionSidebar />);

    expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('session-search-input')).toBeInTheDocument();
    expect(screen.getByTestId('new-session-button')).toBeInTheDocument();
  });

  it('renders all sessions after loading', async () => {
    renderWithProviders(<SessionSidebar />);

    // Wait for the query to resolve and sessions to appear.
    await waitFor(() => {
      expect(screen.getByTestId('session-entry-sess-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('session-entry-sess-2')).toBeInTheDocument();
    expect(screen.getByTestId('session-entry-sess-3')).toBeInTheDocument();
  });

  it('renders sessions sorted by updatedAt descending', async () => {
    renderWithProviders(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId('session-list')).toBeInTheDocument();
    });

    const list = screen.getByTestId('session-list');
    const entries = list.querySelectorAll('li');

    // sess-2 (May 2) > sess-3 (May 1 15:00) > sess-1 (May 1 10:00)
    expect(entries[0].querySelector('[data-testid^="session-entry-"]')?.getAttribute('data-testid')).toBe('session-entry-sess-2');
    expect(entries[1].querySelector('[data-testid^="session-entry-"]')?.getAttribute('data-testid')).toBe('session-entry-sess-3');
    expect(entries[2].querySelector('[data-testid^="session-entry-"]')?.getAttribute('data-testid')).toBe('session-entry-sess-1');
  });

  it('filters sessions when search query is entered', async () => {
    renderWithProviders(<SessionSidebar />);

    // Wait for sessions to load first.
    await waitFor(() => {
      expect(screen.getByTestId('session-entry-sess-1')).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId('session-search-input');
    fireEvent.change(searchInput, { target: { value: 'feature' } });

    // Only sess-2 has "feature" in its lastMessagePreview
    await waitFor(() => {
      expect(screen.getByTestId('session-entry-sess-2')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('session-entry-sess-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-entry-sess-3')).not.toBeInTheDocument();
  });

  it('shows empty state when no sessions match search', async () => {
    renderWithProviders(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId('session-entry-sess-1')).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId('session-search-input');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    await waitFor(() => {
      expect(screen.getByTestId('sessions-empty')).toBeInTheDocument();
    });
    expect(screen.getByText('No sessions match your search.')).toBeInTheDocument();
  });

  it('shows empty state when there are no sessions', async () => {
    // Override the mock to return empty array for this test.
    const { apiClient } = getOrCreateAuthDeps();
    (apiClient.listSessions as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    renderWithProviders(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId('sessions-empty')).toBeInTheDocument();
    });
    expect(screen.getByText('No sessions yet. Create one to get started.')).toBeInTheDocument();
  });

  it('highlights the active session', async () => {
    useSessionStore.setState({ activeSessionId: 'sess-2' });
    renderWithProviders(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId('session-entry-sess-2')).toBeInTheDocument();
    });

    const activeEntry = screen.getByTestId('session-entry-sess-2');
    expect(activeEntry).toHaveAttribute('aria-current', 'true');
    expect(activeEntry.className).toContain('active');

    const inactiveEntry = screen.getByTestId('session-entry-sess-1');
    expect(inactiveEntry).not.toHaveAttribute('aria-current');
  });

  it('sets active session when a session entry is clicked', async () => {
    renderWithProviders(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByTestId('session-entry-sess-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('session-entry-sess-1'));
    expect(useSessionStore.getState().activeSessionId).toBe('sess-1');
  });

  it('has accessible navigation landmark', () => {
    renderWithProviders(<SessionSidebar />);

    const nav = screen.getByRole('navigation', { name: /sessions/i });
    expect(nav).toBeInTheDocument();
  });

  it('search input has accessible label', () => {
    renderWithProviders(<SessionSidebar />);

    expect(screen.getByLabelText(/search sessions/i)).toBeInTheDocument();
  });

  it('new session button shows "+ New Session" text', () => {
    renderWithProviders(<SessionSidebar />);

    const button = screen.getByTestId('new-session-button');
    expect(button).toHaveTextContent('+ New Session');
  });

  it('renders session list as an accessible list', async () => {
    renderWithProviders(<SessionSidebar />);

    await waitFor(() => {
      expect(screen.getByRole('list')).toBeInTheDocument();
    });

    const list = screen.getByRole('list');
    expect(list.querySelectorAll('li')).toHaveLength(3);
  });

  it('shows loading state initially', () => {
    renderWithProviders(<SessionSidebar />);

    expect(screen.getByTestId('sessions-loading')).toBeInTheDocument();
  });
});
