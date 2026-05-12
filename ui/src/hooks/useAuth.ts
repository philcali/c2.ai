import { useMutation } from '@tanstack/react-query';
import type { LoginCredentials } from '../types/index.js';
import { createAuthStore } from '../stores/authStore.js';
import {
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
} from '../api/client.js';

// ---------------------------------------------------------------------------
// Singleton API client + auth store
// ---------------------------------------------------------------------------

let apiClientInstance: ApiClient | null = null;
let authStoreInstance: ReturnType<typeof createAuthStore> | null = null;

/**
 * Initialise (or return) the singleton API client and auth store pair.
 *
 * The auth store requires an ApiClient (for `authenticate()`), and the
 * ApiClient requires a `getToken` callback that reads from the auth
 * store.  This factory wires the two together once and caches the
 * result.
 */
export function getOrCreateAuthDeps(overrides?: Partial<ApiClientOptions>): {
  apiClient: ApiClient;
  useAuthStore: ReturnType<typeof createAuthStore>;
} {
  if (!authStoreInstance || !apiClientInstance) {
    // Create a temporary reference so the getToken closure can read
    // from the store that hasn't been assigned yet.
    let storeRef: ReturnType<typeof createAuthStore> | null = null;

    const clientOptions: ApiClientOptions = {
      getToken: () => storeRef?.getState().token ?? null,
      onAuthError: () => {
        storeRef?.getState().logout();
      },
      ...overrides,
    };

    apiClientInstance = createApiClient(clientOptions);
    authStoreInstance = createAuthStore(apiClientInstance);
    storeRef = authStoreInstance;
  }

  return { apiClient: apiClientInstance, useAuthStore: authStoreInstance };
}

/**
 * Tear down the singletons.  Useful in tests or on hard-reset.
 */
export function destroyAuthDeps(): void {
  apiClientInstance = null;
  authStoreInstance = null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseAuthResult {
  /** Trigger a login attempt. */
  login: (credentials: LoginCredentials) => void;
  /** Log out and clear the stored token. */
  logout: () => void;
  /** Whether the operator holds a valid token. */
  isAuthenticated: boolean;
  /** Whether a login request is in flight. */
  isLoading: boolean;
  /** The last authentication error message, if any. */
  error: string | null;
  /** Dismiss the current error. */
  clearError: () => void;
  /** The current auth token (null when unauthenticated). */
  token: string | null;
  /** The authenticated operator's ID. */
  operatorId: string | null;
}

/**
 * React hook that wraps the auth store and API client.
 *
 * Uses TanStack Query's `useMutation` for the login call so callers
 * get automatic loading/error state tracking that integrates with the
 * React Query devtools.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5
 */
export function useAuth(): UseAuthResult {
  const { useAuthStore } = getOrCreateAuthDeps();

  const token = useAuthStore((s) => s.token);
  const operatorId = useAuthStore((s) => s.operatorId);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const storeIsLoading = useAuthStore((s) => s.isLoading);
  const storeError = useAuthStore((s) => s.error);
  const storeLogin = useAuthStore((s) => s.login);
  const storeLogout = useAuthStore((s) => s.logout);
  const storeClearError = useAuthStore((s) => s.clearError);

  const loginMutation = useMutation<void, Error, LoginCredentials>({
    mutationFn: async (credentials: LoginCredentials) => {
      await storeLogin(credentials);

      // The store sets its own error on failure.  If the store still
      // has an error after the call we surface it as a mutation error
      // so TanStack Query's `isError` flag is consistent.
      const currentError = useAuthStore.getState().error;
      if (currentError) {
        throw new Error(currentError);
      }
    },
  });

  return {
    login: (credentials: LoginCredentials) => loginMutation.mutate(credentials),
    logout: storeLogout,
    isAuthenticated,
    isLoading: storeIsLoading || loginMutation.isPending,
    error: storeError ?? (loginMutation.error?.message ?? null),
    clearError: () => {
      storeClearError();
      loginMutation.reset();
    },
    token,
    operatorId,
  };
}
