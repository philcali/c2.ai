/**
 * Machine-readable error codes for the C2 AI Command Center.
 * Each code maps to a specific error category from the design document.
 */
export const ErrorCode = {
  /** Authorization denial (403) */
  AUTHZ_DENIED: 'AUTHZ_DENIED',

  /** Malformed input, invalid syntax (400) */
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  /** Max sessions, rate limit hit (429) */
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',

  /** Anti-leakage credential scan blocked message */
  PAYLOAD_BLOCKED: 'PAYLOAD_BLOCKED',

  /** Unknown session, namespace, service (404) */
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',

  /** Invalid/expired credentials (401) */
  AUTHENTICATION_FAILURE: 'AUTHENTICATION_FAILURE',

  /** External service call failed (502) */
  EXTERNAL_SERVICE_FAILURE: 'EXTERNAL_SERVICE_FAILURE',

  /** Unexpected internal error (500) */
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  /** Concurrent write conflict (409) */
  CONCURRENCY_CONFLICT: 'CONCURRENCY_CONFLICT',

  /** Invalid Agent Card, malformed ACP task (400) */
  ACP_PROTOCOL_ERROR: 'ACP_PROTOCOL_ERROR',

  /** Remote agent unreachable, task timeout (502) */
  ACP_TASK_FAILURE: 'ACP_TASK_FAILURE',

  /** Malformed JSON-RPC (-32700) */
  AGENTCP_PARSE_ERROR: 'AGENTCP_PARSE_ERROR',

  /** Unknown AgentCP method (-32601) */
  AGENTCP_METHOD_NOT_FOUND: 'AGENTCP_METHOD_NOT_FOUND',

  /** Invalid AgentCP params (-32602) */
  AGENTCP_INVALID_PARAMS: 'AGENTCP_INVALID_PARAMS',

  /** AgentCP file/terminal permission denied */
  AGENTCP_PERMISSION_DENIED: 'AGENTCP_PERMISSION_DENIED',

  /** Per-agent or per-service rate limit hit (429) */
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  /** MCP Gateway cannot safely sanitize response */
  SANITIZATION_FAILURE: 'SANITIZATION_FAILURE',

  /** ACP content type negotiation failure */
  CONTENT_TYPE_MISMATCH: 'CONTENT_TYPE_MISMATCH',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
