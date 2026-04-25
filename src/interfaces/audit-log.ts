export type AuditEventType =
  | 'policy_decision'
  | 'session_lifecycle'
  | 'memory_operation'
  | 'communication'
  | 'external_service'
  | 'security_violation'
  | 'operator_action'
  | 'acp_task'
  | 'acp_discovery'
  | 'agentcp_session';

export interface AuditEntry {
  sequenceNumber: number;
  timestamp: Date;
  agentId?: string;
  operatorId?: string;
  eventType: AuditEventType;
  operation: string;
  resource: string;
  decision?: 'allow' | 'deny';
  details: Record<string, unknown>;
}

export interface AuditQuery {
  agentId?: string;
  timeRange?: { start: Date; end: Date };
  eventType?: AuditEventType;
  decision?: 'allow' | 'deny';
  afterSequence?: number;
}

export type AuditFilter = AuditQuery;

export interface IAuditLog {
  record(entry: AuditEntry): Promise<void>;
  query(query: AuditQuery): Promise<AuditEntry[]>;
  stream(filter: AuditFilter): AsyncIterable<AuditEntry>;
  getSequenceNumber(): number;
}
