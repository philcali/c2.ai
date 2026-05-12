import type {
  LoginCredentials,
  AuthToken,
  SessionSummary,
  PaginatedMessages,
  ChatMessage,
  CodingTask,
  ExecutionArtifact,
} from '../types/index.js';

/**
 * Definition for a step used when redirecting a task.
 */
export interface StepDefinition {
  instructions: string;
}

/**
 * Result of a memory query against the backend Memory_Store.
 */
export interface MemoryQueryResult {
  entries: Array<{
    namespace: string;
    key: string;
    value: unknown;
    timestamp: string;
    tags: string[];
  }>;
  summary: string;
}

/**
 * Contract for the REST API client consumed by hooks and stores.
 */
export interface ApiClient {
  // Auth
  authenticate(credentials: LoginCredentials): Promise<AuthToken>;

  // Sessions
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<SessionSummary>;
  getSessionMessages(sessionId: string, cursor?: string): Promise<PaginatedMessages>;
  sendMessage(sessionId: string, content: string): Promise<ChatMessage>;

  // Tasks
  getTask(taskId: string): Promise<CodingTask>;
  listTasks(sessionId: string): Promise<CodingTask[]>;
  advanceTask(taskId: string): Promise<void>;
  retryStep(taskId: string, feedback: string): Promise<void>;
  redirectTask(taskId: string, steps: StepDefinition[], fromIndex: number): Promise<void>;
  cancelTask(taskId: string, reason: string): Promise<void>;

  // Artifacts
  getArtifacts(taskId: string, stepId?: string): Promise<ExecutionArtifact[]>;

  // Memory
  queryMemory(query: string): Promise<MemoryQueryResult>;
}

/**
 * Options accepted by the concrete API client implementation.
 */
export interface ApiClientOptions {
  /** Base URL for the REST API. Defaults to VITE_API_BASE_URL or http://localhost:8080. */
  baseUrl?: string;
  /** Returns the current auth token (or null when unauthenticated). */
  getToken: () => string | null;
  /** Called when a 401 response is received so the auth layer can clear state and redirect. */
  onAuthError: () => void;
}

/**
 * Concrete REST API client built on the native `fetch` API.
 *
 * Every outgoing request automatically attaches the auth token (when
 * available) and sets the appropriate Content-Type header for JSON
 * bodies.  A 401 response from any endpoint triggers the configured
 * `onAuthError` callback so the auth store can clear the token and
 * redirect to the login screen.
 */
export class ApiClientImpl implements ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => string | null;
  private readonly onAuthError: () => void;

  constructor(options: ApiClientOptions) {
    this.baseUrl =
      options.baseUrl ??
      (typeof import.meta !== 'undefined'
        ? (import.meta as unknown as Record<string, Record<string, string>>).env?.VITE_API_BASE_URL
        : undefined) ??
      'http://localhost:8080';
    this.getToken = options.getToken;
    this.onAuthError = options.onAuthError;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build headers for an outgoing request.
   * Attaches the Authorization header when a token is available and
   * sets Content-Type to application/json when a body will be sent.
   */
  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  /**
   * Central request helper.  All public methods delegate here so that
   * auth-token attachment and 401 handling happen in one place.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders(body !== undefined);

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      this.onAuthError();
      throw new Error('Authentication required');
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(errorBody || `Request failed with status ${response.status}`);
    }

    // 204 No Content — nothing to parse
    if (response.status === 204) {
      return undefined as T;
    }

    const json = await response.json();

    // The backend wraps successful responses in a { data: ... } envelope.
    // Unwrap it so callers receive the payload directly.
    if (json && typeof json === 'object' && 'data' in json) {
      return json.data as T;
    }

    return json as T;
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  async authenticate(credentials: LoginCredentials): Promise<AuthToken> {
    // Send the token for validation — no username/password exchange.
    return this.request<AuthToken>('POST', '/api/auth/login', {
      token: credentials.token,
    });
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async listSessions(): Promise<SessionSummary[]> {
    return this.request<SessionSummary[]>('GET', '/api/sessions');
  }

  async createSession(): Promise<SessionSummary> {
    return this.request<SessionSummary>('POST', '/api/sessions', {
      manifest: {
        id: 'operator-session',
        agentIdentity: 'operator',
        description: 'Operator-initiated session',
        memoryNamespaces: [],
        communicationChannels: [],
        mcpOperations: [],
      },
    });
  }

  async getSessionMessages(
    sessionId: string,
    cursor?: string,
  ): Promise<PaginatedMessages> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<PaginatedMessages>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages${query}`,
    );
  }

  async sendMessage(sessionId: string, content: string): Promise<ChatMessage> {
    return this.request<ChatMessage>(
      'POST',
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      { content },
    );
  }

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  async getTask(taskId: string): Promise<CodingTask> {
    return this.request<CodingTask>(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}`,
    );
  }

  async listTasks(sessionId: string): Promise<CodingTask[]> {
    return this.request<CodingTask[]>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/tasks`,
    );
  }

  async advanceTask(taskId: string): Promise<void> {
    return this.request<void>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/advance`,
    );
  }

  async retryStep(taskId: string, feedback: string): Promise<void> {
    return this.request<void>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/retry`,
      { feedback },
    );
  }

  async redirectTask(
    taskId: string,
    steps: StepDefinition[],
    fromIndex: number,
  ): Promise<void> {
    return this.request<void>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/redirect`,
      { steps, fromIndex },
    );
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    return this.request<void>(
      'POST',
      `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
      { reason },
    );
  }

  // ---------------------------------------------------------------------------
  // Artifacts
  // ---------------------------------------------------------------------------

  async getArtifacts(
    taskId: string,
    stepId?: string,
  ): Promise<ExecutionArtifact[]> {
    const query = stepId
      ? `?stepId=${encodeURIComponent(stepId)}`
      : '';
    return this.request<ExecutionArtifact[]>(
      'GET',
      `/api/tasks/${encodeURIComponent(taskId)}/artifacts${query}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------

  async queryMemory(query: string): Promise<MemoryQueryResult> {
    return this.request<MemoryQueryResult>('POST', '/api/memory/query', {
      query,
    });
  }
}

/**
 * Factory function for creating an API client instance.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClientImpl(options);
}
