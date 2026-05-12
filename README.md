# C2 AI Command Center

A server-side TypeScript/Node.js system that orchestrates multiple AI agent sessions with strict security isolation, shared memory, inter-agent communication, and centralized policy enforcement.

## Overview

C2 acts as a central command center for multi-agent workflows. Every agent runs inside an isolation boundary, every operation is policy-checked, and all external service access is mediated through an MCP Gateway. The system follows a security-first, default-deny architecture inspired by NemoClaw's OpenShell model.

### Key capabilities

- **Closed-loop agent workflows** — connect coding agents, dispatch multi-step tasks, review results, and iterate with retry/redirect
- **Multi-session lifecycle management** — create, monitor, pause, resume, and terminate agent sessions
- **Isolation boundaries** — each agent is restricted to the permissions declared in its manifest
- **Shared memory store** — namespaced, policy-controlled persistent storage across agents
- **Agent-to-agent communication** — point-to-point and broadcast messaging with bilateral policy checks
- **MCP Gateway** — all external service access (GitHub, APIs) flows through a single authorization gateway
- **Policy Engine** — declarative access policies with default-deny, versioning, and rollback
- **Audit Log** — append-only, queryable record of every action and policy decision
- **Anti-leakage safeguards** — credential scanning, response sanitization, transitive escalation prevention
- **External event integration** — webhook and polling support for CI, code review, and other external triggers

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
  corsOrigins: '*', // allow the UI dev server (or any origin) to connect
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
| `corsOrigins` | `string \| string[]` | — | Allowed CORS origins (`'*'` for any, a string for one, or an array for several) |

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

## Wiring a Closed-Loop Agent Workflow

The Agent Integration layer lets you connect external coding agents and run multi-step tasks through a closed loop: **dispatch → execute → review → advance** (or retry / redirect). Here's how to wire it up end-to-end.

### 1. Start the Command Center

```typescript
import { CommandCenter } from './src/index.js';

const cc = new CommandCenter({
  port: 9000,
  corsOrigins: 'http://localhost:5173', // allow the UI dev server
  authenticate: (token) => {
    if (token === 'operator-secret') {
      return { operatorId: 'ops-1', permissions: ['admin'] };
    }
    return undefined;
  },
});

await cc.start();
```

### 2. Connect a coding agent

Each agent connects via one of three protocols: `process-spawn`, `websocket`, or `acp-rest`. The agent's manifest declares its capabilities and determines its isolation boundary.

```typescript
const { agentConnector } = cc;

const agent = await agentConnector.connect({
  agentId: 'opencode-1',
  protocol: 'process-spawn',
  operatorId: 'ops-1',
  manifest: {
    id: 'opencode-manifest',
    agentIdentity: 'opencode-1',
    version: '1.0.0',
    capabilities: {
      languages: ['typescript', 'python'],
      frameworks: ['node'],
      tools: ['git', 'npm'],
    },
    memoryNamespaces: [{ namespace: 'project', permissions: ['read', 'write'] }],
    communicationChannels: [],
    mcpOperations: [],
  },
  connectionParams: {
    command: 'opencode',
    args: ['--headless'],
    cwd: '/workspace/my-project',
  },
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutCount: 3,
  maxReconnectAttempts: 3,
});

console.log(`Agent connected — session ${agent.sessionId}`);
```

### 3. Submit a multi-step coding task

Define the workflow as a sequence of steps. Each step can be agent-executed or wait for an external event (like CI).

```typescript
const { taskOrchestrator } = cc;

const task = await taskOrchestrator.createTask({
  operatorId: 'ops-1',
  agentId: 'opencode-1',
  steps: [
    { instructions: 'Implement the UserService class per the spec', executionMode: 'agent' },
    { instructions: 'Run the test suite', executionMode: 'agent' },
    { instructions: 'Push the branch and open a PR', executionMode: 'agent' },
    {
      instructions: 'Wait for CI to pass',
      executionMode: 'external-event',
      trigger: {
        type: 'event-driven',
        eventSourceId: 'github-ci',
        eventType: 'check_suite_completed',
        timeoutMs: 600_000, // 10 min
      },
    },
  ],
});
```

### 4. Dispatch and run the loop

```typescript
// Dispatch the first step to the agent
await taskOrchestrator.dispatchCurrentStep(task.id);

// Subscribe to real-time events
taskOrchestrator.onTaskEvent((event) => {
  if (event.type === 'step_status_change') {
    console.log(`Step ${event.stepId}: ${JSON.stringify(event.data)}`);
  }
  if (event.type === 'artifact_received') {
    console.log(`Artifact received for step ${event.stepId}`);
  }
});
```

### 5. Review and advance (the operator loop)

When a step completes, it transitions to `review`. The operator inspects artifacts and decides what to do next.

```typescript
// After the agent finishes step 1, inspect artifacts
const artifacts = await taskOrchestrator.queryArtifacts({
  taskId: task.id,
  stepId: task.steps[0].id,
});
console.log(`Step produced ${artifacts.length} artifacts`);

// Happy with the result — advance to the next step
await taskOrchestrator.advanceTask(task.id, 'ops-1');

// Not happy — retry with feedback instead
// await taskOrchestrator.retryStep(task.id, 'Use dependency injection instead of static methods', 'ops-1');

// Need to change the plan — redirect by inserting a new step
// await taskOrchestrator.redirectTask(task.id, [
//   { instructions: 'Add integration tests', executionMode: 'agent' },
// ], 2, 'ops-1');
```

### 6. External events close the loop automatically

For steps with `executionMode: 'external-event'`, the orchestrator waits for a push notification or polls an external source. When the event arrives, the step resolves and the next agent step auto-dispatches — no operator click needed.

```typescript
// A webhook from GitHub CI arrives — the orchestrator handles it
await taskOrchestrator.handleExternalEvent(task.id, waitingStep.id, {
  sourceId: 'github-ci',
  eventType: 'check_suite_completed',
  outcome: 'success',
  data: { conclusion: 'success', sha: 'abc123' },
  timestamp: new Date(),
});
// The next agent-executable step auto-dispatches
```

### 7. Monitor agent health

The Agent_Connector tracks heartbeats and manages the health state machine (`healthy → degraded → unresponsive`). Subscribe to events to react to health changes.

```typescript
agentConnector.onAgentEvent((event) => {
  if (event.type === 'health_change') {
    console.log(`Agent ${event.agentId} health: ${JSON.stringify(event.data)}`);
  }
  if (event.type === 'disconnected') {
    console.log(`Agent ${event.agentId} disconnected`);
  }
});
```

### 8. Clean shutdown

```typescript
// Cancel any active tasks and disconnect all agents
await cc.stop();
```

### REST API

All of the above operations are also available via the HTTP/WebSocket interface. The task management endpoints live under `/tasks` and agent endpoints under `/agents`. Connect a WebSocket and subscribe to `task:{taskId}` channels for real-time artifact streaming.

## Command Center UI

The `ui/` directory contains a React single-page application that provides a chat-first operator interface for the Command Center backend. Operators issue natural-language instructions, monitor task execution, review agent artifacts, and control the human-in-the-loop review cycle — all within a conversational interface.

### Tech stack

| Layer | Library |
|---|---|
| Framework | React 19 + TypeScript |
| Build tool | Vite 8 |
| State management | Zustand (auth, sessions, chat, tasks, workspace, theme) |
| Server state | TanStack React Query |
| Real-time | Native WebSocket with exponential backoff reconnection |
| Styling | CSS Modules + CSS custom properties (light/dark theming) |
| Testing | Vitest + Testing Library + fast-check (property tests) + msw (API mocking) |

### Getting started

```bash
cd ui
npm install
```

#### Development server

```bash
npm run dev
```

This starts the Vite dev server (default `http://localhost:5173`). The UI expects the Command Center backend to be running on port 8080.

#### Production build

```bash
npm run build
npm run preview   # preview the production build locally
```

### Connecting to the backend

The UI connects to the Command Center backend via REST and WebSocket. The base URL is configured through the `VITE_API_BASE_URL` environment variable:

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Base URL for all REST API calls |

The WebSocket connection defaults to `ws://localhost:8080/ws`.

### Authentication

The Command Center uses **token-based authentication** — there is no user management or credential exchange. The operator receives a pre-shared token out of band (configured when the backend starts) and pastes it into the UI login screen.

The flow:

1. The backend's `authenticate` callback validates raw tokens (see the `CommandCenter` constructor in the README examples above).
2. The UI presents a single "Token" input field on the login screen.
3. The operator pastes their token and clicks **Authenticate**.
4. The UI sends `POST /api/auth/login` with `{ "token": "<value>" }`.
5. The backend validates the token through the same `authenticate` callback and returns `{ token, operatorId, expiresAt }`.
6. All subsequent REST requests include the token as `Authorization: Bearer <token>`.
7. The WebSocket connection sends the token in an `auth` message on connect.

This keeps things simple — no passwords, no user database, no session cookies. Just a shared secret between the operator and the backend.

#### Local development

Start the backend with CORS enabled, then the UI:

```bash
# Terminal 1 — start the backend (ensure corsOrigins is set in your entry point)
npm run build
node dist/index.js

# Terminal 2 — start the UI dev server
cd ui
npm run dev
```

Make sure your backend entry point includes `corsOrigins` so the UI dev server on `:5173` can reach the API on `:8080`:

```typescript
const cc = new CommandCenter({
  corsOrigins: 'http://localhost:5173',
  authenticate: (token) => { /* ... */ },
});
```

Or use `corsOrigins: '*'` during development to allow any origin.

#### Custom backend URL

To point the UI at a different backend (e.g., a staging server):

```bash
VITE_API_BASE_URL=https://staging.example.com cd ui && npm run dev
```

Or create a `ui/.env.local` file:

```env
VITE_API_BASE_URL=https://staging.example.com
```

### REST API endpoints consumed by the UI

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Validate an operator token and receive session metadata |
| `GET` | `/api/sessions` | List all operator sessions |
| `POST` | `/api/sessions` | Create a new session |
| `GET` | `/api/sessions/:id/messages` | Fetch paginated message history (supports `?cursor=`) |
| `POST` | `/api/sessions/:id/messages` | Send a message in a session |
| `GET` | `/api/sessions/:id/tasks` | List tasks for a session |
| `GET` | `/api/tasks/:id` | Get task details |
| `POST` | `/api/tasks/:id/advance` | Approve and advance a task step |
| `POST` | `/api/tasks/:id/retry` | Retry a step with feedback |
| `POST` | `/api/tasks/:id/redirect` | Redirect a task with new steps |
| `POST` | `/api/tasks/:id/cancel` | Cancel a task |
| `GET` | `/api/tasks/:id/artifacts` | Fetch execution artifacts (supports `?stepId=`) |
| `POST` | `/api/memory/query` | Query the memory store |

### WebSocket protocol

The UI connects to the backend WebSocket at `/ws` and uses a JSON message protocol:

**Client → Server messages:**
- `auth` — authenticate with token on connection open
- `subscribe` / `unsubscribe` — manage event channel subscriptions
- `ping` — keepalive heartbeat

**Server → Client messages:**
- `event` — real-time events on subscribed channels
- `response` — replies to client commands
- `error` — error notifications
- `pong` — keepalive acknowledgment

**Event channels:**

| Channel | Events | Purpose |
|---|---|---|
| `session:state` | session_created, session_terminated, session_paused, session_resumed | Session sidebar updates |
| `task:{taskId}` | task_status_change, step_status_change, artifact_received, feedback_added | Task card real-time updates |
| `session:{sessionId}` | New messages, workspace updates | Chat and workspace updates |

The WebSocket manager automatically reconnects with exponential backoff (`min(1s × 2^attempt, 30s)`) and re-subscribes to all active channels after reconnection.

### UI testing

```bash
cd ui

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

### UI architecture

```
ui/src/
├── api/                    # REST client and WebSocket manager
│   ├── client.ts           # Fetch-based REST API client
│   └── websocket.ts        # WebSocket manager with reconnection
├── components/             # React components (one directory per component)
│   ├── App/                # Root layout, theme provider
│   ├── Artifact/           # Execution artifact renderer (diffs, terminal, errors)
│   ├── AuthGuard/          # Authentication gate
│   ├── Chat/               # ChatInterface, ChatInput, MessageRenderer
│   ├── ConnectionBanner/   # WebSocket status indicator
│   ├── LoginForm/          # Credential input
│   ├── Review/             # Approve/Retry/Redirect controls
│   ├── SessionSidebar/     # Session list, search, navigation
│   ├── Task/               # Task card with step tracking
│   └── Workspace/          # Repository and file access indicator
├── hooks/                  # Custom React hooks
│   ├── useAuth.ts          # Authentication state and actions
│   ├── useChat.ts          # Message fetching, sending, optimistic updates
│   ├── useInfiniteScroll.ts # IntersectionObserver-based pagination
│   ├── useSession.ts       # Single session data and mutations
│   ├── useSessions.ts      # Session list with caching
│   ├── useTask.ts          # Task data and review mutations
│   ├── useTheme.ts         # Light/dark mode toggle
│   └── useWebSocket.ts     # WebSocket lifecycle and event routing
├── stores/                 # Zustand state stores
│   ├── authStore.ts        # Token, operator ID, login/logout
│   ├── chatStore.ts        # Messages per session
│   ├── sessionStore.ts     # Session list, search, active session
│   ├── taskStore.ts        # Task state, event handling
│   ├── themeStore.ts       # Theme preference with localStorage persistence
│   └── workspaceStore.ts   # Tracked repositories per session
├── styles/
│   └── theme.css           # CSS custom properties for light/dark theming
├── types/                  # Shared TypeScript type definitions
│   ├── auth.ts, session.ts, chat.ts, task.ts, artifact.ts
│   ├── websocket.ts, workspace.ts, theme.ts
│   └── index.ts            # Barrel export
└── utils/
    └── artifactGrouping.ts # Group artifacts by type for collapsible display
```

## Backend Architecture

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
│   ├── agent-discovery-registry.ts
│   ├── agent-connector.ts
│   └── task-orchestrator.ts
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
    ├── operator-interface.ts
    ├── agent-connector.ts
    └── task-orchestrator.ts
```

### Subsystem dependency graph

All subsystems run in-process for low-latency policy evaluation. Dependencies are injected at construction time by the `CommandCenter` orchestrator.

```
Audit Log          ← used by all subsystems for event recording
Policy Engine      ← used by Session Manager, Memory Store, Communication Bus,
                     MCP Gateway, ACP Adapter, AgentCP Bridge, Agent Connector,
                     Task Orchestrator
Anti-Leakage       ← used by Communication Bus, MCP Gateway, Agent Connector
Session Manager    ← used by AgentCP Bridge, Operator Interface, Agent Connector
Memory Store       ← used by Operator Interface, Task Orchestrator
Communication Bus  ← used by ACP Adapter, Operator Interface, Agent Connector
MCP Gateway        ← used by AgentCP Bridge, Task Orchestrator
Agent Discovery    ← used by ACP Adapter, Agent Connector, Task Orchestrator
ACP Adapter        ← exposed via REST endpoints, used by Agent Connector
AgentCP Bridge     ← accepts stdin/stdout IDE connections, used by Agent Connector
Operator Interface ← handles REST + WebSocket connections, used by Task Orchestrator
Agent Connector    ← used by Task Orchestrator
Task Orchestrator  ← exposed via REST/WebSocket task management endpoints
```

## Connecting a Coding Agent

The Command Center doesn't run an LLM itself — it orchestrates external coding agents that do. You connect an agent via the REST API, then dispatch tasks to it through the operator UI or programmatically.

### Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  DGX Spark (128GB VRAM)                                     │
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │  LM Studio   │◄───│ Claude Code  │◄───│  C2 Command  │  │
│  │  (LLM host)  │    │  or OpenCode │    │   Center     │  │
│  │              │    │  (harness)   │    │  (this repo) │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The flow:
1. **LM Studio** serves a local model (e.g., Qwen 2.5 Coder 32B, DeepSeek Coder V2) on an OpenAI-compatible endpoint
2. **Claude Code or OpenCode** connects to LM Studio as its LLM provider and runs as a headless coding agent
3. **C2 Command Center** spawns/connects the coding harness as a child process and dispatches tasks to it

### Option A: Using OpenCode (process-spawn)

OpenCode supports headless mode and can use any OpenAI-compatible API.

**1. Configure LM Studio**

Start LM Studio and load your model. Note the API endpoint (default: `http://localhost:1234/v1`).

**2. Configure OpenCode**

Create or update `~/.config/opencode/config.json`:

```json
{
  "provider": {
    "type": "openai-compatible",
    "url": "http://localhost:1234/v1",
    "model": "your-model-name"
  }
}
```

**3. Connect via REST API**

```bash
curl -X POST http://localhost:8080/api/agent-connections \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "opencode-1",
    "protocol": "process-spawn",
    "manifest": {
      "id": "opencode-agent",
      "agentIdentity": "opencode-1",
      "description": "OpenCode coding agent backed by LM Studio",
      "memoryNamespaces": [],
      "communicationChannels": [],
      "mcpOperations": []
    },
    "connectionParams": {
      "command": "opencode",
      "args": ["--headless"],
      "cwd": "/workspace/my-project",
      "env": {
        "OPENAI_API_BASE": "http://localhost:1234/v1",
        "OPENAI_API_KEY": "lm-studio"
      }
    }
  }'
```

**4. Create a task**

```bash
curl -X POST http://localhost:8080/api/coding-tasks \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "opencode-1",
    "operatorId": "admin",
    "steps": [
      { "instructions": "Implement the UserService class with CRUD operations", "executionMode": "agent" },
      { "instructions": "Write unit tests for UserService", "executionMode": "agent" }
    ]
  }'
```

**5. Dispatch the first step**

```bash
curl -X POST http://localhost:8080/api/coding-tasks/<task-id>/dispatch \
  -H "Authorization: Bearer my-secret-token"
```

### Option B: Using Claude Code (process-spawn)

Claude Code can also target an OpenAI-compatible endpoint via environment variables.

```bash
curl -X POST http://localhost:8080/api/agent-connections \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "claude-code-1",
    "protocol": "process-spawn",
    "manifest": {
      "id": "claude-code-agent",
      "agentIdentity": "claude-code-1",
      "description": "Claude Code agent backed by LM Studio",
      "memoryNamespaces": [],
      "communicationChannels": [],
      "mcpOperations": []
    },
    "connectionParams": {
      "command": "claude",
      "args": ["--headless", "--model", "your-model-name"],
      "cwd": "/workspace/my-project",
      "env": {
        "ANTHROPIC_BASE_URL": "http://localhost:1234/v1",
        "ANTHROPIC_API_KEY": "lm-studio"
      }
    }
  }'
```

### Option C: Programmatic connection (in your entry point)

If you prefer wiring it in code rather than via REST:

```typescript
import { CommandCenter } from './dist/src/index.js';

const cc = new CommandCenter({
  port: 8080,
  corsOrigins: '*',
  authenticate: (token) => {
    if (token === 'my-secret-token') {
      return { operatorId: 'admin', permissions: ['admin'] };
    }
    return undefined;
  },
});

await cc.start();

// Connect the coding agent
const agent = await cc.agentConnector.connect({
  agentId: 'opencode-1',
  protocol: 'process-spawn',
  operatorId: 'admin',
  manifest: {
    id: 'opencode-agent',
    agentIdentity: 'opencode-1',
    description: 'OpenCode on DGX Spark',
    memoryNamespaces: [],
    communicationChannels: [],
    mcpOperations: [],
  },
  connectionParams: {
    command: 'opencode',
    args: ['--headless'],
    cwd: '/workspace/my-project',
    env: {
      OPENAI_API_BASE: 'http://localhost:1234/v1',
      OPENAI_API_KEY: 'lm-studio',
    },
  },
});

console.log(`Agent connected: ${agent.agentId}, session: ${agent.sessionId}`);
```

### Monitoring connected agents

```bash
# List connected agents
curl http://localhost:8080/api/agent-connections \
  -H "Authorization: Bearer my-secret-token"

# Disconnect an agent
curl -X DELETE http://localhost:8080/api/agent-connections/opencode-1 \
  -H "Authorization: Bearer my-secret-token" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "Maintenance" }'
```

### Notes for DGX Spark with LM Studio

- With 128GB VRAM you can comfortably run large coding models (70B+ parameter) with full context windows
- LM Studio's OpenAI-compatible API works out of the box with both OpenCode and Claude Code
- Set `OPENAI_API_KEY` to any non-empty string (e.g., `"lm-studio"`) — LM Studio doesn't validate keys
- For best coding performance, consider models like DeepSeek Coder V5 236B, Qwen 3.5 Coder 80B
- The C2 backend and UI can run on the same DGX Spark or on a separate machine — just update `VITE_API_BASE_URL` and `corsOrigins` accordingly

## License

See [LICENSE](LICENSE) for details.
