import type { StructuredIntent, ClarificationRequest } from './orchestration-config.js';

/**
 * IIntentResolver — Parses natural language messages or structured payloads
 * into actionable execution plans using the orchestration LLM.
 *
 * The Intent_Resolver routes all inference calls through the MCP Gateway,
 * ensuring audit logging and policy enforcement apply to the C2's own
 * LLM traffic.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 10.2, 10.3
 */
export interface IIntentResolver {
  /**
   * Parse a natural language message into a structured intent.
   *
   * Routes inference through the MCP Gateway and returns a StructuredIntent
   * with a confidence score indicating parsing certainty.
   *
   * @param message - The natural language message from the operator
   * @param operatorId - The ID of the operator who sent the message
   * @param sessionContext - Optional context from the current session
   * @returns A structured intent with parsed fields and confidence score
   */
  parseIntent(
    message: string,
    operatorId: string,
    sessionContext?: { sessionId: string; recentMessages?: string[] },
  ): Promise<StructuredIntent>;

  /**
   * Generate a clarification question when the intent is ambiguous.
   *
   * Used when the Intent_Resolver cannot determine a target repository
   * or action from the message, or when confidence is below threshold.
   *
   * @param partialIntent - The partially parsed intent with missing fields
   * @param reason - Why clarification is needed
   * @returns A clarification request to present to the operator
   */
  requestClarification(
    partialIntent: Partial<StructuredIntent>,
    reason: string,
  ): Promise<ClarificationRequest>;

  /**
   * Get the configured confidence threshold.
   *
   * Intents with confidence below this threshold will trigger
   * operator confirmation before proceeding.
   *
   * @returns The current confidence threshold (0.0 - 1.0)
   */
  getConfidenceThreshold(): number;

  /**
   * Set the confidence threshold.
   *
   * @param threshold - New threshold value (0.0 - 1.0)
   */
  setConfidenceThreshold(threshold: number): void;
}
