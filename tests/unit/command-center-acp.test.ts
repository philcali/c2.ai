import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { CommandCenter } from '../../src/command-center.js';
import type { OperatorCredentials } from '../../src/subsystems/operator-interface.js';
import type { ACPAgentCard } from '../../src/interfaces/acp-adapter.js';

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
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
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

/** Read an SSE stream and collect events until the connection closes or timeout. */
function sseRequest(
  options: {
    port: number;
    path: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; events: unknown[] }> {
  return new Promise((resolve, reject) => {
    const timeout = options.timeoutMs ?? 3000;
    const events: unknown[] = [];

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: 'GET',
        path: options.path,
        headers: {
          Accept: 'text/event-stream',
          ...options.headers,
        },
      },
      (res) => {
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          // Parse SSE events from the buffer.
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const dataLine = part.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
              try {
                events.push(JSON.parse(dataLine.slice(6)));
              } catch {
                events.push(dataLine.slice(6));
              }
            }
          }
        });

        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, events });
        });
      },
    );

    req.on('error', reject);

    // Safety timeout.
    setTimeout(() => {
      req.destroy();
      resolve({ status: 0, headers: {}, events });
    }, timeout);

    req.end();
  });
}

/** Authenticate function for tests. */
const testAuthenticate = (token: string): OperatorCredentials | undefined => {
  if (token === 'valid-token') {
    return { operatorId: 'op-1', permissions: ['*'] };
  }
  return undefined;
};

/** A valid ACP Agent Card for testing. */
const validAgentCard: ACPAgentCard = {
  name: 'Test Agent',
  description: 'A test agent',
  url: 'http://localhost:3000',
  version: '1.0.0',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: 'skill-1',
      name: 'Test Skill',
      description: 'A test skill',
    },
  ],
  defaultInputContentTypes: ['application/json'],
  defaultOutputContentTypes: ['application/json'],
};

const authHeaders = { Authorization: 'Bearer valid-token' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CommandCenter ACP REST endpoints', () => {
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
  // Authentication — all ACP endpoints require auth
  // -----------------------------------------------------------------------

  it('should return 401 for POST /agents without auth', async () => {
    await startCenter();
    const res = await httpRequest({ port, method: 'POST', path: '/agents', body: validAgentCard });
    expect(res.status).toBe(401);
  });

  it('should return 401 for DELETE /agents/:url without auth', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'DELETE',
      path: `/agents/${encodeURIComponent('http://localhost:3000')}`,
    });
    expect(res.status).toBe(401);
  });

  it('should return 401 for POST /tasks without auth', async () => {
    await startCenter();
    const res = await httpRequest({ port, method: 'POST', path: '/tasks', body: {} });
    expect(res.status).toBe(401);
  });

  it('should return 401 for GET /tasks/:id without auth', async () => {
    await startCenter();
    const res = await httpRequest({ port, method: 'GET', path: '/tasks/some-id' });
    expect(res.status).toBe(401);
  });

  it('should return 401 for POST /tasks/:id/cancel without auth', async () => {
    await startCenter();
    const res = await httpRequest({ port, method: 'POST', path: '/tasks/some-id/cancel', body: {} });
    expect(res.status).toBe(401);
  });

  it('should return 401 for GET /tasks/:id/stream without auth', async () => {
    await startCenter();
    const res = await httpRequest({ port, method: 'GET', path: '/tasks/some-id/stream' });
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // POST /agents — Register an Agent Card
  // -----------------------------------------------------------------------

  it('should register a valid agent card via POST /agents', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/agents',
      headers: authHeaders,
      body: validAgentCard,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { valid: boolean; errors: string[] } };
    expect(body.data.valid).toBe(true);
    expect(body.data.errors).toEqual([]);
  });

  it('should return validation errors for an invalid agent card via POST /agents', async () => {
    await startCenter();
    const invalidCard = { ...validAgentCard, name: '', url: '' };
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/agents',
      headers: authHeaders,
      body: invalidCard,
    });
    // The adapter returns a ValidationResult (not an error), so status is 200.
    expect(res.status).toBe(200);
    const body = res.body as { data: { valid: boolean; errors: string[] } };
    expect(body.data.valid).toBe(false);
    expect(body.data.errors.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // DELETE /agents/:url — Deregister an agent
  // -----------------------------------------------------------------------

  it('should deregister an agent via DELETE /agents/:url', async () => {
    await startCenter();

    // Register first.
    await httpRequest({
      port,
      method: 'POST',
      path: '/agents',
      headers: authHeaders,
      body: validAgentCard,
    });

    // Deregister.
    const encodedUrl = encodeURIComponent(validAgentCard.url);
    const res = await httpRequest({
      port,
      method: 'DELETE',
      path: `/agents/${encodedUrl}`,
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { url: string; removed: boolean } };
    expect(body.data.url).toBe(validAgentCard.url);
    expect(body.data.removed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // POST /tasks — Submit a task
  // -----------------------------------------------------------------------

  it('should submit a task via POST /tasks', async () => {
    await startCenter();

    // Register the target agent first.
    await httpRequest({
      port,
      method: 'POST',
      path: '/agents',
      headers: authHeaders,
      body: validAgentCard,
    });

    // Add a policy to allow task submission.
    cc!.policyEngine.addPolicy({
      id: 'allow-acp-tasks',
      version: 1,
      agentId: '*',
      operations: ['submit_task'],
      resources: ['acp:task:*'],
      effect: 'allow',
    });

    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tasks',
      headers: authHeaders,
      body: {
        targetAgentUrl: validAgentCard.url,
        task: {
          skill: 'skill-1',
          message: {
            type: 'request',
            contentType: 'application/json',
            body: { prompt: 'Hello' },
          },
        },
      },
    });
    expect(res.status).toBe(201);
    const body = res.body as { data: { id: string; status: string; senderId: string } };
    expect(body.data.id).toBeDefined();
    expect(body.data.senderId).toBe('op-1');
  });

  it('should return 400 for POST /tasks with missing fields', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tasks',
      headers: authHeaders,
      body: { targetAgentUrl: 'http://example.com' },
    });
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // GET /tasks/:id — Get task status
  // -----------------------------------------------------------------------

  it('should get task status via GET /tasks/:id', async () => {
    await startCenter();

    // Register agent and add policy.
    await httpRequest({
      port,
      method: 'POST',
      path: '/agents',
      headers: authHeaders,
      body: validAgentCard,
    });
    cc!.policyEngine.addPolicy({
      id: 'allow-acp-tasks',
      version: 1,
      agentId: '*',
      operations: ['submit_task'],
      resources: ['acp:task:*'],
      effect: 'allow',
    });

    // Submit a task.
    const submitRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tasks',
      headers: authHeaders,
      body: {
        targetAgentUrl: validAgentCard.url,
        task: {
          message: {
            type: 'request',
            contentType: 'application/json',
            body: { prompt: 'Hello' },
          },
        },
      },
    });
    const taskId = (submitRes.body as { data: { id: string } }).data.id;

    // Get task status.
    const res = await httpRequest({
      port,
      method: 'GET',
      path: `/tasks/${taskId}`,
      headers: authHeaders,
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { id: string; status: string } };
    expect(body.data.id).toBe(taskId);
  });

  it('should return 404 for GET /tasks/:id with non-existent task', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/tasks/non-existent-id',
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  // -----------------------------------------------------------------------
  // POST /tasks/:id/cancel — Cancel a task
  // -----------------------------------------------------------------------

  it('should cancel a task via POST /tasks/:id/cancel', async () => {
    await startCenter();

    // Register agent and add policy.
    await httpRequest({
      port,
      method: 'POST',
      path: '/agents',
      headers: authHeaders,
      body: validAgentCard,
    });
    cc!.policyEngine.addPolicy({
      id: 'allow-acp-tasks',
      version: 1,
      agentId: '*',
      operations: ['submit_task'],
      resources: ['acp:task:*'],
      effect: 'allow',
    });
    cc!.policyEngine.addPolicy({
      id: 'allow-comm',
      version: 1,
      agentId: '*',
      operations: ['send', 'receive'],
      resources: ['communication:*'],
      effect: 'allow',
    });

    // Submit a task via the adapter directly. The CommunicationBus delivery
    // will fail (no internal session for the external agent URL), so the
    // task will be in 'failed' state. Canceling a terminal-state task
    // should return 400.
    const submitRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tasks',
      headers: authHeaders,
      body: {
        targetAgentUrl: validAgentCard.url,
        task: {
          message: {
            type: 'request',
            contentType: 'application/json',
            body: { prompt: 'Hello' },
          },
        },
      },
    });
    expect(submitRes.status).toBe(201);
    const taskId = (submitRes.body as { data: { id: string } }).data.id;

    // The task is in a terminal state ('failed' due to delivery failure).
    // Canceling it should return 400 because the state machine doesn't
    // allow transitioning from 'failed' to 'canceled'.
    const res = await httpRequest({
      port,
      method: 'POST',
      path: `/tasks/${taskId}/cancel`,
      headers: authHeaders,
      body: { reason: 'No longer needed' },
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('Cannot cancel');
  });

  it('should return 404 when canceling a non-existent task', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/tasks/non-existent-id/cancel',
      headers: authHeaders,
      body: { reason: 'test' },
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------------
  // GET /tasks/:id/stream — Stream task updates via SSE
  // -----------------------------------------------------------------------

  it('should stream task updates via SSE on GET /tasks/:id/stream', async () => {
    await startCenter();

    // Register agent and add policy.
    await httpRequest({
      port,
      method: 'POST',
      path: '/agents',
      headers: authHeaders,
      body: validAgentCard,
    });
    cc!.policyEngine.addPolicy({
      id: 'allow-acp-tasks',
      version: 1,
      agentId: '*',
      operations: ['submit_task'],
      resources: ['acp:task:*'],
      effect: 'allow',
    });
    cc!.policyEngine.addPolicy({
      id: 'allow-comm',
      version: 1,
      agentId: '*',
      operations: ['send', 'receive'],
      resources: ['communication:*'],
      effect: 'allow',
    });

    // Submit a task. It will be in 'failed' state (terminal) because
    // the CommunicationBus can't deliver to an external agent URL.
    const submitRes = await httpRequest({
      port,
      method: 'POST',
      path: '/tasks',
      headers: authHeaders,
      body: {
        targetAgentUrl: validAgentCard.url,
        task: {
          message: {
            type: 'request',
            contentType: 'application/json',
            body: { prompt: 'Hello' },
          },
        },
      },
    });
    const taskId = (submitRes.body as { data: { id: string } }).data.id;

    // Stream the task — since it's already in a terminal state ('failed'),
    // the SSE stream should emit the terminal event and close.
    const sseRes = await sseRequest({
      port,
      path: `/tasks/${taskId}/stream`,
      headers: authHeaders,
      timeoutMs: 2000,
    });

    expect(sseRes.status).toBe(200);
    expect(sseRes.headers['content-type']).toBe('text/event-stream');
    expect(sseRes.headers['cache-control']).toBe('no-cache');
    expect(sseRes.headers['connection']).toBe('keep-alive');
    expect(sseRes.events.length).toBeGreaterThan(0);

    // The event should contain the task's terminal status.
    const lastEvent = sseRes.events[sseRes.events.length - 1] as { taskId: string; status: string };
    expect(lastEvent.taskId).toBe(taskId);
    expect(lastEvent.status).toBe('failed');
  });

  it('should return 404 for GET /tasks/:id/stream with non-existent task', async () => {
    await startCenter();
    const res = await httpRequest({
      port,
      method: 'GET',
      path: '/tasks/non-existent-id/stream',
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});
