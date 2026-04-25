export interface MemoryEntry {
  namespace: string;
  key: string;
  value: unknown;
  authorAgentId: string;
  timestamp: Date;
  tags: string[];
}

export interface MemoryQuery {
  namespace?: string;
  agentId?: string;
  timeRange?: { start: Date; end: Date };
  tags?: string[];
}

export interface WriteResult {
  success: boolean;
  key: string;
  timestamp: Date;
}

export interface ReadResult {
  found: boolean;
  entry?: MemoryEntry;
}

export interface IMemoryStore {
  write(agentId: string, namespace: string, key: string, value: unknown, tags?: string[]): Promise<WriteResult>;
  read(agentId: string, namespace: string, key: string): Promise<ReadResult>;
  query(agentId: string, query: MemoryQuery): Promise<MemoryEntry[]>;
  deleteNamespace(namespace: string, operatorId: string): Promise<void>;
}
