import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http';
import { URL } from 'url';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';

import { AuditLog } from './subsystems/audit-log.js';
import { PolicyEngine } from './subsystems/policy-engine.js';
import { ManifestValidator } from './subsystems/manifest-validator.js';
import { SessionManager } from './subsystems/session-manager.js';
import { MemoryStore } from './subsystems/memory-store.js';
import { AntiLeakage } from './subsystems/anti-leakage.js';
import { CommunicationBus } from './subsystems/communication-bus.js';
import { MCPGateway } from './subsystems/mcp-gateway.js';
import { AgentDiscoveryRegistry } from './subsystems/agent-discovery-registry.js';
import { ACPAdapter } from './subsystems/acp-adapter.js';
import { AgentCPBridge } from './subsystems/agentcp-bridge.js';
import {
  OperatorInterface,
  type AuthenticateFn,
  type OperatorCredentials,
  type RouteRequest,
} from './subsystems/operator-interface.js';
import { AgentConnector } from './subsystems/agent-connector.js';
import { TaskOrchestrator } from './subsystems/task-orchestrator.js';
import type { ACPAgentCard, ACPTaskSubmission } from './interfaces/acp-adapter.js';
import type { AgentConnectionConfig } from './interfaces/agent-connector.js';
import type {
  CodingTaskSubmission,
  CodingTaskStatus,
  TaskStepDefinition,
  ArtifactQuery,
  ExternalEventPayload,
} from './interfaces/task-orchestrator.js';

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

/** Configuration options for the Command Center. */
export interface CommandCenterConfig {
  /** Port for the WebSocket server. Defaults to 8080. */
  port?: number;
  /** Maximum number of concurrent agent sessions. */
  maxConcurrentSessions?: number;
  /** Maximum message size in bytes for the Communication Bus. */
  maxMessageSize?: number;
  /** Heartbeat interval in milliseconds for WebSocket keepalive. */
  heartbeatIntervalMs?: number;
  /**
   * Authentication function for operator connections.
   * Returns operator credentials if the token is valid, or undefined if not.
   * Defaults to rejecting all tokens.
   */
  authenticate?: AuthenticateFn;
  /**
   * Allowed CORS origins for the HTTP API.
   *
   * - `'*'` allows any origin (convenient for local development).
   * - A string like `'http://localhost:5173'` allows a single origin.
   * - An array of strings allows multiple specific origins.
   * - `undefined` (default) disables CORS headers entirely.
   */
  corsOrigins?: string | string[];
}

// ------------------------------------------------------------------
// Default authenticate function
// ------------------------------------------------------------------

const DEFAULT_AUTHENTICATE: AuthenticateFn = (): OperatorCredentials | undefined => undefined;

// ------------------------------------------------------------------
// CommandCenter
// ------------------------------------------------------------------

/**
 * Command Center orchestrator — the main entry point for the C2 AI
 * Command Center system.
 *
 * Instantiates all subsystems in dependency order, wires their
 * dependencies, and manages the lifecycle of the WebSocket server.
 *
 * Usage:
 * ```ts
 * const cc = new CommandCenter({ port: 9000, authenticate: myAuthFn });
 * await cc.start();
 * // ... system is running ...
 * await cc.stop();
 * ```
 */
export class CommandCenter {
  // ------------------------------------------------------------------
  // Subsystem instances (public getters below)
  // ------------------------------------------------------------------

  private readonly _auditLog: AuditLog;
  private readonly _policyEngine: PolicyEngine;
  private readonly _manifestValidator: ManifestValidator;
  private readonly _sessionManager: SessionManager;
  private readonly _memoryStore: MemoryStore;
  private readonly _antiLeakage: AntiLeakage;
  private readonly _communicationBus: CommunicationBus;
  private readonly _mcpGateway: MCPGateway;
  private readonly _agentDiscoveryRegistry: AgentDiscoveryRegistry;
  private readonly _acpAdapter: ACPAdapter;
  private readonly _agentCPBridge: AgentCPBridge;
  private readonly _operatorInterface: OperatorInterface;
  private readonly _agentConnector: AgentConnector;
  private readonly _taskOrchestrator: TaskOrchestrator;

  // ------------------------------------------------------------------
  // Server state
  // ------------------------------------------------------------------

  private readonly port: number;
  private readonly authenticate: AuthenticateFn;
  private readonly corsOrigins: string | string[] | undefined;
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private running = false;

  // ------------------------------------------------------------------
  // Constructor — instantiate and wire all subsystems
  // ------------------------------------------------------------------

  constructor(config: CommandCenterConfig = {}) {
    this.port = config.port ?? 8080;
    const authenticate = config.authenticate ?? DEFAULT_AUTHENTICATE;
    this.authenticate = authenticate;
    this.corsOrigins = config.corsOrigins;

    // 1. Foundation subsystems (no dependencies)
    this._auditLog = new AuditLog();
    this._policyEngine = new PolicyEngine();
    this._manifestValidator = new ManifestValidator();
    this._agentDiscoveryRegistry = new AgentDiscoveryRegistry();

    // 2. Subsystems that depend only on foundation subsystems
    this._sessionManager = new SessionManager({
      auditLog: this._auditLog,
      policyEngine: this._policyEngine,
      maxConcurrentSessions: config.maxConcurrentSessions,
    });

    this._memoryStore = new MemoryStore({
      policyEngine: this._policyEngine,
      auditLog: this._auditLog,
    });

    this._antiLeakage = new AntiLeakage({
      policyEngine: this._policyEngine,
    });

    // 3. Subsystems that depend on layer-2 subsystems
    this._communicationBus = new CommunicationBus({
      policyEngine: this._policyEngine,
      antiLeakage: this._antiLeakage,
      auditLog: this._auditLog,
      sessionManager: this._sessionManager,
      maxMessageSize: config.maxMessageSize,
    });

    this._mcpGateway = new MCPGateway({
      policyEngine: this._policyEngine,
      auditLog: this._auditLog,
      antiLeakage: this._antiLeakage,
    });

    // 4. Protocol adapters (depend on multiple subsystems)
    this._acpAdapter = new ACPAdapter({
      discoveryRegistry: this._agentDiscoveryRegistry,
      communicationBus: this._communicationBus,
      policyEngine: this._policyEngine,
      auditLog: this._auditLog,
    });

    this._agentCPBridge = new AgentCPBridge({
      sessionManager: this._sessionManager,
      policyEngine: this._policyEngine,
      mcpGateway: this._mcpGateway,
      auditLog: this._auditLog,
    });

    // 5. Operator Interface (depends on most subsystems)
    this._operatorInterface = new OperatorInterface({
      sessionManager: this._sessionManager,
      policyEngine: this._policyEngine,
      memoryStore: this._memoryStore,
      auditLog: this._auditLog,
      authenticate,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    });

    // 6. Agent Connector (protocol-agnostic adapter layer)
    this._agentConnector = new AgentConnector({
      sessionManager: this._sessionManager,
      discoveryRegistry: this._agentDiscoveryRegistry,
      policyEngine: this._policyEngine,
      agentcpBridge: this._agentCPBridge,
      communicationBus: this._communicationBus,
      acpAdapter: this._acpAdapter,
      antiLeakage: this._antiLeakage,
      auditLog: this._auditLog,
    });

    // 7. Task Orchestrator (depends on Agent Connector and most subsystems)
    this._taskOrchestrator = new TaskOrchestrator({
      agentConnector: this._agentConnector,
      memoryStore: this._memoryStore,
      policyEngine: this._policyEngine,
      mcpGateway: this._mcpGateway,
      auditLog: this._auditLog,
      operatorInterface: this._operatorInterface,
      discoveryRegistry: this._agentDiscoveryRegistry,
      sessionManager: this._sessionManager,
    });
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Start the Command Center.
   *
   * Creates an HTTP server that handles REST requests via the Operator
   * Interface, and a WebSocket server that shares the same port for
   * real-time connections.
   *
   * Resolves once the server is listening.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    return new Promise<void>((resolve) => {
      // Create the HTTP server that handles REST requests.
      this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleHttpRequest(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }));
          }
        });
      });

      // Create the WebSocket server attached to the HTTP server.
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (socket: WebSocket, _request: IncomingMessage) => {
        this._operatorInterface.handleConnectionWithAuth(socket);
      });

      this.httpServer.listen(this.port, () => {
        this.running = true;
        resolve();
      });
    });
  }

  /**
   * Gracefully stop the Command Center.
   *
   * 1. Shuts down the Operator Interface (closes WebSocket connections,
   *    stops heartbeat timer).
   * 2. Terminates all active agent sessions.
   * 3. Closes the WebSocket server and HTTP server.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    // 1. Shut down the Operator Interface (closes WS connections, heartbeat).
    this._operatorInterface.shutdown();

    // 2. Cancel all active coding tasks.
    const activeTasks = this._taskOrchestrator.listTasks({ status: 'in_progress' as CodingTaskStatus });
    const pendingTasks = this._taskOrchestrator.listTasks({ status: 'pending' as CodingTaskStatus });
    const cancelPromises = [...activeTasks, ...pendingTasks].map((task) =>
      this._taskOrchestrator.cancelTask(task.id, 'Command Center shutting down', task.operatorId).catch(() => {
        // Best-effort — task may already be in a terminal state.
      }),
    );
    await Promise.all(cancelPromises);

    // 3. Disconnect all connected agents.
    const connectedAgents = this._agentConnector.listAgents();
    const disconnectPromises = connectedAgents.map((agent) =>
      this._agentConnector.disconnect(agent.agentId, 'Command Center shutting down').catch(() => {
        // Best-effort — agent may already be disconnected.
      }),
    );
    await Promise.all(disconnectPromises);

    // 4. Terminate all active agent sessions.
    const sessions = this._sessionManager.listSessions();
    const terminationPromises = sessions
      .filter((s) => s.state === 'running' || s.state === 'paused')
      .map((s) => this._sessionManager.terminateSession(s.id, 'Command Center shutting down'));
    await Promise.all(terminationPromises);

    // 5. Close the WebSocket server.
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => {
          resolve();
        });
      });
      this.wss = null;
    }

    // 6. Close the HTTP server.
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          resolve();
        });
      });
      this.httpServer = null;
    }

    this.running = false;
  }

  // ------------------------------------------------------------------
  // Internal — HTTP request handling
  // ------------------------------------------------------------------

  /**
   * Handle an incoming HTTP request by parsing it into a RouteRequest
   * and passing it to the Operator Interface's handleRequest() method.
   *
   * Extracts the Bearer token from the Authorization header and
   * authenticates the operator before routing.
   *
   * ACP routes (/agents, /tasks) are handled before operator interface
   * routes to avoid path conflicts.
   */
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse the URL.
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    const parsedUrl = new URL(req.url ?? '/', baseUrl);

    // ---- CORS ----
    if (this.corsOrigins !== undefined) {
      const requestOrigin = req.headers.origin ?? '';
      let allowedOrigin: string | undefined;

      if (this.corsOrigins === '*') {
        allowedOrigin = '*';
      } else if (typeof this.corsOrigins === 'string') {
        if (requestOrigin === this.corsOrigins) {
          allowedOrigin = requestOrigin;
        }
      } else if (Array.isArray(this.corsOrigins)) {
        if (this.corsOrigins.includes(requestOrigin)) {
          allowedOrigin = requestOrigin;
        }
      }

      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '86400');
        if (allowedOrigin !== '*') {
          res.setHeader('Vary', 'Origin');
        }
      }

      // Handle preflight requests.
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // Parse query parameters.
    const query: Record<string, string> = {};
    for (const [key, value] of parsedUrl.searchParams.entries()) {
      query[key] = value;
    }

    // Read the request body for POST/PUT/PATCH/DELETE methods.
    let body: unknown = undefined;
    if (req.method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      body = await this.readRequestBody(req);
    }

    const method = req.method ?? 'GET';
    const path = parsedUrl.pathname;

    // Handle the login endpoint before the auth check — this is the
    // only unauthenticated route.  The client sends { token } and we
    // validate it through the same authenticate callback used for
    // Bearer tokens on every other request.
    if (path === '/api/auth/login' && method === 'POST') {
      const tokenValue =
        body && typeof body === 'object' && 'token' in body
          ? (body as Record<string, unknown>).token
          : undefined;

      if (typeof tokenValue !== 'string' || !tokenValue) {
        this.sendJsonResponse(res, 400, {
          error: { code: 'BAD_REQUEST', message: 'Request body must include a "token" string' },
        });
        return;
      }

      const creds = this.authenticate(tokenValue);
      if (!creds) {
        this.sendJsonResponse(res, 401, {
          error: { code: 'AUTHENTICATION_FAILURE', message: 'Invalid token' },
        });
        return;
      }

      // Return the validated token and operator identity.  The
      // expiresAt field is set to 24 hours from now — callers can
      // treat this as a session lifetime.
      this.sendJsonResponse(res, 200, {
        token: tokenValue,
        operatorId: creds.operatorId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      return;
    }

    // Extract and validate the Bearer token from the Authorization header.
    let operatorId = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const creds = this.authenticate(token);
      if (creds) {
        operatorId = creds.operatorId;
      }
    }

    // If no valid operator, return 401.
    if (!operatorId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { code: 'AUTHENTICATION_FAILURE', message: 'Operator not authenticated' },
      }));
      return;
    }

    // Check if this is an ACP route (handle BEFORE operator interface routes).
    if (path.startsWith('/agents') || (path.startsWith('/tasks') && !path.startsWith('/tasks/coding'))) {
      await this.handleAcpRequest(method, path, body, operatorId, req, res);
      return;
    }

    // Check if this is a coding task management route.
    if (path.startsWith('/tasks/coding') || path.startsWith('/coding-tasks') || path.startsWith('/agent-connections')
      || path.startsWith('/api/tasks') || path.startsWith('/api/coding-tasks') || path.startsWith('/api/agent-connections')) {
      await this.handleTaskManagementRequest(method, path, body, operatorId, res);
      return;
    }

    // Build the RouteRequest for the Operator Interface.
    const routeRequest: RouteRequest = {
      method,
      path,
      params: {},
      query,
      body,
      operatorId,
    };

    // Pass to the Operator Interface.
    const routeResponse = await this._operatorInterface.handleRequest(routeRequest);

    // Send the response.
    res.writeHead(routeResponse.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(routeResponse.body));
  }

  // ------------------------------------------------------------------
  // Internal — ACP request handling
  // ------------------------------------------------------------------

  /**
   * Handle ACP REST endpoints for external agent communication.
   *
   * Routes:
   *  - POST   /agents           — Register an Agent Card
   *  - DELETE  /agents/:url      — Deregister an agent (URL-encoded)
   *  - POST   /tasks            — Submit a task
   *  - GET    /tasks/:id        — Get task status
   *  - POST   /tasks/:id/cancel — Cancel a task
   *  - GET    /tasks/:id/stream — Stream task updates via SSE
   *
   * All ACP endpoints route through the Policy Engine internally
   * (the ACP Adapter handles this).
   *
   * Requirements: 11.4, 11.5, 11.8
   */
  private async handleAcpRequest(
    method: string,
    path: string,
    body: unknown,
    operatorId: string,
    _req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      // --- Agent routes ---

      // POST /agents — Register an Agent Card
      if (path === '/agents' && method === 'POST') {
        const card = body as ACPAgentCard;
        const result = await this._acpAdapter.registerAgent(card);
        this.sendJsonResponse(res, 200, { data: result });
        return;
      }

      // DELETE /agents/:url — Deregister an agent
      if (path.match(/^\/agents\/[^/]+/) && method === 'DELETE') {
        const encodedUrl = path.slice('/agents/'.length);
        const agentUrl = decodeURIComponent(encodedUrl);
        this._acpAdapter.unregisterAgent(agentUrl);
        this.sendJsonResponse(res, 200, { data: { url: agentUrl, removed: true } });
        return;
      }

      // --- Task routes ---

      // POST /tasks/:id/cancel — Cancel a task (check before POST /tasks)
      if (path.match(/^\/tasks\/[^/]+\/cancel$/) && method === 'POST') {
        const taskId = this.extractAcpPathParam(path, '/tasks/', '/cancel');
        const cancelBody = body as { reason?: string } | undefined;
        const reason = cancelBody?.reason ?? 'Canceled by operator';
        await this._acpAdapter.cancelTask(taskId, reason);
        this.sendJsonResponse(res, 200, { data: { taskId, status: 'canceled' } });
        return;
      }

      // POST /tasks — Submit a task
      if (path === '/tasks' && method === 'POST') {
        const taskBody = body as { targetAgentUrl?: string; task?: ACPTaskSubmission } | undefined;
        if (!taskBody?.targetAgentUrl || !taskBody?.task) {
          this.sendJsonResponse(res, 400, {
            error: { code: 'VALIDATION_ERROR', message: 'Request body must include targetAgentUrl and task' },
          });
          return;
        }
        const task = await this._acpAdapter.submitTask(operatorId, taskBody.targetAgentUrl, taskBody.task);
        this.sendJsonResponse(res, 201, { data: task });
        return;
      }

      // GET /tasks/:id/stream — Stream task updates via SSE
      if (path.match(/^\/tasks\/[^/]+\/stream$/) && method === 'GET') {
        const taskId = this.extractAcpPathParam(path, '/tasks/', '/stream');
        await this.handleAcpSseStream(taskId, res);
        return;
      }

      // GET /tasks/:id — Get task status
      if (path.match(/^\/tasks\/[^/]+$/) && method === 'GET') {
        const taskId = path.slice('/tasks/'.length);
        const task = this._acpAdapter.getTaskStatus(taskId);
        if (!task) {
          this.sendJsonResponse(res, 404, {
            error: { code: 'RESOURCE_NOT_FOUND', message: `Task '${taskId}' not found` },
          });
          return;
        }
        this.sendJsonResponse(res, 200, { data: task });
        return;
      }

      // No matching ACP route — return 404.
      this.sendJsonResponse(res, 404, {
        error: { code: 'RESOURCE_NOT_FOUND', message: `Route not found: ${method} ${path}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';

      // Map error messages to appropriate HTTP status codes.
      if (message.includes('not found') || message.includes('not registered')) {
        this.sendJsonResponse(res, 404, {
          error: { code: 'RESOURCE_NOT_FOUND', message },
        });
      } else if (message.includes('denied')) {
        this.sendJsonResponse(res, 403, {
          error: { code: 'AUTHZ_DENIED', message },
        });
      } else if (message.includes('validation') || message.includes('Invalid') || message.includes('Cannot cancel')) {
        this.sendJsonResponse(res, 400, {
          error: { code: 'VALIDATION_ERROR', message },
        });
      } else {
        this.sendJsonResponse(res, 500, {
          error: { code: 'INTERNAL_ERROR', message },
        });
      }
    }
  }

  /**
   * Handle SSE streaming for ACP task updates.
   *
   * Sets appropriate SSE headers and streams ACPTaskEvent objects
   * as `data: {json}\n\n` lines. Closes the connection when the
   * task reaches a terminal state.
   */
  private async handleAcpSseStream(taskId: string, res: ServerResponse): Promise<void> {
    // Verify the task exists before starting the stream.
    const task = this._acpAdapter.getTaskStatus(taskId);
    if (!task) {
      this.sendJsonResponse(res, 404, {
        error: { code: 'RESOURCE_NOT_FOUND', message: `Task '${taskId}' not found` },
      });
      return;
    }

    // Set SSE headers.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const stream = this._acpAdapter.streamTaskUpdates(taskId);

    try {
      for await (const event of stream) {
        if (res.writableEnded) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);

        // Close the connection when the task reaches a terminal state.
        const terminalStatuses = ['completed', 'failed', 'canceled'];
        if (terminalStatuses.includes(event.status)) {
          break;
        }
      }
    } catch {
      // Stream error — close the connection.
    }

    if (!res.writableEnded) {
      res.end();
    }
  }

  // ------------------------------------------------------------------
  // Internal — Task management request handling
  // ------------------------------------------------------------------

  /**
   * Handle task management and agent connection REST endpoints.
   *
   * Coding Task routes:
   *  - POST   /coding-tasks                    — Create a coding task
   *  - GET    /coding-tasks                    — List coding tasks
   *  - GET    /coding-tasks/:id                — Get a coding task
   *  - POST   /coding-tasks/:id/dispatch       — Dispatch current step
   *  - POST   /coding-tasks/:id/advance        — Advance to next step
   *  - POST   /coding-tasks/:id/retry          — Retry current step
   *  - POST   /coding-tasks/:id/redirect       — Redirect task steps
   *  - POST   /coding-tasks/:id/cancel         — Cancel a task
   *  - POST   /coding-tasks/:id/interrupt      — Interrupt current step
   *  - GET    /coding-tasks/:id/artifacts      — Query artifacts
   *  - POST   /coding-tasks/:id/events         — Handle external event
   *
   * Agent Connection routes:
   *  - POST   /agent-connections               — Connect an agent
   *  - GET    /agent-connections               — List connected agents
   *  - DELETE /agent-connections/:id           — Disconnect an agent
   *
   * Requirements: 2.1, 2.4, 2.5, 2.6, 2.8, 5.5, 8.3
   */
  private async handleTaskManagementRequest(
    method: string,
    path: string,
    body: unknown,
    operatorId: string,
    res: ServerResponse,
  ): Promise<void> {
    // Normalize: strip /api prefix so route patterns work uniformly.
    // Also map /tasks/ to /coding-tasks/ for UI compatibility.
    let normalizedPath = path.startsWith('/api/') ? path.slice(4) : path;
    if (normalizedPath.startsWith('/tasks/') || normalizedPath === '/tasks') {
      normalizedPath = normalizedPath.replace(/^\/tasks/, '/coding-tasks');
    }

    try {
      // --- Agent Connection routes ---

      // POST /agent-connections — Connect an agent
      if (normalizedPath === '/agent-connections' && method === 'POST') {
        const config = body as AgentConnectionConfig;
        if (!config?.agentId || !config?.protocol || !config?.manifest) {
          this.sendJsonResponse(res, 400, {
            error: { code: 'VALIDATION_ERROR', message: 'Request body must include agentId, protocol, and manifest' },
          });
          return;
        }
        config.operatorId = operatorId;
        const agent = await this._agentConnector.connect(config);
        this.sendJsonResponse(res, 201, { data: agent });
        return;
      }

      // GET /agent-connections — List connected agents
      if (normalizedPath === '/agent-connections' && method === 'GET') {
        const agents = this._agentConnector.listAgents();
        this.sendJsonResponse(res, 200, { data: agents });
        return;
      }

      // DELETE /agent-connections/:id — Disconnect an agent
      if (normalizedPath.match(/^\/agent-connections\/[^/]+$/) && method === 'DELETE') {
        const agentId = decodeURIComponent(normalizedPath.slice('/agent-connections/'.length));
        const disconnectBody = body as { reason?: string } | undefined;
        const reason = disconnectBody?.reason ?? 'Disconnected by operator';
        await this._agentConnector.disconnect(agentId, reason);
        this.sendJsonResponse(res, 200, { data: { agentId, disconnected: true } });
        return;
      }

      // --- Coding Task routes ---

      // POST /coding-tasks/:id/dispatch — Dispatch current step (check before POST /coding-tasks)
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/dispatch$/) && method === 'POST') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/dispatch');
        await this._taskOrchestrator.dispatchCurrentStep(taskId);
        this.sendJsonResponse(res, 200, { data: { taskId, dispatched: true } });
        return;
      }

      // POST /coding-tasks/:id/advance — Advance to next step
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/advance$/) && method === 'POST') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/advance');
        await this._taskOrchestrator.advanceTask(taskId, operatorId);
        this.sendJsonResponse(res, 200, { data: { taskId, advanced: true } });
        return;
      }

      // POST /coding-tasks/:id/retry — Retry current step
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/retry$/) && method === 'POST') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/retry');
        const retryBody = body as { feedback?: string } | undefined;
        const feedback = retryBody?.feedback ?? '';
        await this._taskOrchestrator.retryStep(taskId, feedback, operatorId);
        this.sendJsonResponse(res, 200, { data: { taskId, retried: true } });
        return;
      }

      // POST /coding-tasks/:id/redirect — Redirect task steps
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/redirect$/) && method === 'POST') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/redirect');
        const redirectBody = body as { steps?: TaskStepDefinition[]; fromIndex?: number } | undefined;
        if (!redirectBody?.steps || redirectBody.fromIndex === undefined) {
          this.sendJsonResponse(res, 400, {
            error: { code: 'VALIDATION_ERROR', message: 'Request body must include steps and fromIndex' },
          });
          return;
        }
        await this._taskOrchestrator.redirectTask(taskId, redirectBody.steps, redirectBody.fromIndex, operatorId);
        this.sendJsonResponse(res, 200, { data: { taskId, redirected: true } });
        return;
      }

      // POST /coding-tasks/:id/cancel — Cancel a task
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/cancel$/) && method === 'POST') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/cancel');
        const cancelBody = body as { reason?: string } | undefined;
        const reason = cancelBody?.reason ?? 'Canceled by operator';
        await this._taskOrchestrator.cancelTask(taskId, reason, operatorId);
        this.sendJsonResponse(res, 200, { data: { taskId, canceled: true } });
        return;
      }

      // POST /coding-tasks/:id/interrupt — Interrupt current step
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/interrupt$/) && method === 'POST') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/interrupt');
        await this._taskOrchestrator.interruptStep(taskId, operatorId);
        this.sendJsonResponse(res, 200, { data: { taskId, interrupted: true } });
        return;
      }

      // POST /coding-tasks/:id/events — Handle external event
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/events$/) && method === 'POST') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/events');
        const eventBody = body as { stepId?: string; event?: ExternalEventPayload } | undefined;
        if (!eventBody?.stepId || !eventBody?.event) {
          this.sendJsonResponse(res, 400, {
            error: { code: 'VALIDATION_ERROR', message: 'Request body must include stepId and event' },
          });
          return;
        }
        await this._taskOrchestrator.handleExternalEvent(taskId, eventBody.stepId, eventBody.event);
        this.sendJsonResponse(res, 200, { data: { taskId, eventHandled: true } });
        return;
      }

      // GET /coding-tasks/:id/artifacts — Query artifacts
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+\/artifacts$/) && method === 'GET') {
        const taskId = this.extractPathParam(normalizedPath, '/coding-tasks/', '/artifacts');
        const query: ArtifactQuery = { taskId };
        const artifacts = await this._taskOrchestrator.queryArtifacts(query);
        this.sendJsonResponse(res, 200, { data: artifacts });
        return;
      }

      // POST /coding-tasks — Create a coding task
      if (normalizedPath === '/coding-tasks' && method === 'POST') {
        const submission = body as CodingTaskSubmission;
        if (!submission?.steps || !Array.isArray(submission.steps)) {
          this.sendJsonResponse(res, 400, {
            error: { code: 'VALIDATION_ERROR', message: 'Request body must include steps array' },
          });
          return;
        }
        submission.operatorId = operatorId;
        const task = await this._taskOrchestrator.createTask(submission);
        this.sendJsonResponse(res, 201, { data: task });
        return;
      }

      // GET /coding-tasks — List coding tasks
      if (normalizedPath === '/coding-tasks' && method === 'GET') {
        const tasks = this._taskOrchestrator.listTasks({ operatorId });
        this.sendJsonResponse(res, 200, { data: tasks });
        return;
      }

      // GET /coding-tasks/:id — Get a coding task
      if (normalizedPath.match(/^\/coding-tasks\/[^/]+$/) && method === 'GET') {
        const taskId = normalizedPath.slice('/coding-tasks/'.length);
        const task = this._taskOrchestrator.getTask(taskId);
        if (!task) {
          this.sendJsonResponse(res, 404, {
            error: { code: 'RESOURCE_NOT_FOUND', message: `Coding task '${taskId}' not found` },
          });
          return;
        }
        this.sendJsonResponse(res, 200, { data: task });
        return;
      }

      // No matching route — return 404.
      this.sendJsonResponse(res, 404, {
        error: { code: 'RESOURCE_NOT_FOUND', message: `Route not found: ${method} ${normalizedPath}` },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';

      if (message.includes('not found')) {
        this.sendJsonResponse(res, 404, {
          error: { code: 'RESOURCE_NOT_FOUND', message },
        });
      } else if (message.includes('denied') || message.includes('authorization')) {
        this.sendJsonResponse(res, 403, {
          error: { code: 'AUTHZ_DENIED', message },
        });
      } else if (
        message.includes('Cannot') ||
        message.includes('Invalid') ||
        message.includes('already connected') ||
        message.includes('No capable agent') ||
        message.includes('retry limit')
      ) {
        this.sendJsonResponse(res, 400, {
          error: { code: 'VALIDATION_ERROR', message },
        });
      } else {
        this.sendJsonResponse(res, 500, {
          error: { code: 'INTERNAL_ERROR', message },
        });
      }
    }
  }

  /**
   * Extract a path parameter from a route path.
   * e.g., extractPathParam('/coding-tasks/abc123/cancel', '/coding-tasks/', '/cancel') => 'abc123'
   */
  private extractPathParam(path: string, prefix: string, suffix?: string): string {
    let value = path.slice(prefix.length);
    if (suffix && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
    }
    return decodeURIComponent(value);
  }

  /**
   * Send a JSON response on the HTTP response object.
   */
  private sendJsonResponse(res: ServerResponse, status: number, body: unknown): void {
    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify(body));
  }

  /**
   * Extract a path parameter from an ACP route path.
   * e.g., extractAcpPathParam('/tasks/abc123/cancel', '/tasks/', '/cancel') => 'abc123'
   */
  private extractAcpPathParam(path: string, prefix: string, suffix?: string): string {
    let value = path.slice(prefix.length);
    if (suffix && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
    }
    return decodeURIComponent(value);
  }

  /**
   * Read and parse the JSON body from an incoming HTTP request.
   */
  private readRequestBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(undefined);
        }
      });
      req.on('error', reject);
    });
  }

  // ------------------------------------------------------------------
  // Public getters for subsystem access
  // ------------------------------------------------------------------

  get auditLog(): AuditLog {
    return this._auditLog;
  }

  get policyEngine(): PolicyEngine {
    return this._policyEngine;
  }

  get manifestValidator(): ManifestValidator {
    return this._manifestValidator;
  }

  get sessionManager(): SessionManager {
    return this._sessionManager;
  }

  get memoryStore(): MemoryStore {
    return this._memoryStore;
  }

  get antiLeakage(): AntiLeakage {
    return this._antiLeakage;
  }

  get communicationBus(): CommunicationBus {
    return this._communicationBus;
  }

  get mcpGateway(): MCPGateway {
    return this._mcpGateway;
  }

  get agentDiscoveryRegistry(): AgentDiscoveryRegistry {
    return this._agentDiscoveryRegistry;
  }

  get acpAdapter(): ACPAdapter {
    return this._acpAdapter;
  }

  get agentCPBridge(): AgentCPBridge {
    return this._agentCPBridge;
  }

  get operatorInterface(): OperatorInterface {
    return this._operatorInterface;
  }

  get agentConnector(): AgentConnector {
    return this._agentConnector;
  }

  get taskOrchestrator(): TaskOrchestrator {
    return this._taskOrchestrator;
  }

  /** Whether the Command Center is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the address the HTTP server is listening on.
   * Useful for tests that use port 0 (auto-assigned port).
   */
  get address(): { port: number; host: string } | null {
    if (!this.httpServer) return null;
    const addr = this.httpServer.address();
    if (!addr || typeof addr === 'string') return null;
    return { port: addr.port, host: addr.address };
  }
}
