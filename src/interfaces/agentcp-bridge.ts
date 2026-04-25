export interface AgentCPProcessHandle {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  pid: number;
}

export interface AgentCPSession {
  id: string;
  agentSessionId: string;
  operatorId: string;
  state: AgentCPSessionState;
  capabilities: AgentCPCapabilities;
  createdAt: Date;
}

export type AgentCPSessionState = 'initializing' | 'active' | 'canceled' | 'terminated';

export interface AgentCPCapabilities {
  canWriteFiles: boolean;
  canExecuteCommands: boolean;
  allowedPaths?: string[];
  allowedCommands?: string[];
}

export interface AgentCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: AgentCPMethod;
  params?: Record<string, unknown>;
}

export interface AgentCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AgentCPNotification {
  jsonrpc: '2.0';
  method: AgentCPMethod;
  params?: Record<string, unknown>;
}

export type AgentCPMethod =
  | 'session/initialize'
  | 'session/new'
  | 'session/prompt'
  | 'session/update'
  | 'session/cancel'
  | 'permission/request'
  | 'permission/response';

export interface AgentCPPermissionRequest {
  type: 'file_write' | 'terminal_command';
  resource: string;
  description: string;
}

/** Lightweight version of AgentCPSession for listing */
export interface AgentCPSessionInfo {
  id: string;
  agentSessionId: string;
  operatorId: string;
  state: AgentCPSessionState;
  createdAt: Date;
}

export interface IAgentCPBridge {
  acceptConnection(processHandle: AgentCPProcessHandle, operatorId: string): Promise<AgentCPSession>;
  terminateSession(sessionId: string, reason: string): Promise<void>;
  listSessions(): AgentCPSessionInfo[];
}
