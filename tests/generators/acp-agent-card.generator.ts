import fc from 'fast-check';
import type { ACPAgentCard, ACPSkill } from '../../src/interfaces/acp-adapter.js';

const CONTENT_TYPES = [
  'application/json',
  'text/plain',
  'text/html',
  'text/markdown',
  'application/xml',
] as const;

export const arbitraryACPSkill = (): fc.Arbitrary<ACPSkill> =>
  fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 40 }).filter(s => s.trim().length > 0),
    description: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
    inputContentTypes: fc.option(
      fc.array(fc.constantFrom(...CONTENT_TYPES), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
    outputContentTypes: fc.option(
      fc.array(fc.constantFrom(...CONTENT_TYPES), { minLength: 1, maxLength: 3 }),
      { nil: undefined }
    ),
  });

export const arbitraryACPAgentCard = (): fc.Arbitrary<ACPAgentCard> =>
  fc.record({
    name: fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
    description: fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
    url: fc.webUrl(),
    version: fc.tuple(
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 0, max: 99 }),
    ).map(([major, minor, patch]) => `${major}.${minor}.${patch}`),
    capabilities: fc.record({
      streaming: fc.boolean(),
      pushNotifications: fc.boolean(),
      stateTransitionHistory: fc.boolean(),
    }),
    skills: fc.array(arbitraryACPSkill(), { minLength: 1, maxLength: 5 }),
    defaultInputContentTypes: fc.array(fc.constantFrom(...CONTENT_TYPES), { minLength: 1, maxLength: 3 }),
    defaultOutputContentTypes: fc.array(fc.constantFrom(...CONTENT_TYPES), { minLength: 1, maxLength: 3 }),
  });

export const arbitraryInvalidACPAgentCard = (): fc.Arbitrary<ACPAgentCard> =>
  fc.oneof(
    // Missing name
    arbitraryACPAgentCard().map(c => ({ ...c, name: '' })),
    // Missing url
    arbitraryACPAgentCard().map(c => ({ ...c, url: '' })),
    // Missing version
    arbitraryACPAgentCard().map(c => ({ ...c, version: '' })),
    // Empty skills
    arbitraryACPAgentCard().map(c => ({ ...c, skills: [] })),
    // Empty defaultInputContentTypes
    arbitraryACPAgentCard().map(c => ({ ...c, defaultInputContentTypes: [] })),
    // Empty defaultOutputContentTypes
    arbitraryACPAgentCard().map(c => ({ ...c, defaultOutputContentTypes: [] })),
  );
