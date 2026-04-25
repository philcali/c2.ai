# C2 AI Command Center

A server-side TypeScript/Node.js system that orchestrates multiple AI agent sessions with strict security isolation, shared memory, inter-agent communication, and centralized policy enforcement.

## Overview

C2 acts as a central command center for multi-agent workflows. Every agent runs inside an isolation boundary, every operation is policy-checked, and all external service access is mediated through an MCP Gateway. The system follows a security-first, default-deny architecture inspired by NemoClaw's OpenShell model.

### Key capabilities

- **Multi-session lifecycle management** — create, monitor, pause, resume, and terminate agent sessions
- **Isolation boundaries** — each agent is restricted to the permissions declared in its manifest
- **Shared memory store** — namespaced, policy-controlled persistent storage across agents
- **Agent-to-agent communication** — point-to-point and broadcast messaging with bilateral policy checks
- **MCP Gateway** — all external service access (GitHub, APIs) flows through a single authorization gateway
- **Policy Engine** — declarative access policies with default-deny, versioning, and rollback
- **Audit Log** — append-only, queryable record of every action and policy decision
- **Anti-leakage safeguards** — credential scanning, response sanitization, transitive escalation prevention

### Protocol integrations

- **Agent Communication Protocol (ACP)** — IBM/BeeAI Linux Foundation standard for REST-based agent-to-agent communication. Enables heterogeneous agents (LangChain, CrewAI, custom) to interoperate via standardized task lifecycle.
- **Agent Client Protocol (AgentCP)** — Zed Industries standard for agent-to-editor communication via JSON-RPC 2.0 over stdin/stdout. Enables IDE-integrated coding agent sessions (Zed, Neovim, JetBrains).

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9

## Installation

```bash
git clone <repository-url>
cd c2-ai-command-center
npm install
```

## Building

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

## Running

```typescript
import { CommandCenter } from './src/index.js';

const cc = new CommandCenter({
  port: 9000,
  maxConcurrentSessions: 10,
  maxMessageSize: 1_048_576, // 1 MB
  authenticate: (token) => {
    // Return operator credentials if valid, undefined if not
    if (token === 'my-secret-token') {
      return { operatorId: 'admin', permissions: ['admin'] };
    }
    return undefined;
  },
});

await cc.start();
console.log('C2 Command Center running on port 9000');

// Graceful shutdown
process.on('SIGINT', async () => {
  await cc.stop();
});
```

### Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `8080` | Port for the HTTP/WebSocket server |
| `maxConcurrentSessions` | `number` | — | Maximum number of concurrent agent sessions |
| `maxMessageSize` | `number` | — | Maximum message size in bytes for the Communication Bus |
| `heartbeatIntervalMs` | `number` | — | WebSocket keepalive heartbeat interval in milliseconds |
| `authenticate` | `function` | rejects all | Authentication function for operator connections |

### Exposed interfaces

Once started, the Command Center exposes:

- **REST API** — session lifecycle, policy management, memory administration, audit queries
- **WebSocket** — real-time bidirectional communication, event subscriptions, audit streaming
- **ACP endpoints** — agent registration, task submission, status polling, SSE streaming, cancellation

## Testing

```bash
# Run all tests (property, unit, and integration)
npm test

# Run tests in watch mode
npm run test:watch

# Type-check without emitting
npm run typecheck
```

### Test suite breakdown

| Category | Files | Description |
|---|---|---|
| Property tests | `tests/property/*.property.test.ts` | Correctness properties validated with [fast-check](https://github.com/dubzzz/fast-check) |
| Unit tests | `tests/unit/*.test.ts` | Subsystem-level tests for specific scenarios and edge cases |
| Integration tests | `tests/integration/*.test.ts` | End-to-end workflow tests across subsystems |
| Generators | `tests/generators/*.generator.ts` | Shared fast-check arbitraries for manifests, policies, messages, etc. |

## Architecture

```
src/
├── command-center.ts          # Main orchestrator — wires all subsystems
├── index.ts                   # Public API exports
├── errors/                    # Shared error types and codes
│   ├── c2-error.ts
│   ├── error-codes.ts
│   └── error-response.ts
├── interfaces/                # TypeScript interfaces for each subsystem
│   ├── session-manager.ts
│   ├── policy-engine.ts
│   ├── memory-store.ts
│   ├── communication-bus.ts
│   ├── mcp-gateway.ts
│   ├── audit-log.ts
│   ├── operator-interface.ts
│   ├── anti-leakage.ts
│   ├── manifest-validator.ts
│   ├── acp-adapter.ts
│   ├── agentcp-bridge.ts
│   └── agent-discovery-registry.ts
└── subsystems/                # Implementations
    ├── audit-log.ts
    ├── policy-engine.ts
    ├── manifest-validator.ts
    ├── session-manager.ts
    ├── memory-store.ts
    ├── anti-leakage.ts
    ├── communication-bus.ts
    ├── mcp-gateway.ts
    ├── agent-discovery-registry.ts
    ├── acp-adapter.ts
    ├── agentcp-bridge.ts
    └── operator-interface.ts
```

### Subsystem dependency graph

All subsystems run in-process for low-latency policy evaluation. Dependencies are injected at construction time by the `CommandCenter` orchestrator.

```
Audit Log          ← used by all subsystems for event recording
Policy Engine      ← used by Session Manager, Memory Store, Communication Bus,
                     MCP Gateway, ACP Adapter, AgentCP Bridge
Anti-Leakage       ← used by Communication Bus, MCP Gateway
Session Manager    ← used by AgentCP Bridge, Operator Interface
Memory Store       ← used by Operator Interface
Communication Bus  ← used by ACP Adapter, Operator Interface
MCP Gateway        ← used by AgentCP Bridge
Agent Discovery    ← used by ACP Adapter
ACP Adapter        ← exposed via REST endpoints
AgentCP Bridge     ← accepts stdin/stdout IDE connections
Operator Interface ← handles REST + WebSocket connections
```

## License

See [LICENSE](LICENSE) for details.
