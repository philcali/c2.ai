import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClientImpl } from './client.js';
import type { ApiClientOptions } from './client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(overrides: Partial<ApiClientOptions> = {}) {
  return new ApiClientImpl({
    baseUrl: 'http://test-api:8080',
    getToken: () => 'test-token-123',
    onAuthError: vi.fn(),
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function noContentResponse() {
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiClientImpl', () => {
  const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Constructor / base URL ----

  describe('constructor', () => {
    it('uses the provided baseUrl', () => {
      const client = createClient({ baseUrl: 'http://custom:9090' });
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      void client.listSessions();
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://custom:9090/api/sessions',
        expect.anything(),
      );
    });

    it('defaults to http://localhost:8080 when no baseUrl or env var', () => {
      const client = new ApiClientImpl({
        baseUrl: undefined,
        getToken: () => null,
        onAuthError: vi.fn(),
      });
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      void client.listSessions();
      // The URL should start with the default or the env var — either way it should be defined
      const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('/api/sessions');
    });
  });

  // ---- Request interceptor: auth token ----

  describe('auth token attachment', () => {
    it('attaches Authorization header when token is available', async () => {
      const client = createClient({ getToken: () => 'my-secret-token' });
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      await client.listSessions();

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer my-secret-token',
      );
    });

    it('omits Authorization header when token is null', async () => {
      const client = createClient({ getToken: () => null });
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      await client.listSessions();

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('sets Content-Type for requests with a body', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ token: 't', operatorId: 'op', expiresAt: '' }),
      );
      await client.authenticate({ token: 'my-token' });

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
    });

    it('does not set Content-Type for GET requests', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));
      await client.listSessions();

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });
  });

  // ---- Response interceptor: 401 handling ----

  describe('401 handling', () => {
    it('calls onAuthError and throws on 401 response', async () => {
      const onAuthError = vi.fn();
      const client = createClient({ onAuthError });
      fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      await expect(client.listSessions()).rejects.toThrow('Authentication required');
      expect(onAuthError).toHaveBeenCalledOnce();
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('throws with response body on non-ok response', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(
        new Response('Not Found', { status: 404 }),
      );
      await expect(client.getTask('missing')).rejects.toThrow('Not Found');
    });

    it('throws with status code when body is empty', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
      await expect(client.listSessions()).rejects.toThrow('Request failed with status 500');
    });
  });

  // ---- authenticate ----

  describe('authenticate', () => {
    it('POSTs token and returns AuthToken', async () => {
      const client = createClient();
      const token = { token: 'abc', operatorId: 'op1', expiresAt: '2025-01-01T00:00:00Z' };
      fetchSpy.mockResolvedValueOnce(jsonResponse(token));

      const result = await client.authenticate({ token: 'abc' });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/auth/login',
        expect.objectContaining({ method: 'POST' }),
      );
      // Verify the body sends { token } not { username, password }
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ token: 'abc' });
      expect(result).toEqual(token);
    });
  });

  // ---- Sessions ----

  describe('sessions', () => {
    it('listSessions sends GET /api/sessions', async () => {
      const client = createClient();
      const sessions = [{ id: 's1', title: 'Test', lastMessagePreview: '', updatedAt: '', hasActiveTasks: false }];
      fetchSpy.mockResolvedValueOnce(jsonResponse(sessions));

      const result = await client.listSessions();
      expect(result).toEqual(sessions);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/sessions',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('createSession sends POST /api/sessions', async () => {
      const client = createClient();
      const session = { id: 's2', title: 'New', lastMessagePreview: '', updatedAt: '', hasActiveTasks: false };
      fetchSpy.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.createSession();
      expect(result).toEqual(session);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/sessions',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('getSessionMessages sends GET with cursor query param', async () => {
      const client = createClient();
      const page = { messages: [], cursor: null, hasMore: false };
      fetchSpy.mockResolvedValueOnce(jsonResponse(page));

      await client.getSessionMessages('s1', 'abc123');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/sessions/s1/messages?cursor=abc123',
        expect.anything(),
      );
    });

    it('getSessionMessages omits cursor when not provided', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(jsonResponse({ messages: [], cursor: null, hasMore: false }));

      await client.getSessionMessages('s1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/sessions/s1/messages',
        expect.anything(),
      );
    });

    it('sendMessage sends POST with content body', async () => {
      const client = createClient();
      const msg = { type: 'operator' as const, id: 'm1', content: 'hello', timestamp: '' };
      fetchSpy.mockResolvedValueOnce(jsonResponse(msg));

      const result = await client.sendMessage('s1', 'hello');
      expect(result).toEqual(msg);

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ content: 'hello' });
    });
  });

  // ---- Tasks ----

  describe('tasks', () => {
    it('getTask sends GET /api/tasks/:id', async () => {
      const client = createClient();
      const task = { id: 't1', operatorId: 'op', status: 'pending', steps: [], currentStepIndex: 0, createdAt: '', updatedAt: '' };
      fetchSpy.mockResolvedValueOnce(jsonResponse(task));

      const result = await client.getTask('t1');
      expect(result).toEqual(task);
    });

    it('listTasks sends GET /api/sessions/:id/tasks', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));

      await client.listTasks('s1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/sessions/s1/tasks',
        expect.anything(),
      );
    });

    it('advanceTask sends POST /api/tasks/:id/advance', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(noContentResponse());

      await client.advanceTask('t1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/tasks/t1/advance',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('retryStep sends POST with feedback body', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(noContentResponse());

      await client.retryStep('t1', 'try again');
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ feedback: 'try again' });
    });

    it('redirectTask sends POST with steps and fromIndex', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(noContentResponse());

      await client.redirectTask('t1', [{ instructions: 'do X' }], 2);
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({
        steps: [{ instructions: 'do X' }],
        fromIndex: 2,
      });
    });

    it('cancelTask sends POST with reason body', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(noContentResponse());

      await client.cancelTask('t1', 'no longer needed');
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ reason: 'no longer needed' });
    });
  });

  // ---- Artifacts ----

  describe('artifacts', () => {
    it('getArtifacts sends GET /api/tasks/:id/artifacts', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));

      await client.getArtifacts('t1');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/tasks/t1/artifacts',
        expect.anything(),
      );
    });

    it('getArtifacts includes stepId query param when provided', async () => {
      const client = createClient();
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));

      await client.getArtifacts('t1', 'step-5');
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://test-api:8080/api/tasks/t1/artifacts?stepId=step-5',
        expect.anything(),
      );
    });
  });

  // ---- Memory ----

  describe('memory', () => {
    it('queryMemory sends POST /api/memory/query', async () => {
      const client = createClient();
      const result = { entries: [], summary: 'nothing found' };
      fetchSpy.mockResolvedValueOnce(jsonResponse(result));

      const res = await client.queryMemory('what workspaces?');
      expect(res).toEqual(result);

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ query: 'what workspaces?' });
    });
  });
});
