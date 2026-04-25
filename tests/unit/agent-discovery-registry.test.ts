import { describe, it, expect, beforeEach } from 'vitest';
import { AgentDiscoveryRegistry } from '../../src/subsystems/agent-discovery-registry.js';
import type { ACPAgentCard, ACPSkill } from '../../src/interfaces/acp-adapter.js';
import type { DiscoveryQuery } from '../../src/interfaces/agent-discovery-registry.js';

/** Returns a minimal valid ACP Agent Card for use as a baseline in tests. */
function validCard(overrides?: Partial<ACPAgentCard>): ACPAgentCard {
  return {
    name: 'Test Agent',
    description: 'A test ACP agent',
    url: 'https://agent.example.com',
    version: '1.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [
      {
        id: 'skill-summarize',
        name: 'Summarize',
        description: 'Summarizes text',
        inputContentTypes: ['text/plain'],
        outputContentTypes: ['text/plain'],
      },
    ],
    defaultInputContentTypes: ['application/json'],
    defaultOutputContentTypes: ['application/json'],
    ...overrides,
  };
}

/** Returns a second distinct agent card. */
function secondCard(overrides?: Partial<ACPAgentCard>): ACPAgentCard {
  return validCard({
    name: 'Translator Agent',
    url: 'https://translator.example.com',
    version: '2.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    skills: [
      {
        id: 'skill-translate',
        name: 'Translate',
        description: 'Translates text between languages',
        inputContentTypes: ['text/plain', 'text/html'],
        outputContentTypes: ['text/plain'],
      },
    ],
    defaultInputContentTypes: ['text/plain'],
    defaultOutputContentTypes: ['text/plain'],
    ...overrides,
  });
}

/** Returns a third distinct agent card with multiple skills. */
function multiSkillCard(): ACPAgentCard {
  return validCard({
    name: 'Multi-Skill Agent',
    url: 'https://multi.example.com',
    version: '3.0.0',
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: false,
    },
    skills: [
      {
        id: 'skill-analyze',
        name: 'Analyze',
        description: 'Analyzes data',
        inputContentTypes: ['application/json'],
        outputContentTypes: ['application/json'],
      },
      {
        id: 'skill-visualize',
        name: 'Visualize',
        description: 'Creates visualizations',
        inputContentTypes: ['application/json'],
        outputContentTypes: ['text/html', 'application/json'],
      },
    ],
    defaultInputContentTypes: ['application/json'],
    defaultOutputContentTypes: ['application/json', 'text/html'],
  });
}

describe('AgentDiscoveryRegistry', () => {
  let registry: AgentDiscoveryRegistry;

  beforeEach(() => {
    registry = new AgentDiscoveryRegistry();
  });

  // ----------------------------------------------------------------
  // Agent registration and retrieval
  // ----------------------------------------------------------------

  describe('agent registration and retrieval', () => {
    it('should register an agent and retrieve it by URL', async () => {
      const card = validCard();
      await registry.register(card);

      const retrieved = registry.getCard(card.url);
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe('Test Agent');
      expect(retrieved!.url).toBe(card.url);
    });

    it('should return undefined for an unregistered URL', () => {
      const retrieved = registry.getCard('https://nonexistent.example.com');
      expect(retrieved).toBeUndefined();
    });

    it('should register multiple agents and retrieve each by URL', async () => {
      const card1 = validCard();
      const card2 = secondCard();

      await registry.register(card1);
      await registry.register(card2);

      expect(registry.getCard(card1.url)?.name).toBe('Test Agent');
      expect(registry.getCard(card2.url)?.name).toBe('Translator Agent');
    });

    it('should overwrite an existing card when registering with the same URL', async () => {
      const card = validCard();
      await registry.register(card);

      const updatedCard = validCard({ name: 'Updated Agent', version: '2.0.0' });
      await registry.register(updatedCard);

      const retrieved = registry.getCard(card.url);
      expect(retrieved!.name).toBe('Updated Agent');
      expect(retrieved!.version).toBe('2.0.0');
    });

    it('should include the registered agent in listAll results', async () => {
      const card = validCard();
      await registry.register(card);

      const all = registry.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].url).toBe(card.url);
    });
  });

  // ----------------------------------------------------------------
  // Deregistration removes agent from all queries
  // ----------------------------------------------------------------

  describe('deregistration removes agent from all queries', () => {
    it('should remove an agent so getCard returns undefined', async () => {
      const card = validCard();
      await registry.register(card);

      registry.deregister(card.url);

      expect(registry.getCard(card.url)).toBeUndefined();
    });

    it('should remove an agent from listAll results', async () => {
      const card = validCard();
      await registry.register(card);

      registry.deregister(card.url);

      expect(registry.listAll()).toHaveLength(0);
    });

    it('should remove an agent from discover results', async () => {
      const card = validCard();
      await registry.register(card);

      registry.deregister(card.url);

      const results = registry.discover({ skillId: 'skill-summarize' });
      expect(results).toHaveLength(0);
    });

    it('should not affect other agents when deregistering one', async () => {
      const card1 = validCard();
      const card2 = secondCard();
      await registry.register(card1);
      await registry.register(card2);

      registry.deregister(card1.url);

      expect(registry.getCard(card1.url)).toBeUndefined();
      expect(registry.getCard(card2.url)).toBeDefined();
      expect(registry.listAll()).toHaveLength(1);
    });

    it('should be a no-op when deregistering a non-existent URL', () => {
      // Should not throw
      registry.deregister('https://nonexistent.example.com');
      expect(registry.listAll()).toHaveLength(0);
    });

    it('should allow re-registration after deregistration', async () => {
      const card = validCard();
      await registry.register(card);
      registry.deregister(card.url);

      await registry.register(card);
      expect(registry.getCard(card.url)).toBeDefined();
      expect(registry.listAll()).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------
  // Discovery filtering by skill
  // ----------------------------------------------------------------

  describe('discovery filtering by skill', () => {
    it('should find agents by skillId', async () => {
      const card1 = validCard();
      const card2 = secondCard();
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({ skillId: 'skill-summarize' });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card1.url);
    });

    it('should find agents by skillName', async () => {
      const card1 = validCard();
      const card2 = secondCard();
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({ skillName: 'Translate' });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card2.url);
    });

    it('should return empty when no agent has the requested skillId', async () => {
      await registry.register(validCard());

      const results = registry.discover({ skillId: 'nonexistent-skill' });
      expect(results).toHaveLength(0);
    });

    it('should return empty when no agent has the requested skillName', async () => {
      await registry.register(validCard());

      const results = registry.discover({ skillName: 'Nonexistent' });
      expect(results).toHaveLength(0);
    });

    it('should find an agent with multiple skills by any of its skill IDs', async () => {
      const card = multiSkillCard();
      await registry.register(card);

      expect(registry.discover({ skillId: 'skill-analyze' })).toHaveLength(1);
      expect(registry.discover({ skillId: 'skill-visualize' })).toHaveLength(1);
    });

    it('should match skillName case-sensitively', async () => {
      await registry.register(validCard());

      const results = registry.discover({ skillName: 'summarize' });
      expect(results).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------
  // Discovery filtering by content type
  // ----------------------------------------------------------------

  describe('discovery filtering by content type', () => {
    it('should find agents by inputContentType from defaultInputContentTypes', async () => {
      const card1 = validCard(); // default input: application/json
      const card2 = secondCard(); // default input: text/plain
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({ inputContentType: 'application/json' });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card1.url);
    });

    it('should find agents by outputContentType from defaultOutputContentTypes', async () => {
      // validCard default output: application/json (skill also outputs text/plain)
      // Use a card whose default output is unique
      const card1 = validCard({
        url: 'https://json-only.example.com',
        skills: [
          {
            id: 'skill-json',
            name: 'JsonOnly',
            description: 'Outputs JSON only',
            // no skill-level outputContentTypes
          },
        ],
        defaultOutputContentTypes: ['application/json'],
      });
      const card2 = secondCard(); // default output: text/plain, skill output: text/plain
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({ outputContentType: 'text/plain' });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card2.url);
    });

    it('should find agents by inputContentType from skill-level content types', async () => {
      const card = secondCard(); // skill has inputContentTypes: ['text/plain', 'text/html']
      await registry.register(card);

      const results = registry.discover({ inputContentType: 'text/html' });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card.url);
    });

    it('should find agents by outputContentType from skill-level content types', async () => {
      const card = multiSkillCard(); // visualize skill outputs text/html
      await registry.register(card);

      const results = registry.discover({ outputContentType: 'text/html' });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card.url);
    });

    it('should return empty when no agent accepts the requested input content type', async () => {
      await registry.register(validCard());

      const results = registry.discover({ inputContentType: 'image/png' });
      expect(results).toHaveLength(0);
    });

    it('should return empty when no agent produces the requested output content type', async () => {
      await registry.register(validCard());

      const results = registry.discover({ outputContentType: 'image/png' });
      expect(results).toHaveLength(0);
    });
  });

  // ----------------------------------------------------------------
  // Discovery filtering by capabilities
  // ----------------------------------------------------------------

  describe('discovery filtering by capabilities', () => {
    it('should find agents with streaming capability', async () => {
      const card1 = validCard(); // streaming: true
      const card2 = secondCard(); // streaming: false
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({ capabilities: { streaming: true } });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card1.url);
    });

    it('should find agents with pushNotifications capability', async () => {
      const card1 = validCard(); // pushNotifications: false
      const card2 = secondCard(); // pushNotifications: true
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({ capabilities: { pushNotifications: true } });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card2.url);
    });

    it('should find agents with stateTransitionHistory capability', async () => {
      const card1 = validCard(); // stateTransitionHistory: false
      const card2 = secondCard(); // stateTransitionHistory: true
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({ capabilities: { stateTransitionHistory: true } });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card2.url);
    });

    it('should filter by multiple capabilities simultaneously', async () => {
      const card1 = validCard(); // streaming: true, pushNotifications: false
      const card2 = secondCard(); // streaming: false, pushNotifications: true
      const card3 = multiSkillCard(); // streaming: true, pushNotifications: true
      await registry.register(card1);
      await registry.register(card2);
      await registry.register(card3);

      const results = registry.discover({
        capabilities: { streaming: true, pushNotifications: true },
      });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card3.url);
    });

    it('should return empty when no agent matches the requested capabilities', async () => {
      await registry.register(validCard()); // streaming: true, pushNotifications: false, stateTransitionHistory: false

      const results = registry.discover({
        capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
      });
      expect(results).toHaveLength(0);
    });

    it('should match agents when capabilities query is a partial match', async () => {
      const card = validCard(); // streaming: true
      await registry.register(card);

      // Only querying streaming — other capabilities are not constrained
      const results = registry.discover({ capabilities: { streaming: true } });
      expect(results).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------
  // Discovery with combined filters
  // ----------------------------------------------------------------

  describe('discovery with combined filters', () => {
    it('should filter by both skillId and inputContentType', async () => {
      const card1 = validCard(); // skill-summarize, input: application/json
      const card2 = multiSkillCard(); // skill-analyze + skill-visualize, input: application/json
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({
        skillId: 'skill-analyze',
        inputContentType: 'application/json',
      });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card2.url);
    });

    it('should filter by skillName and capabilities', async () => {
      const card1 = validCard(); // Summarize, streaming: true
      const card2 = secondCard(); // Translate, streaming: false
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({
        skillName: 'Summarize',
        capabilities: { streaming: true },
      });
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe(card1.url);
    });

    it('should return empty when filters are individually satisfiable but not by the same agent', async () => {
      const card1 = validCard(); // skill-summarize, streaming: true
      const card2 = secondCard(); // skill-translate, streaming: false
      await registry.register(card1);
      await registry.register(card2);

      const results = registry.discover({
        skillId: 'skill-translate',
        capabilities: { streaming: true },
      });
      expect(results).toHaveLength(0);
    });

    it('should return all agents when query is empty', async () => {
      await registry.register(validCard());
      await registry.register(secondCard());
      await registry.register(multiSkillCard());

      const results = registry.discover({});
      expect(results).toHaveLength(3);
    });
  });

  // ----------------------------------------------------------------
  // Listing all registered agents
  // ----------------------------------------------------------------

  describe('listing all registered agents', () => {
    it('should return an empty array when no agents are registered', () => {
      expect(registry.listAll()).toEqual([]);
    });

    it('should return all registered agents', async () => {
      await registry.register(validCard());
      await registry.register(secondCard());
      await registry.register(multiSkillCard());

      const all = registry.listAll();
      expect(all).toHaveLength(3);

      const urls = all.map((c) => c.url);
      expect(urls).toContain('https://agent.example.com');
      expect(urls).toContain('https://translator.example.com');
      expect(urls).toContain('https://multi.example.com');
    });

    it('should reflect deregistrations in listAll', async () => {
      await registry.register(validCard());
      await registry.register(secondCard());

      registry.deregister(validCard().url);

      const all = registry.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].url).toBe('https://translator.example.com');
    });

    it('should reflect re-registrations with updated data', async () => {
      const card = validCard();
      await registry.register(card);

      const updated = validCard({ name: 'Updated Agent' });
      await registry.register(updated);

      const all = registry.listAll();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('Updated Agent');
    });
  });

  // ----------------------------------------------------------------
  // Local discovery stubs
  // ----------------------------------------------------------------

  describe('local discovery stubs', () => {
    it('should start local discovery without error', () => {
      registry.startLocalDiscovery();
      expect(registry.isLocalDiscoveryActive()).toBe(true);
    });

    it('should stop local discovery without error', () => {
      registry.startLocalDiscovery();
      registry.stopLocalDiscovery();
      expect(registry.isLocalDiscoveryActive()).toBe(false);
    });

    it('should report inactive when local discovery has not been started', () => {
      expect(registry.isLocalDiscoveryActive()).toBe(false);
    });
  });
});
