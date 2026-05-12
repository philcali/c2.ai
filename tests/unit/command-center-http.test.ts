import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { CommandCenter } from '../../src/command-center.js';
import type { OperatorCredentials } from '../../src/subsystems/operator-interface.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple HTTP request helper that returns status, headers, and parsed JSON body. */
function httpRequest(
  options: {
    port: number;
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

/** Authenticate function for tests. */
const testAuthenticate = (token: string): OperatorCredentials | undefined => {
  if (token === 'valid-token') {
    return { operatorId: 'op-1', permissions: ['*'] };
  }
  if (token === 'limited-token') {
    return { operatorId: 'op-2', permissions: ['session:list'] };
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandCenter HTTP REST routing', () => {
  let cc: CommandCenter | null = null;
  let port: number;

  afterEach(async () => {
    if (cc?.isRunning) {
      await cc.stop();
    }
    cc = null;
  });

  async function startCenter(): Promise<void> {
    cc = new CommandCenter({
      port: 0,
      authenticate: testAuthenticate,
      maxConcurrentSessions: 10,
    });
    await cc.start();
    const addr = cc.address;
    expect(addr).not.toBeNull();
    port = addr!.port;
  }

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  it('should return 401 when no Authorization header is provided', async () => {
    await startCenter();
    const res = await httpRequest({ port, method: 'GET', path: '/api/sessions' });
    expect(res.status).toBe(401);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('AUTHENTICATION_FAILURE');
  });

  it('should return 401 when an invalid token is provided', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/api/sessions',
      headers: { Authorization: 'Bearer bad-token' },
    });
    expect(res.status).toBe(401);
  });

  it('should return 401 when Authorization header is not Bearer format', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/api/sessions',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Session lifecycle routes
  // -----------------------------------------------------------------------

  it('should list sessions via GET /sessions', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/api/sessions',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[] };
    expect(body.data).toBeInstanceOf(Array);
  });

  it('should create a session via POST /sessions', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/api/sessions',
      headers: { Authorization: 'Bearer valid-token' },
      body: {
        manifest: {
          id: 'test-agent',
          agentIdentity: 'test-agent',
          description: 'Test agent',
          memoryNamespaces: [],
          communicationChannels: [],
          mcpOperations: [],
        },
      },
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; title: string } };
    expect(body.data.id).toBeDefined();
    expect(body.data.title).toContain('Session');
  });

  it('should get a specific session via GET /sessions/:id', async () => {
    await startCenter();

    // Create a session first.
    const createRes = await httpRequest({
      port,
      method: 'POST',
      path: '/api/sessions',
      headers: { Authorization: 'Bearer valid-token' },
      body: {
        manifest: {
          id: 'test-agent',
          agentIdentity: 'test-agent',
          description: 'Test',
          memoryNamespaces: [],
          communicationChannels: [],
          mcpOperations: [],
        },
      },
    });
    const sessionId = (createRes.body as { data: { id: string } }).data.id;

    const res = await httpRequest({
      port,
      method: 'GET',
      path: `/api/sessions/${sessionId}`,
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string } };
    expect(body.data.id).toBe(sessionId);
  });

  it('should return 404 for a non-existent session', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/api/sessions/non-existent-id',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // Policy routes
  // -----------------------------------------------------------------------

  it('should list policies via GET /policies', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/api/policies',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[] };
    expect(body.data).toBeInstanceOf(Array);
  });

  // -----------------------------------------------------------------------
  // Audit routes
  // -----------------------------------------------------------------------

  it('should query audit log via GET /audit', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/api/audit',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: unknown[] };
    expect(body.data).toBeInstanceOf(Array);
  });

  it('should pass query parameters to audit query', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/api/audit?agentId=agent-1&eventType=policy_decision',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // 404 for unknown routes
  // -----------------------------------------------------------------------

  it('should return 404 for unknown routes', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/unknown/route',
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  // -----------------------------------------------------------------------
  // WebSocket still works on the same port
  // -----------------------------------------------------------------------

  it('should still accept WebSocket connections on the same port', async () => {
    await startCenter();

    // Use the ws library to connect via WebSocket.
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        // Send auth message.
        ws.send(JSON.stringify({ type: 'auth', id: 'auth-1', token: 'valid-token' }));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'response' && msg.payload?.success) {
          ws.close();
          resolve();
        } else {
          reject(new Error(`Unexpected message: ${JSON.stringify(msg)}`));
        }
      });
      ws.on('error', reject);
      // Timeout after 3 seconds.
      setTimeout(() => reject(new Error('WebSocket connection timeout')), 3000);
    });
  });

  // -----------------------------------------------------------------------
  // address getter
  // -----------------------------------------------------------------------

  it('should return null address when not running', () => {
    cc = new CommandCenter({ port: 0 });
    expect(cc.address).toBeNull();
  });

  it('should return a valid address when running', async () => {
    await startCenter();
    const addr = cc!.address;
    expect(addr).not.toBeNull();
    expect(addr!.port).toBeGreaterThan(0);
  });
});
