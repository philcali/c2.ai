import fc from 'fast-check';
import type { AgentManifest } from '../../src/interfaces/manifest-validator.js';
import type { ACPAgentCard } from '../../src/interfaces/acp-adapter.js';
import { arbitraryACPAgentCard } from './acp-agent-card.generator.js';

const arbitraryMemoryAccess = (): fc.Arbitrary<'read' | 'write' | 'readwrite'> =>
  fc.constantFrom('read', 'write', 'readwrite');

const arbitraryMemoryNamespace = (): fc.Arbitrary<{ namespace: string; access: 'read' | 'write' | 'readwrite' }> =>
  fc.record({
    namespace: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
    access: arbitraryMemoryAccess(),
  });

const arbitraryMcpOperation = (): fc.Arbitrary<{ serviceId: string; operations: string[] }> =>
  fc.record({
    serviceId: fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
    operations: fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => s.trim().length > 0),
      { minLength: 1, maxLength: 5 }
    ),
  });

export const arbitraryAgentManifest = (): fc.Arbitrary<AgentManifest> =>
  fc.record({
    id: fc.uuid(),
    agentIdentity: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    description: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
    memoryNamespaces: fc.array(arbitraryMemoryNamespace(), { minLength: 0, maxLength: 5 }),
    communicationChannels: fc.array(
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
      { minLength: 0, maxLength: 5 }
    ),
    mcpOperations: fc.array(arbitraryMcpOperation(), { minLength: 0, maxLength: 3 }),
    agentCard: fc.option(arbitraryACPAgentCard(), { nil: undefined }),
  });

export const arbitraryInvalidAgentManifest = (): fc.Arbitrary<AgentManifest> =>
  fc.oneof(
    // Empty id
    arbitraryAgentManifest().map(m => ({ ...m, id: '' })),
    // Empty agentIdentity
    arbitraryAgentManifest().map(m => ({ ...m, agentIdentity: '' })),
    // Empty description
    arbitraryAgentManifest().map(m => ({ ...m, description: '' })),
  );
