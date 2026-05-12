import type { ReactNode } from 'react';
import { useAuth } from '../../hooks/useAuth.js';
import { LoginForm } from '../LoginForm/LoginForm.js';

/**
 * Props for the AuthGuard component.
 */
export interface AuthGuardProps {
  children: ReactNode;
}

/**
 * Gate component that checks the auth store for a valid token.
 *
 * - When the operator is authenticated, renders the children.
 * - When the operator is not authenticated, renders the LoginForm.
 *
 * Requirements: 1.1, 1.5
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  return <>{children}</>;
}
