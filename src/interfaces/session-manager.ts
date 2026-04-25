import type { AgentManifest, IsolationBoundary } from './manifest-validator.js';

export type SessionState = 'running' | 'paused' | 'errored' | 'completed' | 'terminated';

export interface AgentSession {
  id: string;
  manifestId: string;
  state: SessionState;
  isolationBoundary: IsolationBoundary;
  createdAt: Date;
  updatedAt: Date;
}

/** Lightweight version of AgentSession for listing */
export interface AgentSessionInfo {
  id: string;
  manifestId: string;
  state: SessionState;
  createdAt: Date;
}

export interface ISessionManager {
  createSession(manifest: AgentManifest, operatorId: string): Promise<AgentSession>;
  terminateSession(sessionId: string, reason: string): Promise<void>;
  getSession(sessionId: string): AgentSession | undefined;
  listSessions(): AgentSessionInfo[];
  pauseSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  getMaxConcurrentSessions(): number;
  setMaxConcurrentSessions(max: number): void;
}
