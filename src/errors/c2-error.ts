import type { ErrorCode } from './error-codes.js';
import type { ErrorResponse, StructuredError } from './error-response.js';

export interface C2ErrorOptions {
  code: ErrorCode;
  message: string;
  details?: unknown;
  correlationId: string;
}

/**
 * Base error class for all C2 AI Command Center errors.
 * Carries a machine-readable code, optional details, and a correlation ID
 * for tracing through the audit log.
 */
export class C2Error extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly correlationId: string;

  constructor(options: C2ErrorOptions) {
    super(options.message);
    this.name = 'C2Error';
    this.code = options.code;
    this.details = options.details;
    this.correlationId = options.correlationId;
  }

  /**
   * Serialize to the standard ErrorResponse format used by REST and WebSocket interfaces.
   */
  toErrorResponse(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        correlationId: this.correlationId,
      },
    };
  }

  /**
   * Serialize to the StructuredError format used within subsystem boundaries.
   */
  toStructuredError(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
