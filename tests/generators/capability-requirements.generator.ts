import fc from 'fast-check';
import type { CapabilityRequirements } from '../../src/interfaces/agent-connector.js';

/** Generate valid CapabilityRequirements with realistic language/framework/tool combinations */
export const arbitraryCapabilityRequirements = (): fc.Arbitrary<CapabilityRequirements> =>
  fc.record({
    languages: fc.option(
      fc.array(
        fc.constantFrom('typescript', 'python', 'rust', 'go', 'java', 'javascript'),
        { minLength: 1, maxLength: 4 }
      ),
      { nil: undefined }
    ),
    frameworks: fc.option(
      fc.array(
        fc.constantFrom('react', 'express', 'fastapi', 'django', 'spring', 'nextjs'),
        { minLength: 1, maxLength: 3 }
      ),
      { nil: undefined }
    ),
    tools: fc.option(
      fc.array(
        fc.constantFrom('git', 'docker', 'npm', 'pip', 'cargo', 'kubectl'),
        { minLength: 1, maxLength: 4 }
      ),
      { nil: undefined }
    ),
  });
