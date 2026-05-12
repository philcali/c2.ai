import fc from 'fast-check';
import type {
  IntegrationProtocol,
  AgentHealthStatus,
  AgentConnectionConfig,
  ProcessSpawnParams,
  WebSocketParams,
  ACPRestParams,
  ConnectedAgent,
} from '../../src/interfaces/agent-connector.js';
import { arbitraryAgentManifest } from './manifest.generator.js';

/** Generate a random IntegrationProtocol */
export const arbitraryIntegrationProtocol = (): fc.Arbitrary<IntegrationProtocol> =>
  fc.constantFrom('process-spawn', 'websocket', 'acp-rest');

/** Generate a random AgentHealthStatus */
export const arbitraryAgentHealthStatus = (): fc.Arbitrary<AgentHealthStatus> =>
  fc.constantFrom('healthy', 'degraded', 'unresponsive');

/** Generate process-spawn connection parameters */
export const arbitraryProcessSpawnParams = (): fc.Arbitrary<ProcessSpawnParams> =>
  fc.record({
    command: fc.constantFrom('node', 'python', 'npx', 'uvx', '/usr/bin/agent'),
    args: fc.option(
      fc.array(
        fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
        { minLength: 1, maxLength: 5 }
      ),
      { nil: undefined }
    ),
    cwd: fc.option(
      fc.constantFrom('/workspace', '/home/user/project', '/tmp/sandbox', '/opt/app'),
      { nil: undefined }
    ),
    env: fc.option(
      fc.dictionary(
        fc.constantFrom('NODE_ENV', 'DEBUG', 'LOG_LEVEL', 'AGENT_MODE'),
        fc.constantFrom('development', 'production', 'true', 'false', 'info', 'debug'),
        { minKeys: 0, maxKeys: 3 }
      ),
      { nil: undefined }
    ),
  });

/** Generate WebSocket connection parameters */
export const arbitraryWebSocketParams = (): fc.Arbitrary<WebSocketParams> =>
  fc.record({
    url: fc.constantFrom(
      'ws://localhost:8080',
      'ws://localhost:3000/agent',
      'wss://agent.example.com/ws',
      'ws://127.0.0.1:9090/connect',
    ),
    headers: fc.option(
      fc.dictionary(
        fc.constantFrom('Authorization', 'X-Agent-Id', 'X-Request-Id'),
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        { minKeys: 1, maxKeys: 3 }
      ),
      { nil: undefined }
    ),
  });

/** Generate ACP REST connection parameters */
export const arbitraryACPRestParams = (): fc.Arbitrary<ACPRestParams> =>
  fc.record({
    agentUrl: fc.constantFrom(
      'http://localhost:8080',
      'https://agent.example.com/api',
      'http://127.0.0.1:3000',
      'https://acp-agent.internal:443',
    ),
  });

/** Generate protocol-specific connection params matching a given protocol */
export const arbitraryConnectionParamsForProtocol = (
  protocol: IntegrationProtocol,
): fc.Arbitrary<ProcessSpawnParams | WebSocketParams | ACPRestParams> => {
  switch (protocol) {
    case 'process-spawn':
      return arbitraryProcessSpawnParams();
    case 'websocket':
      return arbitraryWebSocketParams();
    case 'acp-rest':
      return arbitraryACPRestParams();
  }
};

/** Generate a valid AgentConnectionConfig */
export const arbitraryAgentConnectionConfig = (): fc.Arbitrary<AgentConnectionConfig> =>
  arbitraryIntegrationProtocol().chain(protocol =>
    fc.record({
      agentId: fc.uuid(),
      protocol: fc.constant(protocol),
      manifest: arbitraryAgentManifest(),
      operatorId: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      connectionParams: arbitraryConnectionParamsForProtocol(protocol),
      heartbeatIntervalMs: fc.option(
        fc.integer({ min: 1000, max: 120_000 }),
        { nil: undefined }
      ),
      heartbeatTimeoutCount: fc.option(
        fc.integer({ min: 1, max: 10 }),
        { nil: undefined }
      ),
      maxReconnectAttempts: fc.option(
        fc.integer({ min: 0, max: 10 }),
        { nil: undefined }
      ),
    })
  );

/**
 * Generate a sequence of heartbeat events (true = heartbeat received, false = missed).
 * Useful for testing the agent health state machine.
 */
export const arbitraryHeartbeatSequence = (): fc.Arbitrary<boolean[]> =>
  fc.array(fc.boolean(), { minLength: 1, maxLength: 30 });

/**
 * Generate a pool of connected agents with varying health states and busy/idle status.
 * Useful for testing agent selection and capability matching.
 */
export const arbitraryAgentPool = (): fc.Arbitrary<ConnectedAgent[]> =>
  fc.array(
    fc.record({
      agentId: fc.uuid(),
      sessionId: fc.uuid(),
      protocol: arbitraryIntegrationProtocol(),
      healthStatus: arbitraryAgentHealthStatus(),
      connectedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
      lastHeartbeat: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
      currentTaskId: fc.option(fc.uuid(), { nil: undefined }),
    }),
    { minLength: 0, maxLength: 10 }
  );
