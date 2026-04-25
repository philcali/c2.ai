import type {
  IAgentDiscoveryRegistry,
  DiscoveryQuery,
} from '../interfaces/agent-discovery-registry.js';
import type { ACPAgentCard } from '../interfaces/acp-adapter.js';

/**
 * In-memory Agent Discovery Registry implementation.
 *
 * Stores ACP Agent Cards keyed by their URL and supports discovery
 * queries filtered by skill, content type, and capabilities.
 *
 * Local (mDNS) discovery is stubbed — the interface is honoured but
 * the actual network layer is not implemented in this iteration.
 */
export class AgentDiscoveryRegistry implements IAgentDiscoveryRegistry {
  /** Agent cards indexed by their canonical URL. */
  private readonly cards: Map<string, ACPAgentCard> = new Map();

  /** Whether the (stubbed) mDNS local discovery listener is active. */
  private localDiscoveryActive = false;

  // ------------------------------------------------------------------
  // IAgentDiscoveryRegistry implementation
  // ------------------------------------------------------------------

  async register(card: ACPAgentCard): Promise<void> {
    this.cards.set(card.url, card);
  }

  deregister(agentUrl: string): void {
    this.cards.delete(agentUrl);
  }

  discover(query: DiscoveryQuery): ACPAgentCard[] {
    const results: ACPAgentCard[] = [];

    for (const card of this.cards.values()) {
      if (this.matchesQuery(card, query)) {
        results.push(card);
      }
    }

    return results;
  }

  getCard(agentUrl: string): ACPAgentCard | undefined {
    return this.cards.get(agentUrl);
  }

  listAll(): ACPAgentCard[] {
    return Array.from(this.cards.values());
  }

  startLocalDiscovery(): void {
    // Stub: mDNS-based local discovery is not yet implemented.
    this.localDiscoveryActive = true;
  }

  stopLocalDiscovery(): void {
    this.localDiscoveryActive = false;
  }

  // ------------------------------------------------------------------
  // Query helpers (public for testing convenience)
  // ------------------------------------------------------------------

  /** Returns true if the mDNS discovery stub is currently active. */
  isLocalDiscoveryActive(): boolean {
    return this.localDiscoveryActive;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Evaluate whether a card satisfies every specified criterion in the
   * query.  An omitted criterion is treated as "match all".
   */
  private matchesQuery(card: ACPAgentCard, query: DiscoveryQuery): boolean {
    if (query.skillId !== undefined && !this.hasSkillById(card, query.skillId)) {
      return false;
    }

    if (query.skillName !== undefined && !this.hasSkillByName(card, query.skillName)) {
      return false;
    }

    if (query.inputContentType !== undefined && !this.acceptsInputContentType(card, query.inputContentType)) {
      return false;
    }

    if (query.outputContentType !== undefined && !this.producesOutputContentType(card, query.outputContentType)) {
      return false;
    }

    if (query.capabilities !== undefined && !this.matchesCapabilities(card, query.capabilities)) {
      return false;
    }

    return true;
  }

  /** Check whether the card has a skill with the given id. */
  private hasSkillById(card: ACPAgentCard, skillId: string): boolean {
    return card.skills.some((s) => s.id === skillId);
  }

  /** Check whether the card has a skill with the given name (case-sensitive). */
  private hasSkillByName(card: ACPAgentCard, skillName: string): boolean {
    return card.skills.some((s) => s.name === skillName);
  }

  /**
   * Check whether the card accepts the given input content type.
   *
   * A content type matches if it appears in any skill's inputContentTypes
   * or in the card's defaultInputContentTypes.
   */
  private acceptsInputContentType(card: ACPAgentCard, contentType: string): boolean {
    if (card.defaultInputContentTypes.includes(contentType)) {
      return true;
    }
    return card.skills.some(
      (s) => s.inputContentTypes !== undefined && s.inputContentTypes.includes(contentType),
    );
  }

  /**
   * Check whether the card produces the given output content type.
   *
   * A content type matches if it appears in any skill's outputContentTypes
   * or in the card's defaultOutputContentTypes.
   */
  private producesOutputContentType(card: ACPAgentCard, contentType: string): boolean {
    if (card.defaultOutputContentTypes.includes(contentType)) {
      return true;
    }
    return card.skills.some(
      (s) => s.outputContentTypes !== undefined && s.outputContentTypes.includes(contentType),
    );
  }

  /**
   * Check whether the card's capabilities satisfy the partial capabilities
   * query.  Each specified capability field must match exactly.
   */
  private matchesCapabilities(
    card: ACPAgentCard,
    required: Partial<ACPAgentCard['capabilities']>,
  ): boolean {
    if (required.streaming !== undefined && card.capabilities.streaming !== required.streaming) {
      return false;
    }
    if (
      required.pushNotifications !== undefined &&
      card.capabilities.pushNotifications !== required.pushNotifications
    ) {
      return false;
    }
    if (
      required.stateTransitionHistory !== undefined &&
      card.capabilities.stateTransitionHistory !== required.stateTransitionHistory
    ) {
      return false;
    }
    return true;
  }
}
