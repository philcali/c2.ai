import type { ACPAgentCard } from './acp-adapter.js';

export interface DiscoveryQuery {
  skillId?: string;
  skillName?: string;
  inputContentType?: string;
  outputContentType?: string;
  capabilities?: Partial<ACPAgentCard['capabilities']>;
}

export interface IAgentDiscoveryRegistry {
  register(card: ACPAgentCard): Promise<void>;
  deregister(agentUrl: string): void;
  discover(query: DiscoveryQuery): ACPAgentCard[];
  getCard(agentUrl: string): ACPAgentCard | undefined;
  listAll(): ACPAgentCard[];
  startLocalDiscovery(): void;
  stopLocalDiscovery(): void;
}
