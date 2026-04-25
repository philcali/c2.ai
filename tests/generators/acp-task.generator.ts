import fc from 'fast-check';
import type { ACPTaskSubmission } from '../../src/interfaces/acp-adapter.js';
import { arbitraryACPMessagePayload } from './message.generator.js';

export const arbitraryACPTaskSubmission = (): fc.Arbitrary<ACPTaskSubmission> =>
  fc.record({
    skill: fc.option(
      fc.string({ minLength: 1, maxLength: 40 }).filter(s => s.trim().length > 0),
      { nil: undefined }
    ),
    message: arbitraryACPMessagePayload(),
  });
