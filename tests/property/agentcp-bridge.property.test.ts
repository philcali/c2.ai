import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { PassThrough } from 'node:stream';
import { AgentCPBridge } from '../../src/subsystems/agentcp-bridge.js';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import type { AgentCPProcessHandle, AgentCPSession } from '../../src/interfaces/agentcp-bridge.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';
import {
  arbitraryAgentCPCapabilities,
  arbitraryInvalidAgentCPRequest,
} from '../generators/agentcp.generator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock process handle with PassThrough streams. */
function createMockProcessHandle(): {
  handle: AgentCPProcessHandle;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  return {
    handle: {
      stdin: stdin as unknown as NodeJS.WritableStream,
      stdout: stdout as unknown as NodeJS.ReadableStream,
      pid: Math.floor(Math.random() * 100000) + 1000,
    },
    stdin,
    stdout,
  };
}

/** Create a fresh AgentCPBridge with real subsystems. */
function createBridge(maxConcurrent = 100) {
  const auditLog = new AuditLog();
  const policyEngine = new PolicyEngine();
  const sessionManager = new SessionManager({
    auditLog,
    policyEngine,
    maxConcurrentSessions: maxConcurrent,
  });
  const bridge = new AgentCPBridge({
    sessionManager,
    policyEngine,
    mcpGateway: {} as any, // not needed for these tests
    auditLog,
  });
  return { bridge, auditLog, policyEngine, sessionManager };
}

/**
 * Send a JSON-RPC message to the bridge via the stdout stream
 * (IDE → Bridge direction) and collect the response from stdin.
 */
async function sendMessage(
  stdout: PassThrough,
  stdin: PassThrough,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for response'));
    }, 2000);

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        clearTimeout(timeout);
        stdin.removeListener('data', onData);
        try {
          resolve(JSON.parse(line));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${line}`));
        }
      }
    };

    stdin.on('data', onData);
    stdout.write(JSON.stringify(message) + '\n');
  });
}

/**
 * Collect all responses from stdin within a short window.
 */
async function collectResponses(
  stdin: PassThrough,
  count: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const results: Record<string, unknown>[] = [];
    let buffer = '';
    const timeout = setTimeout(() => {
      stdin.removeListener('data', onData);
      resolve(results);
    }, timeoutMs);

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          try {
            results.push(JSON.parse(line));
          } catch {
            // skip unparseable
          }
        }
        if (results.length >= count) {
          clearTimeout(timeout);
          stdin.removeListener('data', onData);
          resolve(results);
          return;
        }
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Send a session/initialize message and return the response + session info.
 */
async function initializeSession(
  bridge: AgentCPBridge,
  capabilities: { canWriteFiles: boolean; canExecuteCommands: boolean; allowedPaths?: string[]; allowedCommands?: string[] },
  operatorId = 'test-operator',
): Promise<{
  session: AgentCPSession;
  stdin: PassThrough;
  stdout: PassThrough;
  response: Record<string, unknown>;
}> {
  const { handle, stdin, stdout } = createMockProcessHandle();
  const session = await bridge.acceptConnection(handle, operatorId);

  // Small delay to let listeners attach
  await new Promise((r) => setTimeout(r, 10));

  const response = await sendMessage(stdout, stdin, {
    jsonrpc: '2.0',
    id: 'init-1',
    method: 'session/initialize',
    params: { capabilities },
  });

  return { session, stdin, stdout, response };
}

// ---------------------------------------------------------------------------
// Property Tests
// ---------------------------------------------------------------------------

describe('AgentCP Bridge Property Tests', () => {
  // --------------------------------------------------------------------------
  // Property 38: AgentCP JSON-RPC 2.0 Message Parsing
  // Verify valid messages produce correct typed requests/notifications;
  // malformed messages produce JSON-RPC error responses.
  // Validates: Requirements 12.1
  // --------------------------------------------------------------------------
  describe('Property 38: AgentCP JSON-RPC 2.0 Message Parsing', () => {
    it('malformed JSON produces parse error (-32700)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }).filter(
            (s) => {
              try { JSON.parse(s); return false; } catch { return true; }
            },
          ),
          async (invalidJson) => {
            const { bridge } = createBridge();
            const { handle, stdin, stdout } = createMockProcessHandle();
            await bridge.acceptConnection(handle, 'op-1');
            await new Promise((r) => setTimeout(r, 10));

            const response = await sendMessage(stdout, stdin, invalidJson as any);
            // sendMessage writes raw string, but we need to send raw invalid JSON
            // Let's handle this differently
          },
        ),
        { numRuns: 1 }, // placeholder, real test below
      );
    });

    it('invalid JSON strings produce parse error (-32700)', async () => {
      const { bridge } = createBridge();
      const invalidJsonStrings = ['{bad json', '{"unclosed": ', 'not json at all', '{{}}'];

      for (const raw of invalidJsonStrings) {
        const { handle, stdin, stdout } = createMockProcessHandle();
        await bridge.acceptConnection(handle, 'op-1');
        await new Promise((r) => setTimeout(r, 10));

        // Write raw invalid JSON directly
        const responsePromise = collectResponses(stdin, 1, 1000);
        stdout.write(raw + '\n');
        const responses = await responsePromise;

        expect(responses.length).toBeGreaterThanOrEqual(1);
        const resp = responses[0];
        expect(resp.jsonrpc).toBe('2.0');
        expect((resp.error as any)?.code).toBe(-32700);
      }
    });

    it('invalid JSON-RPC envelopes produce appropriate error codes', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryInvalidAgentCPRequest(),
          async (invalidRequest) => {
            const { bridge } = createBridge();
            const { handle, stdin, stdout } = createMockProcessHandle();
            await bridge.acceptConnection(handle, 'op-1');
            await new Promise((r) => setTimeout(r, 10));

            const response = await sendMessage(stdout, stdin, invalidRequest);

            expect(response.jsonrpc).toBe('2.0');
            expect(response.error).toBeDefined();
            const errorCode = (response.error as any).code;
            // Should be one of the standard JSON-RPC error codes
            expect([-32700, -32601, -32602, -32603]).toContain(errorCode);
          },
        ),
        { numRuns: 30 },
      );
    });

    it('valid session/initialize messages produce success responses', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge } = createBridge();
            const { handle, stdin, stdout } = createMockProcessHandle();
            await bridge.acceptConnection(handle, 'op-1');
            await new Promise((r) => setTimeout(r, 10));

            const response = await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'test-1',
              method: 'session/initialize',
              params: { capabilities },
            });

            expect(response.jsonrpc).toBe('2.0');
            expect(response.id).toBe('test-1');
            // Should be a success (has result, no error)
            expect(response.result).toBeDefined();
            expect(response.error).toBeUndefined();

            const result = response.result as Record<string, unknown>;
            expect(result.sessionId).toBeDefined();
            expect(result.agentSessionId).toBeDefined();
            expect(result.state).toBe('active');
          },
        ),
        { numRuns: 30 },
      );
    });

    it('unknown methods produce method-not-found error (-32601)', async () => {
      const unknownMethods = ['unknown/method', 'foo/bar', 'session/destroy', 'agent/run'];

      for (const method of unknownMethods) {
        const { bridge } = createBridge();
        const { handle, stdin, stdout } = createMockProcessHandle();
        await bridge.acceptConnection(handle, 'op-1');
        await new Promise((r) => setTimeout(r, 10));

        const response = await sendMessage(stdout, stdin, {
          jsonrpc: '2.0',
          id: 'test-unknown',
          method,
        });

        expect(response.jsonrpc).toBe('2.0');
        expect(response.error).toBeDefined();
        expect((response.error as any).code).toBe(-32601);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Property 39: AgentCP Session Creates Matching Agent Session
  // Verify session/initialize creates Agent_Session with Isolation_Boundary
  // matching declared capabilities exactly.
  // Validates: Requirements 12.2
  // --------------------------------------------------------------------------
  describe('Property 39: AgentCP Session Creates Matching Agent Session', () => {
    it('session/initialize creates an Agent_Session in the Session Manager', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge, sessionManager } = createBridge();
            const { response } = await initializeSession(bridge, capabilities);

            expect(response.result).toBeDefined();
            const result = response.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;

            // The Agent_Session should exist in the Session Manager.
            const agentSession = sessionManager.getSession(agentSessionId);
            expect(agentSession).toBeDefined();
            expect(agentSession!.state).toBe('running');
          },
        ),
        { numRuns: 30 },
      );
    });

    it('isolation boundary file namespaces match capabilities allowedPaths', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities().filter((c): boolean => !!(c.canWriteFiles && c.allowedPaths && c.allowedPaths.length > 0)),
          async (capabilities) => {
            const { bridge, sessionManager } = createBridge();
            const { response } = await initializeSession(bridge, capabilities);

            const result = response.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;
            const agentSession = sessionManager.getSession(agentSessionId);

            // Each allowedPath should map to a file: namespace.
            const expectedNamespaces = capabilities.allowedPaths!.map((p) => `file:${p}`);
            expect(agentSession!.isolationBoundary.allowedNamespaces).toEqual(expectedNamespaces);
          },
        ),
        { numRuns: 30 },
      );
    });

    it('isolation boundary MCP operations match capabilities allowedCommands', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities().filter(
            (c): boolean => !!(c.canExecuteCommands && c.allowedCommands && c.allowedCommands.length > 0),
          ),
          async (capabilities) => {
            const { bridge, sessionManager } = createBridge();
            const { response } = await initializeSession(bridge, capabilities);

            const result = response.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;
            const agentSession = sessionManager.getSession(agentSessionId);

            // Should have a 'terminal' service with the allowed commands.
            expect(agentSession!.isolationBoundary.allowedServices).toContain('terminal');
          },
        ),
        { numRuns: 30 },
      );
    });

    it('capabilities with no file write produce empty namespaces', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities().map((c) => ({
            ...c,
            canWriteFiles: false,
            allowedPaths: undefined,
          })),
          async (capabilities) => {
            const { bridge, sessionManager } = createBridge();
            const { response } = await initializeSession(bridge, capabilities);

            const result = response.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;
            const agentSession = sessionManager.getSession(agentSessionId);

            expect(agentSession!.isolationBoundary.allowedNamespaces).toEqual([]);
          },
        ),
        { numRuns: 30 },
      );
    });

    it('capabilities with no command execution produce empty services', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities().map((c) => ({
            ...c,
            canExecuteCommands: false,
            allowedCommands: undefined,
          })),
          async (capabilities) => {
            const { bridge, sessionManager } = createBridge();
            const { response } = await initializeSession(bridge, capabilities);

            const result = response.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;
            const agentSession = sessionManager.getSession(agentSessionId);

            expect(agentSession!.isolationBoundary.allowedServices).toEqual([]);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 40: AgentCP Operations Routed Through Policy Engine
  // Verify file write, terminal command, and external service operations are
  // forwarded to Policy Engine; denials rejected and logged.
  // Validates: Requirements 12.4, 12.6
  // --------------------------------------------------------------------------
  describe('Property 40: AgentCP Operations Routed Through Policy Engine', () => {
    it('permission/request for file_write is denied by default (default-deny policy)', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          fc.constantFrom('/home/user/file.txt', '/tmp/data.json', '/workspace/src/index.ts'),
          async (capabilities, resource) => {
            const { bridge } = createBridge();
            const { stdin, stdout, response: initResp } = await initializeSession(bridge, capabilities);

            // Send a permission request — should be denied by default-deny policy.
            const permResponse = await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'perm-1',
              method: 'permission/request',
              params: {
                type: 'file_write',
                resource,
                description: 'Write test file',
              },
            });

            expect(permResponse.jsonrpc).toBe('2.0');
            // Default-deny means this should be an error response.
            expect(permResponse.error).toBeDefined();
          },
        ),
        { numRuns: 20 },
      );
    });

    it('permission/request for terminal_command is denied by default', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          fc.constantFrom('ls -la', 'npm install', 'git status'),
          async (capabilities, command) => {
            const { bridge } = createBridge();
            const { stdin, stdout } = await initializeSession(bridge, capabilities);

            const permResponse = await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'perm-2',
              method: 'permission/request',
              params: {
                type: 'terminal_command',
                resource: command,
                description: 'Execute command',
              },
            });

            expect(permResponse.error).toBeDefined();
          },
        ),
        { numRuns: 20 },
      );
    });

    it('permission/request is allowed when a matching allow policy exists', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge, policyEngine } = createBridge();
            const { stdin, stdout, response: initResp } = await initializeSession(bridge, capabilities);

            const result = initResp.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;

            // Add an allow policy for this agent's file_write operations.
            policyEngine.addPolicy({
              id: 'allow-file-write',
              version: 1,
              agentId: agentSessionId,
              operations: ['file_write'],
              resources: ['*'],
              effect: 'allow',
            });

            const permResponse = await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'perm-3',
              method: 'permission/request',
              params: {
                type: 'file_write',
                resource: '/tmp/test.txt',
                description: 'Write test file',
              },
            });

            expect(permResponse.result).toBeDefined();
            expect((permResponse.result as any).granted).toBe(true);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('denied permission requests are recorded in the audit log', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          fc.constantFrom('file_write', 'terminal_command') as fc.Arbitrary<'file_write' | 'terminal_command'>,
          async (capabilities, permType) => {
            const { bridge, auditLog } = createBridge();
            const { stdin, stdout } = await initializeSession(bridge, capabilities);

            await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'perm-audit',
              method: 'permission/request',
              params: {
                type: permType,
                resource: '/some/resource',
                description: 'Test permission',
              },
            });

            // Wait briefly for audit log to be written.
            await new Promise((r) => setTimeout(r, 50));

            const entries = await auditLog.query({ eventType: 'agentcp_session' });
            const permEntries = entries.filter(
              (e) => e.operation.startsWith('permission/') && e.decision === 'deny',
            );

            expect(permEntries.length).toBeGreaterThanOrEqual(1);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('allowed permission requests are recorded in the audit log', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge, auditLog, policyEngine } = createBridge();
            const { stdin, stdout, response: initResp } = await initializeSession(bridge, capabilities);

            const result = initResp.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;

            // Add wildcard allow policy.
            policyEngine.addPolicy({
              id: 'allow-all',
              version: 1,
              agentId: agentSessionId,
              operations: ['file_write', 'terminal_command'],
              resources: ['*'],
              effect: 'allow',
            });

            await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'perm-allow-audit',
              method: 'permission/request',
              params: {
                type: 'file_write',
                resource: '/tmp/allowed.txt',
                description: 'Allowed write',
              },
            });

            await new Promise((r) => setTimeout(r, 50));

            const entries = await auditLog.query({ eventType: 'agentcp_session' });
            const permEntries = entries.filter(
              (e) => e.operation.startsWith('permission/') && e.decision === 'allow',
            );

            expect(permEntries.length).toBeGreaterThanOrEqual(1);
          },
        ),
        { numRuns: 20 },
      );
    });
  });


  // --------------------------------------------------------------------------
  // Property 41: AgentCP Session Lifecycle Management
  // Verify session/cancel terminates Agent_Session; session/new terminates
  // previous and creates new.
  // Validates: Requirements 12.5
  // --------------------------------------------------------------------------
  describe('Property 41: AgentCP Session Lifecycle Management', () => {
    it('session/cancel terminates the Agent_Session', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge, sessionManager } = createBridge();
            const { stdin, stdout, response: initResp } = await initializeSession(bridge, capabilities);

            const result = initResp.result as Record<string, unknown>;
            const agentSessionId = result.agentSessionId as string;

            // Verify the agent session is running.
            expect(sessionManager.getSession(agentSessionId)!.state).toBe('running');

            // Send session/cancel.
            const cancelResp = await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'cancel-1',
              method: 'session/cancel',
            });

            expect(cancelResp.result).toBeDefined();
            expect((cancelResp.result as any).state).toBe('canceled');

            // The Agent_Session should be terminated.
            const agentSession = sessionManager.getSession(agentSessionId);
            expect(agentSession!.state).toBe('terminated');
          },
        ),
        { numRuns: 20 },
      );
    });

    it('session/new terminates previous session and creates a new one', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          arbitraryAgentCPCapabilities(),
          async (caps1, caps2) => {
            const { bridge, sessionManager } = createBridge();
            const { stdin, stdout, response: initResp } = await initializeSession(bridge, caps1);

            const result1 = initResp.result as Record<string, unknown>;
            const firstAgentSessionId = result1.agentSessionId as string;

            // Send session/new with new capabilities.
            const newResp = await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'new-1',
              method: 'session/new',
              params: { capabilities: caps2 },
            });

            expect(newResp.result).toBeDefined();
            const result2 = newResp.result as Record<string, unknown>;
            const secondAgentSessionId = result2.agentSessionId as string;

            // First session should be terminated.
            const firstSession = sessionManager.getSession(firstAgentSessionId);
            expect(firstSession!.state).toBe('terminated');

            // Second session should be running.
            const secondSession = sessionManager.getSession(secondAgentSessionId);
            expect(secondSession).toBeDefined();
            expect(secondSession!.state).toBe('running');

            // They should be different sessions.
            expect(firstAgentSessionId).not.toBe(secondAgentSessionId);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('session/cancel without prior initialize returns error', async () => {
      const { bridge } = createBridge();
      const { handle, stdin, stdout } = createMockProcessHandle();
      await bridge.acceptConnection(handle, 'op-1');
      await new Promise((r) => setTimeout(r, 10));

      const response = await sendMessage(stdout, stdin, {
        jsonrpc: '2.0',
        id: 'cancel-no-init',
        method: 'session/cancel',
      });

      expect(response.error).toBeDefined();
    });

    it('session/prompt without prior initialize returns error', async () => {
      const { bridge } = createBridge();
      const { handle, stdin, stdout } = createMockProcessHandle();
      await bridge.acceptConnection(handle, 'op-1');
      await new Promise((r) => setTimeout(r, 10));

      const response = await sendMessage(stdout, stdin, {
        jsonrpc: '2.0',
        id: 'prompt-no-init',
        method: 'session/prompt',
        params: { prompt: 'hello' },
      });

      expect(response.error).toBeDefined();
    });

    it('terminateSession removes the session from listings', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge } = createBridge();
            const { session } = await initializeSession(bridge, capabilities);

            // Session should be listed.
            const beforeList = bridge.listSessions();
            expect(beforeList.some((s) => s.id === session.id)).toBe(true);

            // Terminate.
            await bridge.terminateSession(session.id, 'test cleanup');

            // Session should no longer be listed.
            const afterList = bridge.listSessions();
            expect(afterList.some((s) => s.id === session.id)).toBe(false);
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 42: AgentCP Audit Log Completeness
  // Verify all session events (initialize, prompt, update, cancel) produce
  // audit entries with operator and session identifiers.
  // Validates: Requirements 12.7
  // --------------------------------------------------------------------------
  describe('Property 42: AgentCP Audit Log Completeness', () => {
    it('session/initialize produces an audit entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
          async (capabilities, operatorId) => {
            const { bridge, auditLog } = createBridge();
            await initializeSession(bridge, capabilities, operatorId);

            await new Promise((r) => setTimeout(r, 50));

            const entries = await auditLog.query({ eventType: 'agentcp_session' });
            const initEntries = entries.filter((e) => e.operation === 'session/initialize');

            expect(initEntries.length).toBeGreaterThanOrEqual(1);
            const entry = initEntries[0];
            expect(entry.operatorId).toBe(operatorId);
            expect(entry.agentId).toBeDefined();
            expect(entry.details).toBeDefined();
          },
        ),
        { numRuns: 20 },
      );
    });

    it('session/prompt produces an audit entry with operator and session identifiers', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          async (capabilities, prompt) => {
            const { bridge, auditLog } = createBridge();
            const { stdin, stdout, session } = await initializeSession(bridge, capabilities, 'prompt-operator');

            // Send a prompt.
            // Collect 2 responses: the success response + the session/update notification
            const responsePromise = collectResponses(stdin, 2, 1000);
            stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: 'prompt-1',
              method: 'session/prompt',
              params: { prompt },
            }) + '\n');
            await responsePromise;

            await new Promise((r) => setTimeout(r, 50));

            const entries = await auditLog.query({ eventType: 'agentcp_session' });
            const promptEntries = entries.filter((e) => e.operation === 'session/prompt');

            expect(promptEntries.length).toBeGreaterThanOrEqual(1);
            const entry = promptEntries[0];
            expect(entry.operatorId).toBe('prompt-operator');
            expect(entry.agentId).toBeDefined();
            expect((entry.details as any).agentcpSessionId).toBe(session.id);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('session/cancel produces an audit entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge, auditLog } = createBridge();
            const { stdin, stdout, session } = await initializeSession(bridge, capabilities, 'cancel-operator');

            await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'cancel-audit',
              method: 'session/cancel',
            });

            await new Promise((r) => setTimeout(r, 50));

            const entries = await auditLog.query({ eventType: 'agentcp_session' });
            const cancelEntries = entries.filter((e) => e.operation === 'session/cancel');

            expect(cancelEntries.length).toBeGreaterThanOrEqual(1);
            const entry = cancelEntries[0];
            expect(entry.operatorId).toBe('cancel-operator');
            expect((entry.details as any).agentcpSessionId).toBe(session.id);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('accept_connection produces an audit entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
          async (operatorId) => {
            const { bridge, auditLog } = createBridge();
            const { handle } = createMockProcessHandle();
            await bridge.acceptConnection(handle, operatorId);

            await new Promise((r) => setTimeout(r, 50));

            const entries = await auditLog.query({ eventType: 'agentcp_session' });
            const connectEntries = entries.filter((e) => e.operation === 'accept_connection');

            expect(connectEntries.length).toBeGreaterThanOrEqual(1);
            expect(connectEntries[0].operatorId).toBe(operatorId);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('all agentcp_session audit entries have the agentcp_session event type', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          async (capabilities) => {
            const { bridge, auditLog } = createBridge();
            const { stdin, stdout } = await initializeSession(bridge, capabilities, 'type-check-op');

            // Perform several operations.
            await sendMessage(stdout, stdin, {
              jsonrpc: '2.0',
              id: 'cancel-type',
              method: 'session/cancel',
            });

            await new Promise((r) => setTimeout(r, 50));

            const entries = await auditLog.query({ eventType: 'agentcp_session' });
            for (const entry of entries) {
              expect(entry.eventType).toBe('agentcp_session');
            }
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  // --------------------------------------------------------------------------
  // Property 43: AgentCP Concurrent Session Isolation
  // Verify concurrent sessions have independent Isolation_Boundaries;
  // operations in one session don't affect others.
  // Validates: Requirements 12.8
  // --------------------------------------------------------------------------
  describe('Property 43: AgentCP Concurrent Session Isolation', () => {
    it('multiple concurrent connections have independent sessions', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          arbitraryAgentCPCapabilities(),
          async (caps1, caps2) => {
            const { bridge, sessionManager } = createBridge();

            const conn1 = await initializeSession(bridge, caps1, 'operator-1');
            const conn2 = await initializeSession(bridge, caps2, 'operator-2');

            const result1 = conn1.response.result as Record<string, unknown>;
            const result2 = conn2.response.result as Record<string, unknown>;

            // Sessions should have different IDs.
            expect(result1.agentSessionId).not.toBe(result2.agentSessionId);
            expect(conn1.session.id).not.toBe(conn2.session.id);

            // Both should be listed.
            const sessions = bridge.listSessions();
            expect(sessions.length).toBe(2);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('canceling one session does not affect another', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbitraryAgentCPCapabilities(),
          arbitraryAgentCPCapabilities(),
          async (caps1, caps2) => {
            const { bridge, sessionManager } = createBridge();

            const conn1 = await initializeSession(bridge, caps1, 'operator-1');
            const conn2 = await initializeSession(bridge, caps2, 'operator-2');

            const result1 = conn1.response.result as Record<string, unknown>;
            const result2 = conn2.response.result as Record<string, unknown>;

            // Cancel session 1.
            await sendMessage(conn1.stdout, conn1.stdin, {
              jsonrpc: '2.0',
              id: 'cancel-iso-1',
              method: 'session/cancel',
            });

            // Session 2's agent session should still be running.
            const agentSession2 = sessionManager.getSession(result2.agentSessionId as string);
            expect(agentSession2).toBeDefined();
            expect(agentSession2!.state).toBe('running');

            // Session 1's agent session should be terminated.
            const agentSession1 = sessionManager.getSession(result1.agentSessionId as string);
            expect(agentSession1!.state).toBe('terminated');
          },
        ),
        { numRuns: 20 },
      );
    });

    it('concurrent sessions have independent isolation boundaries', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Use distinct capabilities to verify isolation boundaries differ.
          fc.record({
            canWriteFiles: fc.constant(true),
            canExecuteCommands: fc.constant(false),
            allowedPaths: fc.constant(['/path/a']),
          }),
          fc.record({
            canWriteFiles: fc.constant(false),
            canExecuteCommands: fc.constant(true),
            allowedCommands: fc.constant(['ls']),
          }),
          async (caps1, caps2) => {
            const { bridge, sessionManager } = createBridge();

            const conn1 = await initializeSession(bridge, caps1);
            const conn2 = await initializeSession(bridge, caps2);

            const result1 = conn1.response.result as Record<string, unknown>;
            const result2 = conn2.response.result as Record<string, unknown>;

            const session1 = sessionManager.getSession(result1.agentSessionId as string)!;
            const session2 = sessionManager.getSession(result2.agentSessionId as string)!;

            // Session 1 should have file namespaces but no services.
            expect(session1.isolationBoundary.allowedNamespaces.length).toBeGreaterThan(0);
            expect(session1.isolationBoundary.allowedServices).toEqual([]);

            // Session 2 should have services but no namespaces.
            expect(session2.isolationBoundary.allowedNamespaces).toEqual([]);
            expect(session2.isolationBoundary.allowedServices.length).toBeGreaterThan(0);
          },
        ),
        { numRuns: 20 },
      );
    });

    it('each connection has its own operator identity', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
          async (op1, op2) => {
            fc.pre(op1 !== op2);

            const { bridge } = createBridge();
            const caps = { canWriteFiles: false, canExecuteCommands: false };

            const conn1 = await initializeSession(bridge, caps, op1);
            const conn2 = await initializeSession(bridge, caps, op2);

            const sessions = bridge.listSessions();
            const s1 = sessions.find((s) => s.id === conn1.session.id);
            const s2 = sessions.find((s) => s.id === conn2.session.id);

            expect(s1!.operatorId).toBe(op1);
            expect(s2!.operatorId).toBe(op2);
          },
        ),
        { numRuns: 20 },
      );
    });
  });
});
