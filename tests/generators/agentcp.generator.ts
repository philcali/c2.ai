import fc from 'fast-check';
import type { AgentCPRequest, AgentCPCapabilities, AgentCPMethod } from '../../src/interfaces/agentcp-bridge.js';

const AGENTCP_METHODS: AgentCPMethod[] = [
  'session/initialize',
  'session/new',
  'session/prompt',
  'session/update',
  'session/cancel',
  'permission/request',
  'permission/response',
];

export const arbitraryAgentCPRequest = (): fc.Arbitrary<AgentCPRequest> =>
  fc.record({
    jsonrpc: fc.constant('2.0' as const),
    id: fc.oneof(
      fc.uuid(),
      fc.integer({ min: 1, max: 1_000_000 }),
    ),
    method: fc.constantFrom(...AGENTCP_METHODS),
    params: fc.option(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { minKeys: 1, maxKeys: 5 }
      ),
      { nil: undefined }
    ),
  });

export const arbitraryAgentCPCapabilities = (): fc.Arbitrary<AgentCPCapabilities> =>
  fc.record({
    canWriteFiles: fc.boolean(),
    canExecuteCommands: fc.boolean(),
    allowedPaths: fc.option(
      fc.array(
        fc.constantFrom('/home/user', '/tmp', '/var/data', '/workspace', '/opt/app'),
        { minLength: 1, maxLength: 4 }
      ),
      { nil: undefined }
    ),
    allowedCommands: fc.option(
      fc.array(
        fc.constantFrom('ls', 'cat', 'grep', 'npm', 'node', 'git', 'echo', 'pwd'),
        { minLength: 1, maxLength: 5 }
      ),
      { nil: undefined }
    ),
  });

export const arbitraryInvalidAgentCPRequest = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.oneof(
    // Missing jsonrpc field
    fc.record({
      id: fc.oneof(fc.uuid(), fc.integer({ min: 1, max: 1000 })),
      method: fc.constantFrom(...AGENTCP_METHODS),
    }),
    // Wrong jsonrpc version
    fc.record({
      jsonrpc: fc.constantFrom('1.0', '3.0', ''),
      id: fc.oneof(fc.uuid(), fc.integer({ min: 1, max: 1000 })),
      method: fc.constantFrom(...AGENTCP_METHODS),
    }),
    // Missing method
    fc.record({
      jsonrpc: fc.constant('2.0'),
      id: fc.oneof(fc.uuid(), fc.integer({ min: 1, max: 1000 })),
    }),
    // Invalid method
    fc.record({
      jsonrpc: fc.constant('2.0'),
      id: fc.oneof(fc.uuid(), fc.integer({ min: 1, max: 1000 })),
      method: fc.constantFrom('invalid/method', 'foo', '', 'session/unknown'),
    }),
    // Missing id
    fc.record({
      jsonrpc: fc.constant('2.0'),
      method: fc.constantFrom(...AGENTCP_METHODS),
    }),
  );
