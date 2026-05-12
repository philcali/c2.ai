import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { destroyAuthDeps, getOrCreateAuthDeps } from '../../hooks/useAuth.js';
import { useSessionStore } from '../../stores/sessionStore.js';

// Mock the API client so the auth store can be created without a real backend.
vi.mock('../../api/client.js', () => ({
  createApiClient: () => ({
    authenticate: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ id: 'new-1', title: 'New Session', lastMessagePreview: '', updatedAt: new Date().toISOString(), hasActiveTasks: false }),
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

// Mock the WebSocket hook to avoid useSyncExternalStore issues in tests.
vi.mock('../../hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    status: 'disconnected' as const,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
  getOrCreateManager: vi.fn(),
  destroyManager: vi.fn(),
}));

// Mock the SessionSidebar to isolate App shell tests from session hook complexity.
vi.mock('../SessionSidebar/SessionSidebar.js', () => ({
  SessionSidebar: () => <div data-testid="session-sidebar">SessionSidebar</div>,
}));

// Mock ChatInterface to isolate App shell tests.
vi.mock('../Chat/ChatInterface.js', () => ({
  ChatInterface: () => <div data-testid="chat-interface">ChatInterface</div>,
}));

// Mock ConnectionBanner to isolate App shell tests.
vi.mock('../ConnectionBanner/ConnectionBanner.js', () => ({
  ConnectionBanner: () => null,
}));

// Mock WorkspaceIndicator to isolate App shell tests.
vi.mock('../Workspace/WorkspaceIndicator.js', () => ({
  WorkspaceIndicator: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="workspace-indicator">Workspace: {sessionId ?? 'none'}</div>
  ),
}));

// Import App after mocks are set up
import App from './App.js';

beforeEach(() => {
  destroyAuthDeps();
  // Reset stores
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    searchQuery: '',
    isLoading: false,
  });
  // Reset theme attribute
  document.documentElement.removeAttribute('data-theme');
});

/**
 * Helper: pre-authenticate so the AuthGuard renders the AppLayout.
 */
function authenticateUser() {
  const { useAuthStore } = getOrCreateAuthDeps();
  useAuthStore.setState({
    token: 'test-token',
    operatorId: 'op-1',
    isAuthenticated: true,
    isLoading: false,
    error: null,
  });
}

describe('App', () => {
  it('renders LoginForm when not authenticated', () => {
    render(<App />);
    expect(screen.getByRole('form', { name: /login/i })).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('renders the app shell when authenticated', () => {
    authenticateUser();
    render(<App />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /login/i })).not.toBeInTheDocument();
  });

  it('renders the header with title and theme toggle', () => {
    authenticateUser();
    render(<App />);

    expect(screen.getByText('Command Center')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('renders three-column layout: sidebar, chat, workspace', () => {
    authenticateUser();
    render(<App />);

    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('chat-area')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
  });

  it('renders SessionSidebar, ChatInterface, and WorkspaceIndicator', () => {
    authenticateUser();
    render(<App />);

    expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    // WorkspaceIndicator renders in both the right panel and the mobile sidebar
    expect(screen.getAllByTestId('workspace-indicator').length).toBeGreaterThanOrEqual(1);
  });

  it('passes activeSessionId to WorkspaceIndicator', () => {
    authenticateUser();
    useSessionStore.setState({ activeSessionId: 'sess-42' });
    render(<App />);

    // Both instances receive the same sessionId
    const indicators = screen.getAllByText('Workspace: sess-42');
    expect(indicators.length).toBeGreaterThanOrEqual(1);
  });

  it('toggles theme when theme button is clicked', () => {
    authenticateUser();
    render(<App />);

    const themeButton = screen.getByRole('button', { name: /switch to dark mode/i });
    fireEvent.click(themeButton);

    // After toggling, the button label should change
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
  });

  it('sidebar toggle button has correct aria-expanded attribute', () => {
    authenticateUser();
    render(<App />);

    const toggleButton = screen.getByLabelText(/toggle sidebar/i);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggleButton);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
  });

  it('clicking sidebar toggle opens the sidebar (adds sidebarOpen class)', () => {
    authenticateUser();
    render(<App />);

    const sidebar = screen.getByTestId('sidebar');
    const toggleButton = screen.getByLabelText(/toggle sidebar/i);

    // Initially sidebar should not have the open class
    expect(sidebar.className).not.toContain('sidebarOpen');

    fireEvent.click(toggleButton);
    expect(sidebar.className).toContain('sidebarOpen');
  });

  it('clicking overlay closes the sidebar', () => {
    authenticateUser();
    render(<App />);

    const toggleButton = screen.getByLabelText(/toggle sidebar/i);
    const overlay = screen.getByTestId('sidebar-overlay');
    const sidebar = screen.getByTestId('sidebar');

    // Open sidebar
    fireEvent.click(toggleButton);
    expect(sidebar.className).toContain('sidebarOpen');

    // Click overlay to close
    fireEvent.click(overlay);
    expect(sidebar.className).not.toContain('sidebarOpen');
  });

  it('sidebar has accessible label', () => {
    authenticateUser();
    render(<App />);

    const sidebar = screen.getByRole('complementary', { name: /session sidebar/i });
    expect(sidebar).toBeInTheDocument();
  });

  it('workspace panel has accessible label', () => {
    authenticateUser();
    render(<App />);

    const workspace = screen.getByRole('complementary', { name: /workspace indicator/i });
    expect(workspace).toBeInTheDocument();
  });
});
