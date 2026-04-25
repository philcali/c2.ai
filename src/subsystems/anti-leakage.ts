import type { IAntiLeakage, ScanResult } from '../interfaces/anti-leakage.js';
import type { ACPMessagePayload } from '../interfaces/communication-bus.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';

/**
 * Credential-matching patterns used by the payload scanner.
 *
 * Each entry pairs a human-readable label with a regex that detects
 * common credential formats in stringified message payloads.
 */
const CREDENTIAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  // Generic API key formats: key-prefixed hex/alphanumeric strings
  { label: 'API key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i },
  // Bearer tokens (OAuth / JWT)
  { label: 'Bearer token', pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i },
  // AWS-style access keys (AKIA...)
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  // Generic secret / password assignments
  { label: 'password', pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}["']?/i },
  { label: 'secret', pattern: /(?:secret|client_secret|app_secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i },
  // Private key blocks
  { label: 'private key', pattern: /-----BEGIN\s(?:RSA\s)?PRIVATE\sKEY-----/ },
  // Generic token assignments
  { label: 'token', pattern: /(?:token|access_token|auth_token)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i },
];

/**
 * Keys commonly found in external service responses that carry credential
 * material or internal metadata irrelevant to the requesting agent.
 */
const SENSITIVE_RESPONSE_KEYS: Set<string> = new Set([
  'authorization',
  'x-api-key',
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'client_secret',
  'clientSecret',
  'secret',
  'password',
  'passwd',
  'token',
  'auth_token',
  'authToken',
  'private_key',
  'privateKey',
  'credentials',
  'cookie',
  'set-cookie',
  'x-request-id',
  'x-trace-id',
  'x-correlation-id',
  'x-forwarded-for',
  'x-real-ip',
]);

/**
 * In-memory Anti-Leakage module.
 *
 * Responsibilities:
 *  1. Scan inter-agent message payloads for credential material and
 *     restricted namespace references.
 *  2. Sanitize external service responses by stripping credential
 *     material and irrelevant metadata.
 *  3. Validate that delegated operations do not result in transitive
 *     privilege escalation — the originating agent must itself hold
 *     the permission for the requested operation.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */
export class AntiLeakage implements IAntiLeakage {
  /** Policy Engine used for transitive escalation checks. */
  private readonly policyEngine: IPolicyEngine;

  /**
   * Set of restricted namespace identifiers.
   * Messages referencing these namespaces are blocked.
   */
  private readonly restrictedNamespaces: Set<string>;

  constructor(options: {
    policyEngine: IPolicyEngine;
    restrictedNamespaces?: string[];
  }) {
    this.policyEngine = options.policyEngine;
    this.restrictedNamespaces = new Set(options.restrictedNamespaces ?? []);
  }

  // ------------------------------------------------------------------
  // IAntiLeakage — Payload scanning
  // ------------------------------------------------------------------

  /**
   * Scan an ACP message payload for credential material and restricted
   * namespace references.
   *
   * The scanner stringifies the payload body and runs it against known
   * credential patterns. It also checks for references to restricted
   * namespaces.
   *
   * Requirements: 9.3
   */
  scanMessagePayload(payload: ACPMessagePayload): ScanResult {
    const violations: string[] = [];

    // Stringify the body for pattern matching.
    const bodyStr = this.safeStringify(payload.body);

    // Check for credential patterns.
    for (const { label, pattern } of CREDENTIAL_PATTERNS) {
      if (pattern.test(bodyStr)) {
        violations.push(`Credential material detected: ${label}`);
      }
    }

    // Check for restricted namespace references.
    for (const ns of this.restrictedNamespaces) {
      if (bodyStr.includes(ns)) {
        violations.push(`Reference to restricted namespace: ${ns}`);
      }
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }

  // ------------------------------------------------------------------
  // IAntiLeakage — Response sanitization
  // ------------------------------------------------------------------

  /**
   * Strip credential material and irrelevant metadata from an external
   * service response before returning it to an agent.
   *
   * The sanitizer recursively walks the response object and removes
   * keys that are known to carry sensitive data. It also scans string
   * values for credential patterns and redacts them.
   *
   * Requirements: 9.4
   */
  sanitizeExternalResponse(
    response: unknown,
    _agentPermissions: string[],
  ): unknown {
    return this.deepSanitize(response);
  }

  // ------------------------------------------------------------------
  // IAntiLeakage — Transitive escalation check
  // ------------------------------------------------------------------

  /**
   * Validate that the origin agent's permissions cover the requested
   * operation. This prevents agent A from asking agent B to perform
   * an operation that agent A itself is not allowed to perform.
   *
   * Returns `true` if the operation is safe (no escalation), `false`
   * if it would constitute transitive privilege escalation.
   *
   * Requirements: 9.2
   */
  validateNoTransitiveEscalation(
    originAgentId: string,
    _targetAgentId: string,
    operation: string,
  ): boolean {
    // Parse the operation string to extract the resource.
    // Convention: "operation:resource" (e.g., "read:memory:shared-ns")
    const colonIndex = operation.indexOf(':');
    let op: string;
    let resource: string;

    if (colonIndex !== -1) {
      op = operation.slice(0, colonIndex);
      resource = operation.slice(colonIndex + 1);
    } else {
      // If no resource separator, treat the whole string as the operation
      // and use a wildcard resource.
      op = operation;
      resource = '*';
    }

    // Check whether the origin agent has the permission it is trying
    // to delegate. If the Policy Engine denies it, this is an escalation.
    const decision = this.policyEngine.evaluate({
      agentId: originAgentId,
      operation: op,
      resource,
    });

    return decision.allowed;
  }

  // ------------------------------------------------------------------
  // Admin helpers
  // ------------------------------------------------------------------

  /**
   * Add a namespace to the restricted set at runtime.
   * Messages referencing restricted namespaces will be blocked.
   */
  addRestrictedNamespace(namespace: string): void {
    this.restrictedNamespaces.add(namespace);
  }

  /**
   * Remove a namespace from the restricted set.
   */
  removeRestrictedNamespace(namespace: string): void {
    this.restrictedNamespaces.delete(namespace);
  }

  /**
   * Return the current set of restricted namespaces.
   */
  getRestrictedNamespaces(): string[] {
    return Array.from(this.restrictedNamespaces);
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Safely stringify a value for pattern matching.
   * Handles circular references and non-serializable values gracefully.
   */
  private safeStringify(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  /**
   * Recursively sanitize a value by removing sensitive keys and
   * redacting credential patterns in string values.
   */
  private deepSanitize(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return this.redactCredentials(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deepSanitize(item));
    }

    if (typeof value === 'object') {
      const sanitized: Record<string, unknown> = {};
      const obj = value as Record<string, unknown>;

      for (const key of Object.keys(obj)) {
        // Skip keys that are known to carry sensitive data.
        if (SENSITIVE_RESPONSE_KEYS.has(key.toLowerCase())) {
          sanitized[key] = '[REDACTED]';
          continue;
        }

        sanitized[key] = this.deepSanitize(obj[key]);
      }

      return sanitized;
    }

    // Primitives (number, boolean, etc.) pass through unchanged.
    return value;
  }

  /**
   * Redact credential patterns found in a string value.
   * Replaces matched patterns with a [REDACTED] placeholder.
   */
  private redactCredentials(value: string): string {
    let result = value;

    for (const { pattern } of CREDENTIAL_PATTERNS) {
      // Use a fresh regex with the global flag for replacement.
      const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      result = result.replace(globalPattern, '[REDACTED]');
    }

    return result;
  }
}
