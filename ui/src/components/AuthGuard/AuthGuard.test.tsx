import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthGuard } from './AuthGuard.js';
import { destroyAuthDeps, getOrCreateAuthDeps } from '../../hooks/useAuth.js';

/**
 * Helper: wrap component in a fresh QueryClientProvider.
 */
function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// Mock the API client module so the auth store can be created without a real backend.
vi.mock('../../api/client.js', () => {
  return {
    createApiClient: () => ({
      authenticate: vi.fn(),
      listSessions: vi.fn(),
      createSession: vi.fn(),
      getSessionMessages: vi.fn(),
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
  };
});

beforeEach(() => {
  destroyAuthDeps();
});

describe('AuthGuard', () => {
  it('renders LoginForm when the operator is not authenticated', () => {
    renderWithProviders(
      <AuthGuard>
        <div data-testid="protected-content">Dashboard</div>
      </AuthGuard>,
    );

    // LoginForm should be visible (it renders a form with aria-label "Login")
    expect(screen.getByRole('form', { name: /login/i })).toBeInTheDocument();

    // Protected content should NOT be rendered
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders children when the operator is authenticated', () => {
    // Pre-set the auth store to an authenticated state
    const { useAuthStore } = getOrCreateAuthDeps();
    useAuthStore.setState({
      token: 'valid-token-123',
      operatorId: 'op-1',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    renderWithProviders(
      <AuthGuard>
        <div data-testid="protected-content">Dashboard</div>
      </AuthGuard>,
    );

    // Protected content should be visible
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();

    // LoginForm should NOT be rendered
    expect(screen.queryByRole('form', { name: /login/i })).not.toBeInTheDocument();
  });

  it('switches from LoginForm to children when auth state changes', () => {
    const { useAuthStore } = getOrCreateAuthDeps();

    const { rerender } = renderWithProviders(
      <AuthGuard>
        <div data-testid="protected-content">Dashboard</div>
      </AuthGuard>,
    );

    // Initially not authenticated — LoginForm shown
    expect(screen.getByRole('form', { name: /login/i })).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();

    // Simulate successful authentication
    useAuthStore.setState({
      token: 'tok-abc',
      operatorId: 'op-2',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });

    // Re-render to pick up the store change
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    rerender(
      <QueryClientProvider client={queryClient}>
        <AuthGuard>
          <div data-testid="protected-content">Dashboard</div>
        </AuthGuard>
      </QueryClientProvider>,
    );

    // Now children should be visible
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /login/i })).not.toBeInTheDocument();
  });

  it('renders LoginForm when token is null even if other state is set', () => {
    const { useAuthStore } = getOrCreateAuthDeps();
    useAuthStore.setState({
      token: null,
      operatorId: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });

    renderWithProviders(
      <AuthGuard>
        <div data-testid="protected-content">Dashboard</div>
      </AuthGuard>,
    );

    expect(screen.getByRole('form', { name: /login/i })).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });
});
