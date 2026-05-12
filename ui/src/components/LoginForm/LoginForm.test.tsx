import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoginForm } from './LoginForm.js';
import { destroyAuthDeps } from '../../hooks/useAuth.js';

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

// We mock the createApiClient factory so the useAuth hook uses our mock.
vi.mock('../../api/client.js', () => {
  type AuthenticateFn = (creds: { token: string }) => Promise<{
    token: string;
    operatorId: string;
    expiresAt: string;
  }>;

  let mockAuthenticate: AuthenticateFn = vi.fn();

  return {
    createApiClient: () => ({
      authenticate: (...args: unknown[]) => mockAuthenticate(args[0] as { token: string }),
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
    ApiClientImpl: vi.fn(),
    __setMockAuthenticate: (fn: AuthenticateFn) => {
      mockAuthenticate = fn;
    },
  };
});

type MockAuthenticateFn = (creds: { token: string }) => Promise<{
  token: string;
  operatorId: string;
  expiresAt: string;
}>;

// Import the setter so tests can control the mock authenticate behaviour.
async function setMockAuthenticate(fn: MockAuthenticateFn) {
  const mod = await import('../../api/client.js') as unknown as {
    __setMockAuthenticate: (fn: MockAuthenticateFn) => void;
  };
  mod.__setMockAuthenticate(fn);
}

beforeEach(() => {
  destroyAuthDeps();
});

describe('LoginForm', () => {
  it('renders a token field with a submit button', () => {
    renderWithProviders(<LoginForm />);

    expect(screen.getByLabelText('Token')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /authenticate/i })).toBeInTheDocument();
  });

  it('has accessible form with label and form role', () => {
    renderWithProviders(<LoginForm />);

    const form = screen.getByRole('form', { name: /login/i });
    expect(form).toBeInTheDocument();

    // Token input is associated with its label
    const tokenInput = screen.getByLabelText('Token');
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tokenInput).toHaveAttribute('autocomplete', 'off');
  });

  it('calls login with entered token on form submit', async () => {
    const user = userEvent.setup();
    const authenticateMock = vi.fn().mockResolvedValue({
      token: 'my-secret-token',
      operatorId: 'op-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await setMockAuthenticate(authenticateMock);

    renderWithProviders(<LoginForm />);

    await user.type(screen.getByLabelText('Token'), 'my-secret-token');
    await user.click(screen.getByRole('button', { name: /authenticate/i }));

    expect(authenticateMock).toHaveBeenCalledWith({
      token: 'my-secret-token',
    });
  });

  it('displays a generic error message on failed login', async () => {
    const user = userEvent.setup();
    await setMockAuthenticate(() => Promise.reject(new Error('Invalid token: my-secret-token')));

    renderWithProviders(<LoginForm />);

    await user.type(screen.getByLabelText('Token'), 'my-secret-token');
    await user.click(screen.getByRole('button', { name: /authenticate/i }));

    // Wait for the error to appear
    const alert = await screen.findByRole('alert');
    expect(alert).toBeInTheDocument();

    // The error message should be generic — never reveal the token
    expect(alert.textContent).toContain('Authentication failed');
    expect(alert.textContent).not.toContain('my-secret-token');
  });

  it('disables form fields and button while loading', async () => {
    const user = userEvent.setup();

    // Create a promise we can control to keep the login in-flight
    let resolveLogin!: (value: { token: string; operatorId: string; expiresAt: string }) => void;
    const pendingLogin = new Promise<{ token: string; operatorId: string; expiresAt: string }>(
      (resolve) => { resolveLogin = resolve; },
    );
    await setMockAuthenticate(() => pendingLogin);

    renderWithProviders(<LoginForm />);

    await user.type(screen.getByLabelText('Token'), 'tok-123');
    await user.click(screen.getByRole('button', { name: /authenticate/i }));

    // While loading, field and button should be disabled
    expect(screen.getByLabelText('Token')).toBeDisabled();
    expect(screen.getByRole('button', { name: /authenticating/i })).toBeDisabled();

    // Resolve to clean up
    resolveLogin({
      token: 'tok-123',
      operatorId: 'op-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  });

  it('clears error when user starts typing again', async () => {
    const user = userEvent.setup();
    await setMockAuthenticate(() => Promise.reject(new Error('fail')));

    renderWithProviders(<LoginForm />);

    await user.type(screen.getByLabelText('Token'), 'bad-token');
    await user.click(screen.getByRole('button', { name: /authenticate/i }));

    // Error should appear
    await screen.findByRole('alert');

    // Typing in token field should clear the error
    await user.type(screen.getByLabelText('Token'), 'x');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
