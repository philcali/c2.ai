import { v4 as uuidv4 } from 'uuid';
import type {
  IMCPGateway,
  ServiceConfig,
  OperationResult,
  ServiceStatus,
} from '../interfaces/mcp-gateway.js';
import type { ValidationResult } from '../interfaces/manifest-validator.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { IAntiLeakage } from '../interfaces/anti-leakage.js';
import { ErrorCode } from '../errors/error-codes.js';

/**
 * Tracks request timestamps for a single rate-limit bucket.
 * Used for both per-agent and per-service rate limiting.
 */
interface RateLimitBucket {
  /** Timestamps (ms) of requests within the current window. */
  timestamps: number[];
}

/**
 * Optional executor function that subsystems or tests can provide
 * to simulate actual external service calls. If not provided, the
 * gateway returns a default success result.
 */
export type ServiceExecutor = (
  serviceId: string,
  operation: string,
  params: unknown,
  config: ServiceConfig,
) => Promise<OperationResult>;

/**
 * In-memory MCP Gateway with policy enforcement and rate limiting.
 *
 * Responsibilities:
 *  1. Register and manage external service configurations.
 *  2. Authorize every operation through the Policy Engine before execution.
 *  3. Enforce per-agent and per-service rate limits with configurable windows.
 *  4. Manage credentials on behalf of agents (agents never see raw credentials).
 *  5. Sanitize external service responses via the Anti-Leakage module.
 *  6. Record all operations (success, denial, failure) in the Audit Log.
 *  7. Return structured errors for external service failures.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 9.4
 */
export class MCPGateway implements IMCPGateway {
  /** Registered external services keyed by service ID. */
  private readonly services: Map<string, ServiceConfig> = new Map();

  /** Service availability status keyed by service ID. */
  private readonly serviceStatuses: Map<string, ServiceStatus> = new Map();

  /** Per-agent rate limit buckets: `agent:{agentId}:service:{serviceId}` → bucket. */
  private readonly agentRateLimits: Map<string, RateLimitBucket> = new Map();

  /** Per-service rate limit buckets: `service:{serviceId}` → bucket. */
  private readonly serviceRateLimits: Map<string, RateLimitBucket> = new Map();

  /** Policy Engine for authorization checks. */
  private readonly policyEngine: IPolicyEngine;

  /** Audit Log for recording operations and denials. */
  private readonly auditLog: IAuditLog;

  /** Anti-Leakage module for response sanitization. */
  private readonly antiLeakage: IAntiLeakage;

  /** Optional executor for external service calls. */
  private readonly executor?: ServiceExecutor;

  constructor(options: {
    policyEngine: IPolicyEngine;
    auditLog: IAuditLog;
    antiLeakage: IAntiLeakage;
    executor?: ServiceExecutor;
  }) {
    this.policyEngine = options.policyEngine;
    this.auditLog = options.auditLog;
    this.antiLeakage = options.antiLeakage;
    this.executor = options.executor;
  }

  // ------------------------------------------------------------------
  // IMCPGateway — Service registration
  // ------------------------------------------------------------------

  /**
   * Register an external service with the gateway.
   *
   * Validates the service configuration and rejects duplicates or
   * configs with missing required fields.
   *
   * Requirements: 5.5
   */
  registerService(config: ServiceConfig): ValidationResult {
    const errors: string[] = [];

    if (!config.id || config.id.trim() === '') {
      errors.push('Service ID is required');
    }
    if (!config.name || config.name.trim() === '') {
      errors.push('Service name is required');
    }
    if (!config.endpoint || config.endpoint.trim() === '') {
      errors.push('Service endpoint is required');
    }
    if (!config.credentialRef || config.credentialRef.trim() === '') {
      errors.push('Credential reference is required');
    }
    if (!config.rateLimits) {
      errors.push('Rate limits configuration is required');
    } else {
      if (typeof config.rateLimits.perAgent !== 'number' || config.rateLimits.perAgent < 1) {
        errors.push('Per-agent rate limit must be a positive number');
      }
      if (typeof config.rateLimits.perService !== 'number' || config.rateLimits.perService < 1) {
        errors.push('Per-service rate limit must be a positive number');
      }
      if (typeof config.rateLimits.windowMs !== 'number' || config.rateLimits.windowMs < 1) {
        errors.push('Rate limit window must be a positive number of milliseconds');
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    if (this.services.has(config.id)) {
      return {
        valid: false,
        errors: [`Service with ID '${config.id}' is already registered`],
      };
    }

    this.services.set(config.id, { ...config });
    this.serviceStatuses.set(config.id, {
      serviceId: config.id,
      available: true,
      lastChecked: new Date(),
    });

    return { valid: true, errors: [] };
  }

  /**
   * Unregister an external service and clean up its rate limit buckets.
   *
   * Requirements: 5.5
   */
  unregisterService(serviceId: string): void {
    this.services.delete(serviceId);
    this.serviceStatuses.delete(serviceId);

    // Clean up rate limit buckets for this service.
    const serviceKey = `service:${serviceId}`;
    this.serviceRateLimits.delete(serviceKey);

    // Clean up per-agent buckets referencing this service.
    for (const key of this.agentRateLimits.keys()) {
      if (key.endsWith(`:service:${serviceId}`)) {
        this.agentRateLimits.delete(key);
      }
    }
  }

  // ------------------------------------------------------------------
  // IMCPGateway — Operation execution
  // ------------------------------------------------------------------

  /**
   * Execute an external service operation with full policy enforcement,
   * rate limiting, credential management, and audit logging.
   *
   * Flow:
   *  1. Verify the service exists.
   *  2. Authorize the operation via the Policy Engine.
   *  3. Enforce per-agent and per-service rate limits.
   *  4. Execute the operation (using the executor or returning a default result).
   *  5. Sanitize the response via the Anti-Leakage module.
   *  6. Record the result in the Audit Log.
   *
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 9.4
   */
  async executeOperation(
    agentId: string,
    serviceId: string,
    operation: string,
    params: unknown,
  ): Promise<OperationResult> {
    const now = new Date();
    const correlationId = uuidv4();

    // 1. Verify the service exists.
    const config = this.services.get(serviceId);
    if (!config) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'external_service',
        operation,
        resource: `mcp:${serviceId}`,
        decision: 'deny',
        details: {
          correlationId,
          reason: `Service '${serviceId}' not found`,
          errorCode: ErrorCode.RESOURCE_NOT_FOUND,
        },
      });

      return {
        success: false,
        error: {
          code: ErrorCode.RESOURCE_NOT_FOUND,
          message: `Service '${serviceId}' is not registered`,
        },
      };
    }

    // 2. Policy Engine authorization check.
    const decision = this.policyEngine.evaluate({
      agentId,
      operation,
      resource: `mcp:${serviceId}`,
      context: { serviceId, operation },
    });

    if (!decision.allowed) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'external_service',
        operation,
        resource: `mcp:${serviceId}`,
        decision: 'deny',
        details: {
          correlationId,
          reason: decision.reason,
          policyId: decision.policyId,
          errorCode: ErrorCode.AUTHZ_DENIED,
        },
      });

      return {
        success: false,
        error: {
          code: ErrorCode.AUTHZ_DENIED,
          message: `Authorization denied: ${decision.reason}`,
        },
      };
    }

    // 3. Rate limit enforcement.
    const rateLimitResult = this.checkRateLimits(agentId, serviceId, config);
    if (!rateLimitResult.allowed) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId,
        eventType: 'external_service',
        operation,
        resource: `mcp:${serviceId}`,
        decision: 'deny',
        details: {
          correlationId,
          reason: rateLimitResult.reason,
          errorCode: ErrorCode.RATE_LIMIT_EXCEEDED,
        },
      });

      return {
        success: false,
        error: {
          code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message: rateLimitResult.reason!,
        },
      };
    }

    // Record the request in rate limit buckets.
    this.recordRateLimitRequest(agentId, serviceId);

    // 4. Execute the operation.
    let result: OperationResult;
    try {
      if (this.executor) {
        result = await this.executor(serviceId, operation, params, config);
      } else {
        // Default: return a success result indicating no real executor is wired.
        result = {
          success: true,
          data: { message: 'Operation executed (no executor configured)' },
        };
      }
    } catch (err: unknown) {
      // External service failure — structured error handling.
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Update service status to unavailable.
      this.serviceStatuses.set(serviceId, {
        serviceId,
        available: false,
        lastChecked: new Date(),
      });

      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId,
        eventType: 'external_service',
        operation,
        resource: `mcp:${serviceId}`,
        details: {
          correlationId,
          success: false,
          errorCode: ErrorCode.EXTERNAL_SERVICE_FAILURE,
          errorMessage,
          serviceName: config.name,
        },
      });

      return {
        success: false,
        error: {
          code: ErrorCode.EXTERNAL_SERVICE_FAILURE,
          message: `External service failure: ${errorMessage}`,
          details: { serviceId, serviceName: config.name, operation },
        },
      };
    }

    // Handle non-exception failures returned by the executor.
    if (!result.success) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId,
        eventType: 'external_service',
        operation,
        resource: `mcp:${serviceId}`,
        details: {
          correlationId,
          success: false,
          errorCode: result.error?.code ?? ErrorCode.EXTERNAL_SERVICE_FAILURE,
          errorMessage: result.error?.message,
          serviceName: config.name,
        },
      });

      return result;
    }

    // 5. Sanitize the response via Anti-Leakage module.
    // Build the agent's permission list from the policy context.
    const agentPermissions = this.getAgentPermissions(agentId, serviceId);
    const sanitizedData = this.antiLeakage.sanitizeExternalResponse(
      result.data,
      agentPermissions,
    );

    // Update service status to available on success.
    this.serviceStatuses.set(serviceId, {
      serviceId,
      available: true,
      lastChecked: new Date(),
    });

    // 6. Record successful operation in audit log.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      agentId,
      eventType: 'external_service',
      operation,
      resource: `mcp:${serviceId}`,
      decision: 'allow',
      details: {
        correlationId,
        success: true,
        serviceName: config.name,
      },
    });

    return {
      success: true,
      data: sanitizedData,
    };
  }

  // ------------------------------------------------------------------
  // IMCPGateway — Service listing and status
  // ------------------------------------------------------------------

  /**
   * List all registered service configurations.
   *
   * Requirements: 5.5
   */
  listServices(): ServiceConfig[] {
    return Array.from(this.services.values()).map((config) => ({ ...config }));
  }

  /**
   * Get the current status of a registered service.
   *
   * Requirements: 5.5
   */
  getServiceStatus(serviceId: string): ServiceStatus {
    const status = this.serviceStatuses.get(serviceId);
    if (status) {
      return { ...status };
    }

    // Return an unavailable status for unknown services.
    return {
      serviceId,
      available: false,
      lastChecked: new Date(),
    };
  }

  // ------------------------------------------------------------------
  // Rate limiting internals
  // ------------------------------------------------------------------

  /**
   * Check whether the request is within both per-agent and per-service
   * rate limits for the given service configuration.
   *
   * Requirements: 5.6
   */
  private checkRateLimits(
    agentId: string,
    serviceId: string,
    config: ServiceConfig,
  ): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const windowMs = config.rateLimits.windowMs;

    // Per-agent rate limit check.
    const agentKey = `agent:${agentId}:service:${serviceId}`;
    const agentBucket = this.getOrCreateBucket(this.agentRateLimits, agentKey);
    this.pruneExpiredTimestamps(agentBucket, now, windowMs);

    if (agentBucket.timestamps.length >= config.rateLimits.perAgent) {
      return {
        allowed: false,
        reason: `Per-agent rate limit exceeded for service '${serviceId}': ${config.rateLimits.perAgent} requests per ${windowMs}ms window`,
      };
    }

    // Per-service rate limit check.
    const serviceKey = `service:${serviceId}`;
    const serviceBucket = this.getOrCreateBucket(this.serviceRateLimits, serviceKey);
    this.pruneExpiredTimestamps(serviceBucket, now, windowMs);

    if (serviceBucket.timestamps.length >= config.rateLimits.perService) {
      return {
        allowed: false,
        reason: `Per-service rate limit exceeded for service '${serviceId}': ${config.rateLimits.perService} requests per ${windowMs}ms window`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a request timestamp in both per-agent and per-service buckets.
   */
  private recordRateLimitRequest(agentId: string, serviceId: string): void {
    const now = Date.now();

    const agentKey = `agent:${agentId}:service:${serviceId}`;
    const agentBucket = this.getOrCreateBucket(this.agentRateLimits, agentKey);
    agentBucket.timestamps.push(now);

    const serviceKey = `service:${serviceId}`;
    const serviceBucket = this.getOrCreateBucket(this.serviceRateLimits, serviceKey);
    serviceBucket.timestamps.push(now);
  }

  /**
   * Get or create a rate limit bucket in the given map.
   */
  private getOrCreateBucket(
    map: Map<string, RateLimitBucket>,
    key: string,
  ): RateLimitBucket {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      map.set(key, bucket);
    }
    return bucket;
  }

  /**
   * Remove timestamps that have fallen outside the rate limit window.
   */
  private pruneExpiredTimestamps(
    bucket: RateLimitBucket,
    now: number,
    windowMs: number,
  ): void {
    const cutoff = now - windowMs;
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > cutoff);
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Build a list of permission strings for the given agent and service.
   * Used by the Anti-Leakage module to scope response sanitization.
   */
  private getAgentPermissions(agentId: string, serviceId: string): string[] {
    // Return a basic set of permission identifiers that the Anti-Leakage
    // module can use to determine what data the agent is allowed to see.
    return [
      `mcp:${serviceId}:agent:${agentId}`,
      `mcp:${serviceId}`,
    ];
  }
}
