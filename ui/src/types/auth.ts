/** Authentication state managed by the auth store. */
export interface AuthState {
  token: string | null;
  operatorId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

/** Credentials submitted by the operator for login. */
export interface LoginCredentials {
  token: string;
}

/** Token response returned by the backend on successful authentication. */
export interface AuthToken {
  token: string;
  operatorId: string;
  expiresAt: string;
}
