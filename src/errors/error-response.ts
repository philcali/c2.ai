/**
 * Structured error format used within subsystem boundaries.
 */
export interface StructuredError {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Standard error response format returned across REST and WebSocket interfaces.
 * All errors follow this consistent structure.
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId: string;
  };
}
