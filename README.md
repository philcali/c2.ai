# C2 AI Command Center

A server-side TypeScript/Node.js system that orchestrates multiple AI agent sessions with strict security isolation, shared memory, inter-agent communication, and centralized policy enforcement.

## Overview

C2 acts as a central command center for multi-agent workflows. Every agent runs inside an isolation boundary, every operation is policy-checked, and all external service access is mediated through an MCP Gateway. The system follows a security-first, default-deny architecture inspired by NemoClaw's OpenShell model.

### Key capabilities

- **Intent-driven orchestration** — describe what you need in natural language; the system resolves workspaces, spawns agents, and plans tasks automatically
- **Closed-loop agent workflows** — connect coding agents, dispatch multi-step tasks, review results, and iterate with retry/redirect
- **On-demand agent spawning** — agents are selected and spawned based on task requirements without manual configuration
- **Platform event ingress** — GitHub webhooks (push, PR comment, Actions) trigger autonomous sessions
- **Multi-session lifecycle management** — create, monitor, pause, resume, and terminate agent sessions
- **Isolation boundaries** — each agent is restricted to the permissions declared in its manifest
- **Shared memory store** — namespaced, policy-controlled persistent storage across agents
- **Agent-to-agent communication** — point-to-point and broadcast messaging with bilateral policy checks
- **MCP Gateway** — all external service access (GitHub, APIs, orchestration LLM) flows through a single authorization gateway
- **Policy Engine** — declarative access policies with default-deny, versioning, and rollback
- **Guardrail policies** — constrain autonomous sessions with concurrency limits, repo allowlists, and action restrictions
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
  corsOrigins: '*',
  orchestrationLlm: {
    provider: 'openai-compatible',
    endpoint: 'http://localhost:1234/v1',
    model: 'qwen-2.5-coder-32b',
    apiKeyRef: 'LM_STUDIO_KEY',
    systemPrompt: 'You are a senior project manager coordinating coding tasks.',
  },
  authenticate: (token) => {
    if (token === 'my-secret-token') {
      return { operatorId: 'admin', permissions: ['admin'] };
    }
    return undefined;
  },
});

await cc.start();
console.log('C2 Command Center running on port 9000');

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
| `orchestrationLlm` | `OrchestrationLlmConfig` | — | LLM configuration for intent parsing and task planning (required for Layer 2) |
| `agentHarness` | `AgentHarnessConfig` | — | Agent harness configuration for on-demand spawning |
| `intentConfidenceThreshold` | `number` | `0.7` | Confidence threshold (0.0–1.0) below which the operator is asked to confirm intent |
| `maxAutonomousSessions` | `number` | `5` | Maximum concurrent autonomous sessions triggered by platform events |

### OrchestrationLlmConfig

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `'openai-compatible' \| 'anthropic' \| 'custom'` | Yes | LLM provider type |
| `endpoint` | `string` | Yes | API endpoint URL |
| `model` | `string` | Yes | Model identifier |
| `apiKeyRef` | `string` | Yes | Reference to API key (environment variable name, not the key itself) |
| `systemPrompt` | `string` | No | System prompt defining orchestration persona |
| `temperature` | `number` | No | Inference temperature (default: 0.3) |
| `maxTokens` | `number` | No | Max tokens for responses |
| `roles` | `Record<string, { model?, systemPrompt? }>` | No | Future: named role configurations for different components |

### AgentHarnessConfig

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` | Yes | Command to spawn the agent process |
| `args` | `string[]` | No | Arguments for the spawn command |
| `env` | `Record<string, string>` | No | Environment variables for the agent process |
| `defaultCapabilities` | `CapabilityRequirements` | Yes | Default capability set when no specific requirements are given |

### Exposed interfaces

Once started, the Command Center exposes:

- **REST API** — session lifecycle, policy management, memory administration, audit queries, webhook ingress
- **WebSocket** — real-time bidirectional communication, event subscriptions, audit streaming
- **ACP endpoints** — agent registration, task submission, status polling, SSE streaming, cancellation
- **Webhook endpoint** — `POST /webhooks/:sourceId` for platform event ingress

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

## Intent-Driven Orchestration (Layer 2)

Layer 2 sits between the operator/event interfaces and the execution primitives, translating high-level intents into fully-specified task plans. Instead of manually connecting agents and specifying connection parameters, operators describe what they need and the system handles the rest.

### How it works

1. **Operator sends a natural language message** → Intent_Resolver parses it via the orchestration LLM → produces a structured intent
2. **Workspace_Resolver** finds or creates the right workspace (checks memory cache, clones if needed)
3. **Agent_Spawner** selects an idle matching agent or spawns a new one
4. **Task_Planner** decomposes the intent into concrete task steps via the orchestration LLM
5. **Task_Orchestrator** executes the plan through the existing closed-loop workflow

### Platform event flow

External events (GitHub push, PR comments, Actions failures) follow the same pipeline but enter through the Event_Ingress:

1. **Webhook arrives** at `POST /webhooks/:sourceId`
2. **Event_Ingress** validates the HMAC-SHA256 signature and translates the event into a structured intent
3. **Policy_Engine** evaluates guardrail policies — if denied, the session enters `pending_approval`
4. Once approved (or if allowed), the session proceeds through workspace resolution → agent spawning → task planning → execution

### Orchestration session lifecycle

Every intent (operator or platform event) creates an Orchestration_Session that tracks the full lifecycle:

```
intent_received → resolving_workspace → spawning_agent → planning_task → executing → completed | failed
                ↘ pending_approval (if guardrails deny) → resolving_workspace (after approval)
```

Sessions are cancelable at any stage. Failures record the reason and notify the operator.

### Registering a webhook source

```typescript
const { eventIngress } = cc;

eventIngress.registerSource({
  id: 'github-main',
  platform: 'github',
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  allowedEventTypes: ['push', 'pull_request_comment', 'workflow_run'],
  ownerOperatorId: 'admin',
  repositories: ['myorg/my-repo'],
});
```

### Guardrail policies

Autonomous sessions are constrained by policies evaluated by the Policy_Engine:

- **Max concurrent autonomous sessions** — prevents runaway resource consumption
- **Repository allowlists** — restrict which repos can trigger autonomous work
- **Action restrictions** — block dangerous operations (force-push, production deploys)
- **Max task step count** — limit plan complexity

Sessions that exceed guardrails enter `pending_approval` and wait for operator approval.

## Wiring a Closed-Loop Agent Workflow

The Agent Integration layer lets you connect external coding agents and run multi-step tasks through a closed loop: **dispatch → execute → review → advance** (or retry / redirect).

### 1. Start the Command Center

```typescript
import { CommandCenter } from './src/index.js';

const cc = new CommandCenter({
  port: 9000,
  corsOrigins: 'http://localhost:5173',
  orchestrationLlm: {
    provider: 'openai-compatible',
    endpoint: 'http://localhost:1234/v1',
    model: 'qwen-2.5-coder-32b',
    apiKeyRef: 'LM_STUDIO_KEY',
  },
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
        timeoutMs: 600_000,
      },
    },
  ],
});
```

### 4. Dispatch and run the loop

```typescript
await taskOrchestrator.dispatchCurrentStep(task.id);

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
const artifacts = await taskOrchestrator.queryArtifacts({
  taskId: task.id,
  stepId: task.steps[0].id,
});
console.log(`Step produced ${artifacts.length} artifacts`);

// Happy with the result — advance to the next step
await taskOrchestrator.advanceTask(task.id, 'ops-1');

// Not happy — retry with feedback
// await taskOrchestrator.retryStep(task.id, 'Use dependency injection instead of static methods', 'ops-1');

// Need to change the plan — redirect by inserting a new step
// await taskOrchestrator.redirectTask(task.id, [
//   { instructions: 'Add integration tests', executionMode: 'agent' },
// ], 2, 'ops-1');
```

### 6. External events close the loop automatically

For steps with `executionMode: 'external-event'`, the orchestrator waits for a push notification or polls an external source. When the event arrives, the step resolves and the next agent step auto-dispatches.

```typescript
await taskOrchestrator.handleExternalEvent(task.id, waitingStep.id, {
  sourceId: 'github-ci',
  eventType: 'check_suite_completed',
  outcome: 'success',
  data: { conclusion: 'success', sha: 'abc123' },
  timestamp: new Date(),
});
```

### 7. Monitor agent health

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
await cc.stop();
```

### REST API

All operations are also available via the HTTP/WebSocket interface. Task management endpoints live under `/tasks`, agent endpoints under `/agents`, and webhook ingress at `/webhooks/:sourceId`. Connect a WebSocket and subscribe to `task:{taskId}` channels for real-time artifact streaming.

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
1. **LM Studio** serves a local model on an OpenAI-compatible endpoint
2. **Claude Code or OpenCode** connects to LM Studio as its LLM provider and runs as a headless coding agent
3. **C2 Command Center** spawns/connects the coding harness as a child process and dispatches tasks to it

### Option A: Using OpenCode (process-spawn)

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

### Option B: Using Claude Code (process-spawn)

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

### Option C: Programmatic connection

```typescript
import { CommandCenter } from './dist/src/index.js';

const cc = new CommandCenter({
  port: 8080,
  corsOrigins: '*',
  orchestrationLlm: {
    provider: 'openai-compatible',
    endpoint: 'http://localhost:1234/v1',
    model: 'qwen-2.5-coder-32b',
    apiKeyRef: 'LM_STUDIO_KEY',
  },
  authenticate: (token) => {
    if (token === 'my-secret-token') {
      return { operatorId: 'admin', permissions: ['admin'] };
    }
    return undefined;
  },
});

await cc.start();

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

| Variable | Default | Description |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:8080` | Base URL for all REST API calls |

The WebSocket connection defaults to `ws://localhost:8080/ws`.

### Authentication

The Command Center uses **token-based authentication** — no user management or credential exchange. The operator receives a pre-shared token out of band and pastes it into the UI login screen.

1. The backend's `authenticate` callback validates raw tokens.
2. The UI presents a single "Token" input field on the login screen.
3. The operator pastes their token and clicks **Authenticate**.
4. The UI sends `POST /api/auth/login` with `{ "token": "<value>" }`.
5. The backend validates the token and returns `{ token, operatorId, expiresAt }`.
6. All subsequent REST requests include the token as `Authorization: Bearer <token>`.
7. The WebSocket connection sends the token in an `auth` message on connect.

#### Local development

```bash
# Terminal 1 — start the backend
npm run build
node dist/index.js

# Terminal 2 — start the UI dev server
cd ui
npm run dev
```

### UI testing

```bash
cd ui
npm test
```

## Backend Architecture

```
src/
├── command-center.ts          # Main orchestrator — wires all subsystems
├── index.ts                   # Public API exports
├── errors/                    # Shared error types and codes
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
│   ├── task-orchestrator.ts
│   ├── intent-resolver.ts          # Layer 2
│   ├── workspace-resolver.ts       # Layer 2
│   ├── agent-spawner.ts            # Layer 2
│   ├── event-ingress.ts            # Layer 2
│   ├── orchestration-session.ts    # Layer 2
│   ├── orchestration-config.ts     # Layer 2 shared types
│   └── task-planner.ts             # Layer 2
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
    ├── task-orchestrator.ts
    ├── intent-resolver.ts           # Layer 2
    ├── workspace-resolver.ts        # Layer 2
    ├── agent-spawner.ts             # Layer 2
    ├── event-ingress.ts             # Layer 2
    ├── orchestration-session-manager.ts  # Layer 2
    └── task-planner.ts              # Layer 2
```

### Subsystem dependency graph

All subsystems run in-process for low-latency policy evaluation. Dependencies are injected at construction time by the `CommandCenter` orchestrator.

**Layer 1 (Execution Primitives):**
```
Audit Log          ← used by all subsystems
Policy Engine      ← used by Session Manager, Memory Store, Communication Bus,
                     MCP Gateway, ACP Adapter, AgentCP Bridge, Agent Connector,
                     Task Orchestrator
Anti-Leakage       ← used by Communication Bus, MCP Gateway, Agent Connector
Session Manager    ← used by AgentCP Bridge, Operator Interface, Agent Connector
Memory Store       ← used by Operator Interface, Task Orchestrator, Workspace Resolver
Communication Bus  ← used by ACP Adapter, Operator Interface, Agent Connector
MCP Gateway        ← used by AgentCP Bridge, Task Orchestrator, Intent Resolver, Task Planner
Agent Discovery    ← used by ACP Adapter, Agent Connector, Agent Spawner
Operator Interface ← handles REST + WebSocket, used by Task Orchestrator, Orchestration Session
Agent Connector    ← used by Task Orchestrator, Agent Spawner
Task Orchestrator  ← used by Task Planner
```

**Layer 2 (Intent-Driven Orchestration):**
```
Intent Resolver              ← uses MCP Gateway, Audit Log
Workspace Resolver           ← uses Memory Store, Audit Log
Agent Spawner                ← uses Agent Connector, Discovery Registry, Session Manager, Audit Log
Task Planner                 ← uses MCP Gateway, Task Orchestrator, Audit Log
Orchestration Session Manager ← uses all Layer 2 subsystems + Policy Engine, Audit Log, Operator Interface
Event Ingress                ← uses Orchestration Session Manager, Policy Engine, Audit Log
```

## License

See [LICENSE](LICENSE) for details.
