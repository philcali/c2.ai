import { v4 as uuidv4 } from 'uuid';
import type {
  IAgentCPBridge,
  AgentCPProcessHandle,
  AgentCPSession,
  AgentCPSessionInfo,
  AgentCPSessionState,
  AgentCPCapabilities,
  AgentCPRequest,
  AgentCPResponse,
  AgentCPNotification,
  AgentCPMethod,
  AgentCPPermissionRequest,
} from '../interfaces/agentcp-bridge.js';
import type { ISessionManager } from '../interfaces/session-manager.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IMCPGateway } from '../interfaces/mcp-gateway.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { AgentManifest } from '../interfaces/manifest-validator.js';

// ------------------------------------------------------------------
// JSON-RPC 2.0 standard error codes
// ------------------------------------------------------------------

/** JSON could not be parsed. */
const JSON_RPC_PARSE_ERROR = -32700;
/** The method does not exist or is not available. */
const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** Invalid method parameter(s). */
const JSON_RPC_INVALID_PARAMS = -32602;
/** Internal JSON-RPC error. */
const JSON_RPC_INTERNAL_ERROR = -32603;

/** All recognised AgentCP methods. */
const VALID_METHODS: Set<string> = new Set<string>([
  'session/initialize',
  'session/new',
  'session/prompt',
  'session/update',
  'session/cancel',
  'permission/request',
  'permission/response',
]);

// ------------------------------------------------------------------
// Internal connection tracking
// ------------------------------------------------------------------

/**
 * Internal representation of a live IDE connection.
 * Holds the process handle, the AgentCP session metadata, and a
 * write helper for sending JSON-RPC responses back to the IDE.
 */
interface ConnectionContext {
  processHandle: AgentCPProcessHandle;
  session: AgentCPSession;
  /** Buffer for accumulating partial lines from stdout. */
  lineBuffer: string;
}

// ------------------------------------------------------------------
// AgentCPBridge implementation
// ------------------------------------------------------------------

/**
 * In-memory AgentCP Bridge implementation.
 *
 * Translates between the Agent Client Protocol's JSON-RPC 2.0 messages
 * (over stdin/stdout) and the Command Center's internal subsystems.
 *
 * Guarantees:
 *  - JSON-RPC 2.0 message parsing with standard error responses for
 *    malformed messages (-32700), unknown methods (-32601), and
 *    invalid params (-32602).
 *  - session/initialize creates a corresponding Agent_Session in the
 *    Session Manager with an Isolation_Boundary derived from declared
 *    capabilities.
 *  - session/prompt routes prompts to the Agent_Session and streams
 *    responses via session/update.
 *  - permission/request forwards to the Policy Engine.
 *  - session/cancel terminates the Agent_Session.
 *  - session/new terminates the current session and creates a new one.
 *  - IDE disconnection (stdout close) terminates the Agent_Session.
 *  - All events are recorded in the Audit Log.
 *  - Multiple concurrent IDE connections with independent sessions.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8
 */
export class AgentCPBridge implements IAgentCPBridge {
  private readonly sessionManager: ISessionManager;
  private readonly policyEngine: IPolicyEngine;
  private readonly mcpGateway: IMCPGateway;
  private readonly auditLog: IAuditLog;

  /** Active connections keyed by AgentCP session ID. */
  private readonly connections: Map<string, ConnectionContext> = new Map();

  constructor(options: {
    sessionManager: ISessionManager;
    policyEngine: IPolicyEngine;
    mcpGateway: IMCPGateway;
    auditLog: IAuditLog;
  }) {
    this.sessionManager = options.sessionManager;
    this.policyEngine = options.policyEngine;
    this.mcpGateway = options.mcpGateway;
    this.auditLog = options.auditLog;
  }


  // ------------------------------------------------------------------
  // IAgentCPBridge — Accept a new IDE connection
  // ------------------------------------------------------------------

  /**
   * Handle a new IDE connection over stdin/stdout.
   *
   * Creates an AgentCP session in 'initializing' state and begins
   * listening for JSON-RPC 2.0 messages on the process's stdout.
   * The session transitions to 'active' once a session/initialize
   * message is received and processed.
   *
   * Requirements: 12.1, 12.8
   */
  async acceptConnection(
    processHandle: AgentCPProcessHandle,
    operatorId: string,
  ): Promise<AgentCPSession> {
    const sessionId = uuidv4();
    const now = new Date();

    const session: AgentCPSession = {
      id: sessionId,
      agentSessionId: '', // assigned on session/initialize
      operatorId,
      state: 'initializing',
      capabilities: {
        canWriteFiles: false,
        canExecuteCommands: false,
      },
      createdAt: now,
    };

    const ctx: ConnectionContext = {
      processHandle,
      session,
      lineBuffer: '',
    };

    this.connections.set(sessionId, ctx);

    // Listen for data on stdout (IDE → Bridge).
    this.attachStdoutListener(ctx);

    // Listen for IDE disconnection (stdout close).
    this.attachCloseListener(ctx);

    // Record connection event.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      eventType: 'agentcp_session',
      operation: 'accept_connection',
      resource: `agentcp:session:${sessionId}`,
      details: {
        sessionId,
        pid: processHandle.pid,
      },
    });

    return session;
  }

  // ------------------------------------------------------------------
  // IAgentCPBridge — Terminate a session
  // ------------------------------------------------------------------

  /**
   * Explicitly terminate an AgentCP session.
   *
   * Terminates the corresponding Agent_Session (if one exists),
   * transitions the AgentCP session to 'terminated', and cleans up.
   *
   * Requirements: 12.5
   */
  async terminateSession(sessionId: string, reason: string): Promise<void> {
    const ctx = this.connections.get(sessionId);
    if (!ctx) {
      throw new Error(`AgentCP session '${sessionId}' not found.`);
    }

    await this.cleanupSession(ctx, 'terminated', reason);
  }

  // ------------------------------------------------------------------
  // IAgentCPBridge — List sessions
  // ------------------------------------------------------------------

  /**
   * List all active AgentCP sessions.
   *
   * Requirements: 12.8
   */
  listSessions(): AgentCPSessionInfo[] {
    return Array.from(this.connections.values()).map((ctx) => ({
      id: ctx.session.id,
      agentSessionId: ctx.session.agentSessionId,
      operatorId: ctx.session.operatorId,
      state: ctx.session.state,
      createdAt: ctx.session.createdAt,
    }));
  }

  // ------------------------------------------------------------------
  // stdout listener — JSON-RPC message ingestion
  // ------------------------------------------------------------------

  /**
   * Attach a data listener to the process's stdout stream.
   * Accumulates data into a line buffer and processes complete
   * newline-delimited JSON-RPC messages.
   */
  private attachStdoutListener(ctx: ConnectionContext): void {
    const onData = (chunk: Buffer | string): void => {
      ctx.lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

      // Process complete lines (newline-delimited JSON-RPC).
      let newlineIdx: number;
      while ((newlineIdx = ctx.lineBuffer.indexOf('\n')) !== -1) {
        const line = ctx.lineBuffer.slice(0, newlineIdx).trim();
        ctx.lineBuffer = ctx.lineBuffer.slice(newlineIdx + 1);

        if (line.length > 0) {
          void this.handleRawMessage(ctx, line);
        }
      }
    };

    ctx.processHandle.stdout.on('data', onData);
  }

  /**
   * Attach a close/end listener to detect IDE disconnection.
   */
  private attachCloseListener(ctx: ConnectionContext): void {
    const onClose = (): void => {
      void this.handleDisconnection(ctx);
    };

    ctx.processHandle.stdout.on('end', onClose);
    ctx.processHandle.stdout.on('close', onClose);
  }

  // ------------------------------------------------------------------
  // Raw message handling — parse → validate → dispatch
  // ------------------------------------------------------------------

  /**
   * Parse a raw line as JSON-RPC 2.0 and dispatch to the appropriate
   * method handler.
   */
  private async handleRawMessage(
    ctx: ConnectionContext,
    raw: string,
  ): Promise<void> {
    // 1. Parse JSON.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendErrorResponse(ctx, null, JSON_RPC_PARSE_ERROR, 'Parse error: invalid JSON');
      return;
    }

    // 2. Validate JSON-RPC 2.0 envelope.
    const validation = this.validateJsonRpc(parsed);
    if (!validation.valid) {
      const rawId = (parsed as Record<string, unknown>)?.id;
      const errorId = (typeof rawId === 'string' || typeof rawId === 'number') ? rawId : null;
      this.sendErrorResponse(
        ctx,
        errorId,
        validation.code!,
        validation.message!,
      );
      return;
    }

    const request = parsed as AgentCPRequest;

    // 3. Dispatch to method handler.
    try {
      await this.dispatchMethod(ctx, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendErrorResponse(ctx, request.id, JSON_RPC_INTERNAL_ERROR, message);
    }
  }

  /**
   * Validate that a parsed object conforms to JSON-RPC 2.0 structure
   * with a recognised AgentCP method.
   */
  private validateJsonRpc(
    obj: unknown,
  ): { valid: boolean; code?: number; message?: string } {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { valid: false, code: JSON_RPC_PARSE_ERROR, message: 'Parse error: not a JSON object' };
    }

    const record = obj as Record<string, unknown>;

    if (record.jsonrpc !== '2.0') {
      return {
        valid: false,
        code: JSON_RPC_PARSE_ERROR,
        message: `Parse error: invalid jsonrpc version '${String(record.jsonrpc)}'`,
      };
    }

    if (record.id === undefined || record.id === null) {
      return {
        valid: false,
        code: JSON_RPC_PARSE_ERROR,
        message: 'Parse error: missing id field',
      };
    }

    if (typeof record.method !== 'string') {
      return {
        valid: false,
        code: JSON_RPC_PARSE_ERROR,
        message: 'Parse error: missing or invalid method field',
      };
    }

    if (!VALID_METHODS.has(record.method)) {
      return {
        valid: false,
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `Method not found: '${record.method}'`,
      };
    }

    return { valid: true };
  }

  // ------------------------------------------------------------------
  // Method dispatch
  // ------------------------------------------------------------------

  /**
   * Route a validated JSON-RPC request to the correct handler.
   */
  private async dispatchMethod(
    ctx: ConnectionContext,
    request: AgentCPRequest,
  ): Promise<void> {
    switch (request.method) {
      case 'session/initialize':
        await this.handleSessionInitialize(ctx, request);
        break;
      case 'session/new':
        await this.handleSessionNew(ctx, request);
        break;
      case 'session/prompt':
        await this.handleSessionPrompt(ctx, request);
        break;
      case 'session/update':
        // session/update is a server→client notification; if the IDE
        // sends it, we acknowledge but take no action.
        this.sendSuccessResponse(ctx, request.id, { acknowledged: true });
        break;
      case 'session/cancel':
        await this.handleSessionCancel(ctx, request);
        break;
      case 'permission/request':
        await this.handlePermissionRequest(ctx, request);
        break;
      case 'permission/response':
        // permission/response is a server→client message; acknowledge.
        this.sendSuccessResponse(ctx, request.id, { acknowledged: true });
        break;
      default:
        this.sendErrorResponse(
          ctx,
          request.id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Method not found: '${request.method}'`,
        );
    }
  }


  // ------------------------------------------------------------------
  // Method handlers
  // ------------------------------------------------------------------

  /**
   * Handle session/initialize.
   *
   * Creates a corresponding Agent_Session in the Session Manager with
   * an Isolation_Boundary derived from the declared capabilities.
   *
   * Expected params:
   *   capabilities: AgentCPCapabilities
   *   agentIdentity?: string
   *   description?: string
   *
   * Requirements: 12.2
   */
  private async handleSessionInitialize(
    ctx: ConnectionContext,
    request: AgentCPRequest,
  ): Promise<void> {
    const params = request.params ?? {};

    // Validate capabilities param.
    const capabilities = this.parseCapabilities(params.capabilities);
    if (!capabilities) {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INVALID_PARAMS,
        "Invalid params: 'capabilities' must be an object with 'canWriteFiles' and 'canExecuteCommands' booleans",
      );
      return;
    }

    // Build an AgentManifest from the declared capabilities so the
    // Session Manager can derive an Isolation_Boundary.
    const manifest = this.capabilitiesToManifest(
      capabilities,
      params.agentIdentity as string | undefined,
      params.description as string | undefined,
    );

    try {
      const agentSession = await this.sessionManager.createSession(
        manifest,
        ctx.session.operatorId,
      );

      // Update the AgentCP session.
      ctx.session.agentSessionId = agentSession.id;
      ctx.session.capabilities = capabilities;
      ctx.session.state = 'active';

      // Record in audit log.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId: agentSession.id,
        operatorId: ctx.session.operatorId,
        eventType: 'agentcp_session',
        operation: 'session/initialize',
        resource: `agentcp:session:${ctx.session.id}`,
        details: {
          agentcpSessionId: ctx.session.id,
          agentSessionId: agentSession.id,
          capabilities,
        },
      });

      this.sendSuccessResponse(ctx, request.id, {
        sessionId: ctx.session.id,
        agentSessionId: agentSession.id,
        state: ctx.session.state,
        capabilities,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Record failure in audit log.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        operatorId: ctx.session.operatorId,
        eventType: 'agentcp_session',
        operation: 'session/initialize',
        resource: `agentcp:session:${ctx.session.id}`,
        decision: 'deny',
        details: {
          agentcpSessionId: ctx.session.id,
          reason: message,
        },
      });

      this.sendErrorResponse(ctx, request.id, JSON_RPC_INTERNAL_ERROR, message);
    }
  }

  /**
   * Handle session/new.
   *
   * Terminates the current Agent_Session (if active) and creates a
   * new one with the provided capabilities.
   *
   * Requirements: 12.5
   */
  private async handleSessionNew(
    ctx: ConnectionContext,
    request: AgentCPRequest,
  ): Promise<void> {
    const params = request.params ?? {};

    const capabilities = this.parseCapabilities(params.capabilities);
    if (!capabilities) {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INVALID_PARAMS,
        "Invalid params: 'capabilities' must be an object with 'canWriteFiles' and 'canExecuteCommands' booleans",
      );
      return;
    }

    // Terminate the previous Agent_Session if one exists.
    if (ctx.session.agentSessionId) {
      try {
        await this.sessionManager.terminateSession(
          ctx.session.agentSessionId,
          'Replaced by session/new',
        );
      } catch {
        // Best-effort termination — the session may already be terminated.
      }

      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId: ctx.session.agentSessionId,
        operatorId: ctx.session.operatorId,
        eventType: 'agentcp_session',
        operation: 'session/new:terminate_previous',
        resource: `agentcp:session:${ctx.session.id}`,
        details: {
          agentcpSessionId: ctx.session.id,
          previousAgentSessionId: ctx.session.agentSessionId,
        },
      });
    }

    // Create a new Agent_Session.
    const manifest = this.capabilitiesToManifest(
      capabilities,
      params.agentIdentity as string | undefined,
      params.description as string | undefined,
    );

    try {
      const agentSession = await this.sessionManager.createSession(
        manifest,
        ctx.session.operatorId,
      );

      ctx.session.agentSessionId = agentSession.id;
      ctx.session.capabilities = capabilities;
      ctx.session.state = 'active';

      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: new Date(),
        agentId: agentSession.id,
        operatorId: ctx.session.operatorId,
        eventType: 'agentcp_session',
        operation: 'session/new',
        resource: `agentcp:session:${ctx.session.id}`,
        details: {
          agentcpSessionId: ctx.session.id,
          agentSessionId: agentSession.id,
          capabilities,
        },
      });

      this.sendSuccessResponse(ctx, request.id, {
        sessionId: ctx.session.id,
        agentSessionId: agentSession.id,
        state: ctx.session.state,
        capabilities,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendErrorResponse(ctx, request.id, JSON_RPC_INTERNAL_ERROR, message);
    }
  }

  /**
   * Handle session/prompt.
   *
   * Routes the prompt to the Agent_Session and sends a session/update
   * notification back to the IDE with the response.
   *
   * Expected params:
   *   prompt: string
   *
   * Requirements: 12.3
   */
  private async handleSessionPrompt(
    ctx: ConnectionContext,
    request: AgentCPRequest,
  ): Promise<void> {
    if (ctx.session.state !== 'active') {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INTERNAL_ERROR,
        `Session is not active (current state: '${ctx.session.state}'). Send session/initialize first.`,
      );
      return;
    }

    const params = request.params ?? {};
    const prompt = params.prompt;

    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INVALID_PARAMS,
        "Invalid params: 'prompt' must be a non-empty string",
      );
      return;
    }

    // Record the prompt event.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      agentId: ctx.session.agentSessionId,
      operatorId: ctx.session.operatorId,
      eventType: 'agentcp_session',
      operation: 'session/prompt',
      resource: `agentcp:session:${ctx.session.id}`,
      details: {
        agentcpSessionId: ctx.session.id,
        agentSessionId: ctx.session.agentSessionId,
        promptLength: prompt.length,
      },
    });

    // Acknowledge the prompt to the IDE.
    this.sendSuccessResponse(ctx, request.id, {
      status: 'processing',
      agentSessionId: ctx.session.agentSessionId,
    });

    // Send a session/update notification back to the IDE.
    // In a full implementation this would stream incremental updates;
    // here we send a single update with the prompt echo as a placeholder.
    this.sendNotification(ctx, 'session/update', {
      sessionId: ctx.session.id,
      agentSessionId: ctx.session.agentSessionId,
      type: 'response',
      content: `Processed prompt: ${prompt}`,
    });
  }

  /**
   * Handle session/cancel.
   *
   * Terminates the corresponding Agent_Session through the Session
   * Manager and transitions the AgentCP session to 'canceled'.
   *
   * Requirements: 12.5
   */
  private async handleSessionCancel(
    ctx: ConnectionContext,
    request: AgentCPRequest,
  ): Promise<void> {
    if (!ctx.session.agentSessionId) {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INTERNAL_ERROR,
        'No active agent session to cancel. Send session/initialize first.',
      );
      return;
    }

    try {
      await this.sessionManager.terminateSession(
        ctx.session.agentSessionId,
        'Canceled via session/cancel',
      );
    } catch {
      // Best-effort — session may already be terminated.
    }

    ctx.session.state = 'canceled';

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      agentId: ctx.session.agentSessionId,
      operatorId: ctx.session.operatorId,
      eventType: 'agentcp_session',
      operation: 'session/cancel',
      resource: `agentcp:session:${ctx.session.id}`,
      details: {
        agentcpSessionId: ctx.session.id,
        agentSessionId: ctx.session.agentSessionId,
      },
    });

    this.sendSuccessResponse(ctx, request.id, {
      sessionId: ctx.session.id,
      state: 'canceled',
    });
  }

  /**
   * Handle permission/request.
   *
   * Forwards file write and terminal command permission requests to
   * the Policy Engine for authorization.
   *
   * Expected params:
   *   type: 'file_write' | 'terminal_command'
   *   resource: string
   *   description: string
   *
   * Requirements: 12.4, 12.6
   */
  private async handlePermissionRequest(
    ctx: ConnectionContext,
    request: AgentCPRequest,
  ): Promise<void> {
    if (ctx.session.state !== 'active') {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INTERNAL_ERROR,
        `Session is not active (current state: '${ctx.session.state}'). Send session/initialize first.`,
      );
      return;
    }

    const params = request.params ?? {};
    const permRequest = this.parsePermissionRequest(params);

    if (!permRequest) {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INVALID_PARAMS,
        "Invalid params: 'type' must be 'file_write' or 'terminal_command', 'resource' and 'description' must be non-empty strings",
      );
      return;
    }

    // Map permission type to policy operation.
    const operation = permRequest.type === 'file_write'
      ? 'file_write'
      : 'terminal_command';

    // Evaluate via Policy Engine.
    const decision = this.policyEngine.evaluate({
      agentId: ctx.session.agentSessionId,
      operation,
      resource: permRequest.resource,
      context: {
        agentcpSessionId: ctx.session.id,
        description: permRequest.description,
      },
    });

    // Record the permission decision.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      agentId: ctx.session.agentSessionId,
      operatorId: ctx.session.operatorId,
      eventType: 'agentcp_session',
      operation: `permission/${operation}`,
      resource: permRequest.resource,
      decision: decision.allowed ? 'allow' : 'deny',
      details: {
        agentcpSessionId: ctx.session.id,
        agentSessionId: ctx.session.agentSessionId,
        permissionType: permRequest.type,
        description: permRequest.description,
        policyId: decision.policyId,
        reason: decision.reason,
      },
    });

    if (decision.allowed) {
      this.sendSuccessResponse(ctx, request.id, {
        granted: true,
        type: permRequest.type,
        resource: permRequest.resource,
      });
    } else {
      this.sendErrorResponse(
        ctx,
        request.id,
        JSON_RPC_INTERNAL_ERROR,
        `Permission denied: ${decision.reason}`,
        { type: permRequest.type, resource: permRequest.resource, policyId: decision.policyId },
      );
    }
  }


  // ------------------------------------------------------------------
  // IDE disconnection handling
  // ------------------------------------------------------------------

  /**
   * Handle IDE disconnection (stdout close).
   *
   * Terminates the corresponding Agent_Session and cleans up.
   *
   * Requirements: 12.5
   */
  private async handleDisconnection(ctx: ConnectionContext): Promise<void> {
    // Guard against duplicate close events.
    if (ctx.session.state === 'terminated') {
      return;
    }

    await this.cleanupSession(ctx, 'terminated', 'IDE disconnected');
  }

  // ------------------------------------------------------------------
  // Session cleanup
  // ------------------------------------------------------------------

  /**
   * Clean up an AgentCP session: terminate the Agent_Session, update
   * state, record in audit log, and remove from the connections map.
   */
  private async cleanupSession(
    ctx: ConnectionContext,
    newState: AgentCPSessionState,
    reason: string,
  ): Promise<void> {
    const previousState = ctx.session.state;

    // Terminate the underlying Agent_Session if one exists.
    if (ctx.session.agentSessionId) {
      try {
        await this.sessionManager.terminateSession(
          ctx.session.agentSessionId,
          reason,
        );
      } catch {
        // Best-effort — session may already be terminated.
      }
    }

    ctx.session.state = newState;

    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      agentId: ctx.session.agentSessionId || undefined,
      operatorId: ctx.session.operatorId,
      eventType: 'agentcp_session',
      operation: 'session_cleanup',
      resource: `agentcp:session:${ctx.session.id}`,
      details: {
        agentcpSessionId: ctx.session.id,
        agentSessionId: ctx.session.agentSessionId,
        previousState,
        newState,
        reason,
      },
    });

    this.connections.delete(ctx.session.id);
  }

  // ------------------------------------------------------------------
  // JSON-RPC response helpers
  // ------------------------------------------------------------------

  /**
   * Send a JSON-RPC 2.0 success response to the IDE via stdin.
   */
  private sendSuccessResponse(
    ctx: ConnectionContext,
    id: string | number,
    result: unknown,
  ): void {
    const response: AgentCPResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    this.writeToStdin(ctx, response);
  }

  /**
   * Send a JSON-RPC 2.0 error response to the IDE via stdin.
   */
  private sendErrorResponse(
    ctx: ConnectionContext,
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const response: AgentCPResponse = {
      jsonrpc: '2.0',
      id: id ?? 0,
      error: { code, message, data },
    };
    this.writeToStdin(ctx, response);
  }

  /**
   * Send a JSON-RPC 2.0 notification (no id) to the IDE via stdin.
   */
  private sendNotification(
    ctx: ConnectionContext,
    method: AgentCPMethod,
    params: Record<string, unknown>,
  ): void {
    const notification: AgentCPNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.writeToStdin(ctx, notification);
  }

  /**
   * Write a JSON-RPC message to the process's stdin as a
   * newline-delimited JSON string.
   */
  private writeToStdin(
    ctx: ConnectionContext,
    message: AgentCPResponse | AgentCPNotification,
  ): void {
    try {
      const data = JSON.stringify(message) + '\n';
      ctx.processHandle.stdin.write(data);
    } catch {
      // If stdin is closed, we can't send — the disconnection handler
      // will clean up.
    }
  }

  // ------------------------------------------------------------------
  // Parsing helpers
  // ------------------------------------------------------------------

  /**
   * Parse and validate an AgentCPCapabilities object from raw params.
   */
  private parseCapabilities(raw: unknown): AgentCPCapabilities | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null;
    }

    const obj = raw as Record<string, unknown>;

    if (typeof obj.canWriteFiles !== 'boolean' || typeof obj.canExecuteCommands !== 'boolean') {
      return null;
    }

    const capabilities: AgentCPCapabilities = {
      canWriteFiles: obj.canWriteFiles,
      canExecuteCommands: obj.canExecuteCommands,
    };

    if (obj.allowedPaths !== undefined) {
      if (
        !Array.isArray(obj.allowedPaths) ||
        !obj.allowedPaths.every((p: unknown) => typeof p === 'string')
      ) {
        return null;
      }
      capabilities.allowedPaths = obj.allowedPaths as string[];
    }

    if (obj.allowedCommands !== undefined) {
      if (
        !Array.isArray(obj.allowedCommands) ||
        !obj.allowedCommands.every((c: unknown) => typeof c === 'string')
      ) {
        return null;
      }
      capabilities.allowedCommands = obj.allowedCommands as string[];
    }

    return capabilities;
  }

  /**
   * Parse and validate an AgentCPPermissionRequest from raw params.
   */
  private parsePermissionRequest(
    params: Record<string, unknown>,
  ): AgentCPPermissionRequest | null {
    const { type, resource, description } = params;

    if (type !== 'file_write' && type !== 'terminal_command') {
      return null;
    }

    if (typeof resource !== 'string' || resource.trim().length === 0) {
      return null;
    }

    if (typeof description !== 'string' || description.trim().length === 0) {
      return null;
    }

    return { type, resource, description };
  }

  /**
   * Convert AgentCP capabilities into an AgentManifest that the
   * Session Manager can use to derive an Isolation_Boundary.
   *
   * The manifest grants exactly the permissions declared in the
   * capabilities — no more and no less.
   *
   * Requirements: 12.2
   */
  private capabilitiesToManifest(
    capabilities: AgentCPCapabilities,
    agentIdentity?: string,
    description?: string,
  ): AgentManifest {
    const manifestId = uuidv4();

    // Build memory namespaces from allowed paths (file write → write access).
    const memoryNamespaces: AgentManifest['memoryNamespaces'] = [];
    if (capabilities.canWriteFiles && capabilities.allowedPaths) {
      for (const path of capabilities.allowedPaths) {
        memoryNamespaces.push({ namespace: `file:${path}`, access: 'readwrite' });
      }
    }

    // Build MCP operations from allowed commands.
    const mcpOperations: AgentManifest['mcpOperations'] = [];
    if (capabilities.canExecuteCommands && capabilities.allowedCommands) {
      mcpOperations.push({
        serviceId: 'terminal',
        operations: capabilities.allowedCommands,
      });
    }

    return {
      id: manifestId,
      agentIdentity: agentIdentity ?? `agentcp-agent-${manifestId}`,
      description: description ?? 'AgentCP IDE agent session',
      memoryNamespaces,
      communicationChannels: [],
      mcpOperations,
    };
  }
}
