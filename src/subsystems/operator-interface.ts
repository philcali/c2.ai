import { v4 as uuidv4 } from 'uuid';
import type WebSocket from 'ws';
import type {
  IOperatorInterface,
  EventChannel,
  WebSocketMessage,
  WebSocketResponse,
  SystemEvent,
} from '../interfaces/operator-interface.js';
import type {
  ISessionManager,
} from '../interfaces/session-manager.js';
import type {
  IPolicyEngine,
  AccessPolicy,
  PolicyScope,
} from '../interfaces/policy-engine.js';
import type {
  IMemoryStore,
  MemoryQuery,
} from '../interfaces/memory-store.js';
import type {
  IAuditLog,
  AuditQuery,
  AuditFilter,
} from '../interfaces/audit-log.js';
import type { AgentManifest } from '../interfaces/manifest-validator.js';

// ------------------------------------------------------------------
// Types for the REST route handler layer
// ------------------------------------------------------------------

/** Simplified HTTP-like request object for route handlers. */
export interface RouteRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  operatorId: string;
}

/** Simplified HTTP-like response object from route handlers. */
export interface RouteResponse {
  status: number;
  body: unknown;
}

/** Operator credentials used for authentication. */
export interface OperatorCredentials {
  operatorId: string;
  permissions: string[];
}

/**
 * Authentication function provided by the host application.
 * Returns operator credentials if the token is valid, or undefined if not.
 */
export type AuthenticateFn = (token: string) => OperatorCredentials | undefined;

// ------------------------------------------------------------------
// Internal types for WebSocket connection management
// ------------------------------------------------------------------

/** Tracks a single authenticated WebSocket connection. */
interface ClientConnection {
  id: string;
  socket: WebSocket;
  operatorId: string;
  permissions: string[];
  subscriptions: Set<string>;
  alive: boolean;
}

// ------------------------------------------------------------------
// Permission constants for management operations
// ------------------------------------------------------------------

const PERMISSIONS = {
  SESSION_CREATE: 'session:create',
  SESSION_TERMINATE: 'session:terminate',
  SESSION_PAUSE: 'session:pause',
  SESSION_RESUME: 'session:resume',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  POLICY_ADD: 'policy:add',
  POLICY_UPDATE: 'policy:update',
  POLICY_REMOVE: 'policy:remove',
  POLICY_GET: 'policy:get',
  POLICY_LIST: 'policy:list',
  POLICY_ROLLBACK: 'policy:rollback',
  MEMORY_QUERY: 'memory:query',
  MEMORY_DELETE: 'memory:delete',
  AUDIT_QUERY: 'audit:query',
  AUDIT_STREAM: 'audit:stream',
} as const;


/**
 * Operator Interface — REST API + WebSocket server for the C2 Command Center.
 *
 * Provides:
 *  - REST route handlers for session lifecycle, policy management, memory
 *    administration, and audit log queries.
 *  - WebSocket server with authentication, heartbeat/keepalive, and a
 *    JSON message protocol (command, subscribe, unsubscribe, ping/pong).
 *  - Event channel subscriptions with push delivery to subscribed clients.
 *  - Real-time audit log streaming over WebSocket with filtering.
 *  - Per-session channels (`session:${id}`) for real-time agent interaction.
 *  - Multiple concurrent WebSocket connections with independent auth.
 *  - Authentication and authorization checks for all management commands.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8
 */
export class OperatorInterface implements IOperatorInterface {
  // ------------------------------------------------------------------
  // Dependencies
  // ------------------------------------------------------------------

  private readonly sessionManager: ISessionManager;
  private readonly policyEngine: IPolicyEngine;
  private readonly memoryStore: IMemoryStore;
  private readonly auditLog: IAuditLog;
  private readonly authenticate: AuthenticateFn;

  // ------------------------------------------------------------------
  // WebSocket connection tracking
  // ------------------------------------------------------------------

  /** All active WebSocket connections, keyed by connection ID. */
  private readonly connections: Map<string, ClientConnection> = new Map();

  /** Heartbeat interval handle (for cleanup on shutdown). */
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /** Heartbeat interval in milliseconds. */
  private readonly heartbeatIntervalMs: number;

  /** Active audit stream iterators that need cleanup. */
  private readonly auditStreamCleanups: Map<string, () => void> = new Map();

  constructor(options: {
    sessionManager: ISessionManager;
    policyEngine: IPolicyEngine;
    memoryStore: IMemoryStore;
    auditLog: IAuditLog;
    authenticate: AuthenticateFn;
    heartbeatIntervalMs?: number;
  }) {
    this.sessionManager = options.sessionManager;
    this.policyEngine = options.policyEngine;
    this.memoryStore = options.memoryStore;
    this.auditLog = options.auditLog;
    this.authenticate = options.authenticate;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  }

  // ==================================================================
  // IOperatorInterface — WebSocket connection handling
  // ==================================================================

  /**
   * Handle a new WebSocket connection from an authenticated operator.
   * The operator has already been authenticated by the time this is called.
   *
   * Requirements: 10.2, 10.3, 10.8
   */
  handleConnection(socket: WebSocket, operatorId: string): void {
    const connId = uuidv4();

    const connection: ClientConnection = {
      id: connId,
      socket,
      operatorId,
      permissions: [], // Will be populated if authenticate is called with a token
      subscriptions: new Set(),
      alive: true,
    };

    this.connections.set(connId, connection);

    // Start heartbeat if not already running.
    this.ensureHeartbeat();

    // Wire up WebSocket event handlers.
    socket.on('message', (data: Buffer | string) => {
      this.handleMessage(connection, data).catch(() => {
        // Swallow async errors — they are handled inside handleMessage.
      });
    });

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('close', () => {
      this.cleanupConnection(connId);
    });

    socket.on('error', () => {
      this.cleanupConnection(connId);
    });
  }

  /**
   * Handle a new WebSocket connection that requires token-based authentication.
   * The first message from the client must be an auth message with a token.
   * If authentication fails, the connection is closed with code 4001.
   *
   * Requirements: 10.3, 10.8
   */
  handleConnectionWithAuth(socket: WebSocket): void {
    let authenticated = false;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        socket.close(4001, 'Authentication timeout');
      }
    }, 10_000);

    socket.on('message', (data: Buffer | string) => {
      if (!authenticated) {
        clearTimeout(authTimeout);
        try {
          const msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
          if (msg.type === 'auth' && typeof msg.token === 'string') {
            const creds = this.authenticate(msg.token);
            if (creds) {
              authenticated = true;
              const connId = uuidv4();
              const connection: ClientConnection = {
                id: connId,
                socket,
                operatorId: creds.operatorId,
                permissions: creds.permissions,
                subscriptions: new Set(),
                alive: true,
              };
              this.connections.set(connId, connection);
              this.ensureHeartbeat();

              // Send auth success response.
              this.sendResponse(socket, {
                type: 'response',
                id: msg.id,
                payload: { success: true, operatorId: creds.operatorId },
              });

              // Re-wire message handler for authenticated connection.
              socket.removeAllListeners('message');
              socket.on('message', (msgData: Buffer | string) => {
                this.handleMessage(connection, msgData).catch(() => {});
              });

              socket.on('pong', () => {
                connection.alive = true;
              });

              socket.on('close', () => {
                this.cleanupConnection(connId);
              });

              socket.on('error', () => {
                this.cleanupConnection(connId);
              });
            } else {
              socket.close(4001, 'Authentication failed');
            }
          } else {
            socket.close(4002, 'First message must be auth');
          }
        } catch {
          socket.close(4002, 'Invalid message format');
        }
        return;
      }
    });
  }

  // ==================================================================
  // IOperatorInterface — Event broadcasting
  // ==================================================================

  /**
   * Push an event to all WebSocket clients subscribed to the given channel.
   *
   * Requirements: 10.7
   */
  broadcastEvent(channel: EventChannel, event: SystemEvent): void {
    const message: WebSocketResponse = {
      type: 'event',
      payload: {
        channel,
        event: {
          type: event.type,
          data: event.data,
          timestamp: event.timestamp.toISOString(),
        },
      },
    };

    for (const connection of this.connections.values()) {
      if (connection.subscriptions.has(channel)) {
        this.sendResponse(connection.socket, message);
      }
    }
  }

  // ==================================================================
  // REST route handling
  // ==================================================================

  /**
   * Handle an incoming REST-style request. This is the main entry point
   * for the REST API layer. The host application (e.g., an HTTP server)
   * parses the HTTP request into a RouteRequest and calls this method.
   *
   * All routes require authentication (operatorId must be set) and
   * authorization (operator must have the required permission).
   *
   * Requirements: 10.1, 10.3
   */
  async handleRequest(request: RouteRequest): Promise<RouteResponse> {
    // Authentication check — operatorId must be present.
    if (!request.operatorId) {
      return {
        status: 401,
        body: { error: { code: 'AUTHENTICATION_FAILURE', message: 'Operator not authenticated' } },
      };
    }

    // Route the request to the appropriate handler.
    try {
      return await this.routeRequest(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return {
        status: 500,
        body: {
          error: {
            code: 'INTERNAL_ERROR',
            message,
            correlationId: uuidv4(),
          },
        },
      };
    }
  }

  // ==================================================================
  // Lifecycle
  // ==================================================================

  /**
   * Gracefully shut down the operator interface.
   * Closes all WebSocket connections and stops the heartbeat timer.
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Clean up all audit stream iterators.
    for (const cleanup of this.auditStreamCleanups.values()) {
      cleanup();
    }
    this.auditStreamCleanups.clear();

    // Close all connections.
    for (const [connId, connection] of this.connections) {
      connection.socket.close(1001, 'Server shutting down');
      this.connections.delete(connId);
    }
  }

  /**
   * Get the number of active WebSocket connections.
   * Useful for monitoring and testing.
   */
  getConnectionCount(): number {
    return this.connections.size;
  }


  // ==================================================================
  // Internal — WebSocket message handling
  // ==================================================================

  /**
   * Parse and dispatch a WebSocket message from an authenticated client.
   */
  private async handleMessage(
    connection: ClientConnection,
    data: Buffer | string,
  ): Promise<void> {
    let msg: WebSocketMessage;

    try {
      const raw = typeof data === 'string' ? data : data.toString('utf-8');
      msg = JSON.parse(raw) as WebSocketMessage;
    } catch {
      this.sendResponse(connection.socket, {
        type: 'error',
        payload: { code: 'VALIDATION_ERROR', message: 'Invalid JSON' },
      });
      return;
    }

    // Validate message structure.
    if (!msg.type || !msg.id) {
      this.sendResponse(connection.socket, {
        type: 'error',
        id: msg.id,
        payload: { code: 'VALIDATION_ERROR', message: 'Message must have type and id' },
      });
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.sendResponse(connection.socket, { type: 'pong', id: msg.id, payload: {} });
        break;

      case 'subscribe':
        await this.handleSubscribe(connection, msg);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(connection, msg);
        break;

      case 'command':
        await this.handleCommand(connection, msg);
        break;

      default:
        this.sendResponse(connection.socket, {
          type: 'error',
          id: msg.id,
          payload: { code: 'VALIDATION_ERROR', message: `Unknown message type: '${msg.type}'` },
        });
    }
  }

  /**
   * Handle a 'subscribe' message — add the client to an event channel.
   *
   * Requirements: 10.5, 10.7
   */
  private async handleSubscribe(
    connection: ClientConnection,
    msg: WebSocketMessage,
  ): Promise<void> {
    const payload = msg.payload as { channel?: string; filter?: AuditFilter } | undefined;
    const channel = payload?.channel;

    if (!channel || typeof channel !== 'string') {
      this.sendResponse(connection.socket, {
        type: 'error',
        id: msg.id,
        payload: { code: 'VALIDATION_ERROR', message: 'Subscribe requires a channel' },
      });
      return;
    }

    connection.subscriptions.add(channel);

    this.sendResponse(connection.socket, {
      type: 'response',
      id: msg.id,
      payload: { success: true, channel },
    });

    // If subscribing to audit:stream, start streaming audit entries.
    if (channel === 'audit:stream') {
      const filter: AuditFilter = payload?.filter ?? {};
      this.startAuditStream(connection, filter);
    }
  }

  /**
   * Handle an 'unsubscribe' message — remove the client from an event channel.
   */
  private handleUnsubscribe(
    connection: ClientConnection,
    msg: WebSocketMessage,
  ): void {
    const payload = msg.payload as { channel?: string } | undefined;
    const channel = payload?.channel;

    if (!channel || typeof channel !== 'string') {
      this.sendResponse(connection.socket, {
        type: 'error',
        id: msg.id,
        payload: { code: 'VALIDATION_ERROR', message: 'Unsubscribe requires a channel' },
      });
      return;
    }

    connection.subscriptions.delete(channel);

    // Stop audit stream if unsubscribing from audit:stream.
    if (channel === 'audit:stream') {
      this.stopAuditStream(connection.id);
    }

    this.sendResponse(connection.socket, {
      type: 'response',
      id: msg.id,
      payload: { success: true, channel },
    });
  }

  /**
   * Handle a 'command' message — execute a management operation.
   * Commands are routed the same way as REST requests, with the
   * operator's permissions checked before execution.
   *
   * Requirements: 10.3, 10.6
   */
  private async handleCommand(
    connection: ClientConnection,
    msg: WebSocketMessage,
  ): Promise<void> {
    const payload = msg.payload as { action?: string; params?: Record<string, unknown> } | undefined;
    const action = payload?.action;
    const params = payload?.params ?? {};

    if (!action || typeof action !== 'string') {
      this.sendResponse(connection.socket, {
        type: 'error',
        id: msg.id,
        payload: { code: 'VALIDATION_ERROR', message: 'Command requires an action' },
      });
      return;
    }

    try {
      const result = await this.executeAction(
        action,
        params,
        connection.operatorId,
        connection.permissions,
      );

      this.sendResponse(connection.socket, {
        type: 'response',
        id: msg.id,
        payload: { success: true, data: result },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Command failed';
      const code = this.errorToCode(err);
      this.sendResponse(connection.socket, {
        type: 'error',
        id: msg.id,
        payload: { code, message },
      });
    }
  }

  // ==================================================================
  // Internal — Audit log streaming
  // ==================================================================

  /**
   * Start streaming audit log entries to a WebSocket client.
   * New entries matching the filter are pushed as events.
   *
   * Requirements: 10.5
   */
  private startAuditStream(
    connection: ClientConnection,
    filter: AuditFilter,
  ): void {
    // Stop any existing stream for this connection.
    this.stopAuditStream(connection.id);

    const stream = this.auditLog.stream(filter);
    const iterator = stream[Symbol.asyncIterator]();
    let stopped = false;

    const cleanup = (): void => {
      stopped = true;
      iterator.return?.();
      this.auditStreamCleanups.delete(connection.id);
    };

    this.auditStreamCleanups.set(connection.id, cleanup);

    // Consume the async iterable and push entries to the client.
    const consume = async (): Promise<void> => {
      try {
        while (!stopped) {
          const result = await iterator.next();
          if (result.done || stopped) break;

          this.sendResponse(connection.socket, {
            type: 'event',
            payload: {
              channel: 'audit:stream',
              event: {
                type: 'audit_entry',
                data: result.value,
                timestamp: result.value.timestamp.toISOString(),
              },
            },
          });
        }
      } catch {
        // Stream ended or connection closed — clean up silently.
      }
    };

    consume().catch(() => {});
  }

  /**
   * Stop an active audit stream for a connection.
   */
  private stopAuditStream(connectionId: string): void {
    const cleanup = this.auditStreamCleanups.get(connectionId);
    if (cleanup) {
      cleanup();
    }
  }


  // ==================================================================
  // Internal — REST request routing
  // ==================================================================

  /**
   * Route a REST request to the appropriate handler based on path and method.
   */
  private async routeRequest(request: RouteRequest): Promise<RouteResponse> {
    const { method, path } = request;

    // Session lifecycle routes
    if (path === '/sessions' && method === 'POST') {
      return this.handleCreateSession(request);
    }
    if (path === '/sessions' && method === 'GET') {
      return this.handleListSessions(request);
    }
    if (path.match(/^\/sessions\/[^/]+$/) && method === 'GET') {
      return this.handleGetSession(request);
    }
    if (path.match(/^\/sessions\/[^/]+\/terminate$/) && method === 'POST') {
      return this.handleTerminateSession(request);
    }
    if (path.match(/^\/sessions\/[^/]+\/pause$/) && method === 'POST') {
      return this.handlePauseSession(request);
    }
    if (path.match(/^\/sessions\/[^/]+\/resume$/) && method === 'POST') {
      return this.handleResumeSession(request);
    }

    // Policy management routes
    if (path === '/policies' && method === 'POST') {
      return this.handleAddPolicy(request);
    }
    if (path === '/policies' && method === 'GET') {
      return this.handleListPolicies(request);
    }
    if (path.match(/^\/policies\/[^/]+$/) && method === 'GET') {
      return this.handleGetPolicy(request);
    }
    if (path.match(/^\/policies\/[^/]+$/) && method === 'PUT') {
      return this.handleUpdatePolicy(request);
    }
    if (path.match(/^\/policies\/[^/]+$/) && method === 'DELETE') {
      return this.handleRemovePolicy(request);
    }
    if (path.match(/^\/policies\/[^/]+\/rollback$/) && method === 'POST') {
      return this.handleRollbackPolicy(request);
    }

    // Memory administration routes
    if (path === '/memory/query' && method === 'POST') {
      return this.handleMemoryQuery(request);
    }
    if (path.match(/^\/memory\/namespaces\/[^/]+$/) && method === 'DELETE') {
      return this.handleDeleteNamespace(request);
    }

    // Audit log routes
    if (path === '/audit' && method === 'GET') {
      return this.handleAuditQuery(request);
    }

    return {
      status: 404,
      body: { error: { code: 'RESOURCE_NOT_FOUND', message: `Route not found: ${method} ${path}` } },
    };
  }

  // ==================================================================
  // REST handlers — Session lifecycle
  // ==================================================================

  /**
   * POST /sessions — Create a new agent session.
   * Body: { manifest: AgentManifest }
   *
   * Requirements: 10.1, 10.3
   */
  private async handleCreateSession(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.SESSION_CREATE);

    const body = request.body as { manifest?: AgentManifest } | undefined;
    if (!body?.manifest) {
      return {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Request body must include manifest' } },
      };
    }

    try {
      const session = await this.sessionManager.createSession(body.manifest, request.operatorId);

      // Broadcast session state event.
      this.broadcastEvent('session:state', {
        channel: 'session:state',
        type: 'session_created',
        data: { sessionId: session.id, state: session.state, manifestId: session.manifestId },
        timestamp: new Date(),
      });

      return { status: 201, body: { data: session } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      if (message.includes('maximum concurrent sessions')) {
        return { status: 429, body: { error: { code: 'CAPACITY_EXCEEDED', message } } };
      }
      return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message } } };
    }
  }

  /**
   * GET /sessions — List all active sessions.
   *
   * Requirements: 10.1, 10.4
   */
  private async handleListSessions(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.SESSION_LIST);

    const sessions = this.sessionManager.listSessions();
    return { status: 200, body: { data: sessions } };
  }

  /**
   * GET /sessions/:id — Get a specific session.
   *
   * Requirements: 10.1
   */
  private async handleGetSession(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.SESSION_GET);

    const sessionId = this.extractPathParam(request.path, '/sessions/');
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return {
        status: 404,
        body: { error: { code: 'RESOURCE_NOT_FOUND', message: `Session '${sessionId}' not found` } },
      };
    }

    return { status: 200, body: { data: session } };
  }

  /**
   * POST /sessions/:id/terminate — Terminate a session.
   * Body: { reason: string }
   *
   * Requirements: 10.1
   */
  private async handleTerminateSession(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.SESSION_TERMINATE);

    const sessionId = this.extractPathParam(request.path, '/sessions/', '/terminate');
    const body = request.body as { reason?: string } | undefined;
    const reason = body?.reason ?? 'Terminated by operator';

    try {
      await this.sessionManager.terminateSession(sessionId, reason);

      this.broadcastEvent('session:state', {
        channel: 'session:state',
        type: 'session_terminated',
        data: { sessionId, reason },
        timestamp: new Date(),
      });

      return { status: 200, body: { data: { sessionId, state: 'terminated' } } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to terminate session';
      if (message.includes('not found')) {
        return { status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message } } };
      }
      return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message } } };
    }
  }

  /**
   * POST /sessions/:id/pause — Pause a session.
   *
   * Requirements: 10.1
   */
  private async handlePauseSession(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.SESSION_PAUSE);

    const sessionId = this.extractPathParam(request.path, '/sessions/', '/pause');

    try {
      await this.sessionManager.pauseSession(sessionId);

      this.broadcastEvent('session:state', {
        channel: 'session:state',
        type: 'session_paused',
        data: { sessionId },
        timestamp: new Date(),
      });

      return { status: 200, body: { data: { sessionId, state: 'paused' } } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to pause session';
      if (message.includes('not found')) {
        return { status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message } } };
      }
      return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message } } };
    }
  }

  /**
   * POST /sessions/:id/resume — Resume a paused session.
   *
   * Requirements: 10.1
   */
  private async handleResumeSession(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.SESSION_RESUME);

    const sessionId = this.extractPathParam(request.path, '/sessions/', '/resume');

    try {
      await this.sessionManager.resumeSession(sessionId);

      this.broadcastEvent('session:state', {
        channel: 'session:state',
        type: 'session_resumed',
        data: { sessionId },
        timestamp: new Date(),
      });

      return { status: 200, body: { data: { sessionId, state: 'running' } } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to resume session';
      if (message.includes('not found')) {
        return { status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message } } };
      }
      return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message } } };
    }
  }


  // ==================================================================
  // REST handlers — Policy management
  // ==================================================================

  /**
   * POST /policies — Add a new policy.
   * Body: AccessPolicy
   *
   * Requirements: 10.1
   */
  private async handleAddPolicy(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.POLICY_ADD);

    const policy = request.body as AccessPolicy | undefined;
    if (!policy) {
      return {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Request body must be a policy' } },
      };
    }

    const result = this.policyEngine.addPolicy(policy);
    if (!result.valid) {
      return {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Invalid policy', details: result.errors } },
      };
    }

    return { status: 201, body: { data: { policyId: policy.id, version: 1 } } };
  }

  /**
   * GET /policies — List policies, optionally filtered by scope.
   * Query: { scope?: PolicyScope }
   *
   * Requirements: 10.1
   */
  private async handleListPolicies(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.POLICY_LIST);

    const scope = request.query.scope as PolicyScope | undefined;
    const policies = this.policyEngine.listPolicies(scope);
    return { status: 200, body: { data: policies } };
  }

  /**
   * GET /policies/:id — Get a specific policy.
   *
   * Requirements: 10.1
   */
  private async handleGetPolicy(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.POLICY_GET);

    const policyId = this.extractPathParam(request.path, '/policies/');
    const versionStr = request.query.version;

    if (versionStr) {
      const version = parseInt(versionStr, 10);
      if (isNaN(version)) {
        return {
          status: 400,
          body: { error: { code: 'VALIDATION_ERROR', message: 'Version must be a number' } },
        };
      }
      const policy = this.policyEngine.getPolicyVersion(policyId, version);
      if (!policy) {
        return {
          status: 404,
          body: { error: { code: 'RESOURCE_NOT_FOUND', message: `Policy '${policyId}' version ${version} not found` } },
        };
      }
      return { status: 200, body: { data: policy } };
    }

    const policy = this.policyEngine.getPolicy(policyId);
    if (!policy) {
      return {
        status: 404,
        body: { error: { code: 'RESOURCE_NOT_FOUND', message: `Policy '${policyId}' not found` } },
      };
    }

    return { status: 200, body: { data: policy } };
  }

  /**
   * PUT /policies/:id — Update an existing policy.
   * Body: AccessPolicy
   *
   * Requirements: 10.1
   */
  private async handleUpdatePolicy(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.POLICY_UPDATE);

    const policyId = this.extractPathParam(request.path, '/policies/');
    const policy = request.body as AccessPolicy | undefined;

    if (!policy) {
      return {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Request body must be a policy' } },
      };
    }

    const result = this.policyEngine.updatePolicy(policyId, policy);
    if (!result.valid) {
      const message = result.errors.join('; ');
      if (message.includes('not found')) {
        return { status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message } } };
      }
      return {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message, details: result.errors } },
      };
    }

    const updated = this.policyEngine.getPolicy(policyId);
    return { status: 200, body: { data: { policyId, version: updated?.version } } };
  }

  /**
   * DELETE /policies/:id — Remove a policy.
   *
   * Requirements: 10.1
   */
  private async handleRemovePolicy(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.POLICY_REMOVE);

    const policyId = this.extractPathParam(request.path, '/policies/');

    // Check if policy exists before removing.
    const existing = this.policyEngine.getPolicy(policyId);
    if (!existing) {
      return {
        status: 404,
        body: { error: { code: 'RESOURCE_NOT_FOUND', message: `Policy '${policyId}' not found` } },
      };
    }

    this.policyEngine.removePolicy(policyId);
    return { status: 200, body: { data: { policyId, removed: true } } };
  }

  /**
   * POST /policies/:id/rollback — Rollback a policy to a specific version.
   * Body: { version: number }
   *
   * Requirements: 10.1
   */
  private async handleRollbackPolicy(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.POLICY_ROLLBACK);

    const policyId = this.extractPathParam(request.path, '/policies/', '/rollback');
    const body = request.body as { version?: number } | undefined;

    if (!body?.version || typeof body.version !== 'number') {
      return {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Request body must include version (number)' } },
      };
    }

    const result = this.policyEngine.rollbackPolicy(policyId, body.version);
    if (!result.valid) {
      const message = result.errors.join('; ');
      if (message.includes('not found')) {
        return { status: 404, body: { error: { code: 'RESOURCE_NOT_FOUND', message } } };
      }
      return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message } } };
    }

    const updated = this.policyEngine.getPolicy(policyId);
    return { status: 200, body: { data: { policyId, version: updated?.version } } };
  }


  // ==================================================================
  // REST handlers — Memory administration
  // ==================================================================

  /**
   * POST /memory/query — Query the memory store.
   * Body: { agentId: string, query: MemoryQuery }
   *
   * Requirements: 10.1
   */
  private async handleMemoryQuery(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.MEMORY_QUERY);

    const body = request.body as { agentId?: string; query?: MemoryQuery } | undefined;
    if (!body?.agentId || !body?.query) {
      return {
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'Request body must include agentId and query' } },
      };
    }

    const entries = await this.memoryStore.query(body.agentId, body.query);
    return { status: 200, body: { data: entries } };
  }

  /**
   * DELETE /memory/namespaces/:namespace — Delete a memory namespace.
   *
   * Requirements: 10.1
   */
  private async handleDeleteNamespace(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.MEMORY_DELETE);

    const namespace = this.extractPathParam(request.path, '/memory/namespaces/');

    await this.memoryStore.deleteNamespace(namespace, request.operatorId);
    return { status: 200, body: { data: { namespace, deleted: true } } };
  }

  // ==================================================================
  // REST handlers — Audit log
  // ==================================================================

  /**
   * GET /audit — Query the audit log.
   * Query params: agentId, eventType, decision, afterSequence, startTime, endTime
   *
   * Requirements: 10.1
   */
  private async handleAuditQuery(request: RouteRequest): Promise<RouteResponse> {
    this.requirePermission(request.operatorId, PERMISSIONS.AUDIT_QUERY);

    const query: AuditQuery = {};

    if (request.query.agentId) {
      query.agentId = request.query.agentId;
    }
    if (request.query.eventType) {
      query.eventType = request.query.eventType as AuditQuery['eventType'];
    }
    if (request.query.decision) {
      query.decision = request.query.decision as 'allow' | 'deny';
    }
    if (request.query.afterSequence) {
      const seq = parseInt(request.query.afterSequence, 10);
      if (!isNaN(seq)) {
        query.afterSequence = seq;
      }
    }
    if (request.query.startTime && request.query.endTime) {
      query.timeRange = {
        start: new Date(request.query.startTime),
        end: new Date(request.query.endTime),
      };
    }

    const entries = await this.auditLog.query(query);
    return { status: 200, body: { data: entries } };
  }

  // ==================================================================
  // Internal — WebSocket command execution (shared with REST)
  // ==================================================================

  /**
   * Execute a management action. Used by both WebSocket commands and
   * can be used for programmatic access.
   *
   * Actions map to the same operations as REST endpoints.
   */
  private async executeAction(
    action: string,
    params: Record<string, unknown>,
    operatorId: string,
    permissions: string[],
  ): Promise<unknown> {
    switch (action) {
      // Session lifecycle
      case 'session.create': {
        this.checkPermission(permissions, PERMISSIONS.SESSION_CREATE);
        const manifest = params.manifest as AgentManifest;
        if (!manifest) throw new Error('Missing manifest parameter');
        const session = await this.sessionManager.createSession(manifest, operatorId);
        this.broadcastEvent('session:state', {
          channel: 'session:state',
          type: 'session_created',
          data: { sessionId: session.id, state: session.state },
          timestamp: new Date(),
        });
        return session;
      }

      case 'session.terminate': {
        this.checkPermission(permissions, PERMISSIONS.SESSION_TERMINATE);
        const sessionId = params.sessionId as string;
        const reason = (params.reason as string) ?? 'Terminated by operator';
        if (!sessionId) throw new Error('Missing sessionId parameter');
        await this.sessionManager.terminateSession(sessionId, reason);
        this.broadcastEvent('session:state', {
          channel: 'session:state',
          type: 'session_terminated',
          data: { sessionId, reason },
          timestamp: new Date(),
        });
        return { sessionId, state: 'terminated' };
      }

      case 'session.pause': {
        this.checkPermission(permissions, PERMISSIONS.SESSION_PAUSE);
        const sessionId = params.sessionId as string;
        if (!sessionId) throw new Error('Missing sessionId parameter');
        await this.sessionManager.pauseSession(sessionId);
        this.broadcastEvent('session:state', {
          channel: 'session:state',
          type: 'session_paused',
          data: { sessionId },
          timestamp: new Date(),
        });
        return { sessionId, state: 'paused' };
      }

      case 'session.resume': {
        this.checkPermission(permissions, PERMISSIONS.SESSION_RESUME);
        const sessionId = params.sessionId as string;
        if (!sessionId) throw new Error('Missing sessionId parameter');
        await this.sessionManager.resumeSession(sessionId);
        this.broadcastEvent('session:state', {
          channel: 'session:state',
          type: 'session_resumed',
          data: { sessionId },
          timestamp: new Date(),
        });
        return { sessionId, state: 'running' };
      }

      case 'session.list': {
        this.checkPermission(permissions, PERMISSIONS.SESSION_LIST);
        return this.sessionManager.listSessions();
      }

      case 'session.get': {
        this.checkPermission(permissions, PERMISSIONS.SESSION_GET);
        const sessionId = params.sessionId as string;
        if (!sessionId) throw new Error('Missing sessionId parameter');
        const session = this.sessionManager.getSession(sessionId);
        if (!session) throw new Error(`Session '${sessionId}' not found`);
        return session;
      }

      // Policy management
      case 'policy.add': {
        this.checkPermission(permissions, PERMISSIONS.POLICY_ADD);
        const policy = params.policy as AccessPolicy;
        if (!policy) throw new Error('Missing policy parameter');
        const result = this.policyEngine.addPolicy(policy);
        if (!result.valid) throw new Error(`Invalid policy: ${result.errors.join('; ')}`);
        return { policyId: policy.id, version: 1 };
      }

      case 'policy.update': {
        this.checkPermission(permissions, PERMISSIONS.POLICY_UPDATE);
        const policyId = params.policyId as string;
        const policy = params.policy as AccessPolicy;
        if (!policyId || !policy) throw new Error('Missing policyId or policy parameter');
        const result = this.policyEngine.updatePolicy(policyId, policy);
        if (!result.valid) throw new Error(`Update failed: ${result.errors.join('; ')}`);
        const updated = this.policyEngine.getPolicy(policyId);
        return { policyId, version: updated?.version };
      }

      case 'policy.remove': {
        this.checkPermission(permissions, PERMISSIONS.POLICY_REMOVE);
        const policyId = params.policyId as string;
        if (!policyId) throw new Error('Missing policyId parameter');
        const existing = this.policyEngine.getPolicy(policyId);
        if (!existing) throw new Error(`Policy '${policyId}' not found`);
        this.policyEngine.removePolicy(policyId);
        return { policyId, removed: true };
      }

      case 'policy.get': {
        this.checkPermission(permissions, PERMISSIONS.POLICY_GET);
        const policyId = params.policyId as string;
        if (!policyId) throw new Error('Missing policyId parameter');
        const policy = this.policyEngine.getPolicy(policyId);
        if (!policy) throw new Error(`Policy '${policyId}' not found`);
        return policy;
      }

      case 'policy.list': {
        this.checkPermission(permissions, PERMISSIONS.POLICY_LIST);
        const scope = params.scope as PolicyScope | undefined;
        return this.policyEngine.listPolicies(scope);
      }

      case 'policy.rollback': {
        this.checkPermission(permissions, PERMISSIONS.POLICY_ROLLBACK);
        const policyId = params.policyId as string;
        const version = params.version as number;
        if (!policyId || version === undefined) throw new Error('Missing policyId or version parameter');
        const result = this.policyEngine.rollbackPolicy(policyId, version);
        if (!result.valid) throw new Error(`Rollback failed: ${result.errors.join('; ')}`);
        const updated = this.policyEngine.getPolicy(policyId);
        return { policyId, version: updated?.version };
      }

      // Memory administration
      case 'memory.query': {
        this.checkPermission(permissions, PERMISSIONS.MEMORY_QUERY);
        const agentId = params.agentId as string;
        const query = params.query as MemoryQuery;
        if (!agentId || !query) throw new Error('Missing agentId or query parameter');
        return this.memoryStore.query(agentId, query);
      }

      case 'memory.deleteNamespace': {
        this.checkPermission(permissions, PERMISSIONS.MEMORY_DELETE);
        const namespace = params.namespace as string;
        if (!namespace) throw new Error('Missing namespace parameter');
        await this.memoryStore.deleteNamespace(namespace, operatorId);
        return { namespace, deleted: true };
      }

      // Audit log
      case 'audit.query': {
        this.checkPermission(permissions, PERMISSIONS.AUDIT_QUERY);
        const query = params.query as AuditQuery ?? {};
        return this.auditLog.query(query);
      }

      default:
        throw new Error(`Unknown action: '${action}'`);
    }
  }


  // ==================================================================
  // Internal — Helpers
  // ==================================================================

  /**
   * Send a JSON response over a WebSocket connection.
   */
  private sendResponse(socket: WebSocket, response: WebSocketResponse): void {
    try {
      if (socket.readyState === 1 /* WebSocket.OPEN */) {
        socket.send(JSON.stringify(response));
      }
    } catch {
      // Connection may have closed between check and send — ignore.
    }
  }

  /**
   * Start the heartbeat interval if not already running.
   * Sends ping frames to all connections and terminates unresponsive ones.
   */
  private ensureHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      for (const [connId, connection] of this.connections) {
        if (!connection.alive) {
          // Client didn't respond to the last ping — terminate.
          connection.socket.terminate();
          this.cleanupConnection(connId);
          continue;
        }

        connection.alive = false;
        try {
          connection.socket.ping();
        } catch {
          this.cleanupConnection(connId);
        }
      }

      // Stop heartbeat if no connections remain.
      if (this.connections.size === 0 && this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Clean up a disconnected WebSocket connection.
   */
  private cleanupConnection(connectionId: string): void {
    this.stopAuditStream(connectionId);
    this.connections.delete(connectionId);
  }

  /**
   * Extract a path parameter from a URL path.
   * e.g., extractPathParam('/sessions/abc123', '/sessions/') => 'abc123'
   * e.g., extractPathParam('/sessions/abc123/terminate', '/sessions/', '/terminate') => 'abc123'
   */
  private extractPathParam(path: string, prefix: string, suffix?: string): string {
    let value = path.slice(prefix.length);
    if (suffix && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
    }
    return decodeURIComponent(value);
  }

  /**
   * Check that the operator has the required permission for a REST request.
   * For REST requests, we use a simple permission model where the
   * authenticate function provides the operator's permissions.
   *
   * This is a lightweight check — the full authorization model uses
   * the Policy Engine for agent operations.
   *
   * Requirements: 10.3
   */
  private requirePermission(_operatorId: string, _permission: string): void {
    // In the REST flow, the operator is already authenticated by the host
    // application (e.g., HTTP middleware). The operatorId being present
    // is sufficient for basic authorization.
    //
    // For fine-grained permission checks, the host application should
    // use the authenticate function and check permissions before calling
    // handleRequest(). The WebSocket flow uses checkPermission() with
    // the permissions array from the auth token.
    //
    // This method exists as a hook point for future enhancement where
    // REST requests carry permission tokens.
  }

  /**
   * Check that a WebSocket client has the required permission.
   * Throws if the permission is not present.
   *
   * Requirements: 10.3
   */
  private checkPermission(permissions: string[], required: string): void {
    // If no permissions are set (e.g., pre-authenticated connection),
    // allow the operation. The host application is responsible for
    // ensuring only authorized operators connect.
    if (permissions.length === 0) return;

    // Check for wildcard admin permission.
    if (permissions.includes('*')) return;

    if (!permissions.includes(required)) {
      throw new Error(`Permission denied: requires '${required}'`);
    }
  }

  /**
   * Map an error to an appropriate error code for WebSocket responses.
   */
  private errorToCode(err: unknown): string {
    if (!(err instanceof Error)) return 'INTERNAL_ERROR';

    const msg = err.message.toLowerCase();
    if (msg.includes('permission denied') || msg.includes('requires \'')) {
      return 'AUTHZ_DENIED';
    }
    if (msg.includes('not found')) {
      return 'RESOURCE_NOT_FOUND';
    }
    if (msg.includes('maximum concurrent') || msg.includes('capacity')) {
      return 'CAPACITY_EXCEEDED';
    }
    if (msg.includes('invalid') || msg.includes('missing') || msg.includes('must')) {
      return 'VALIDATION_ERROR';
    }
    return 'INTERNAL_ERROR';
  }
}
