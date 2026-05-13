import { v4 as uuidv4 } from 'uuid';

import type { IIntentResolver } from '../interfaces/intent-resolver.js';
import type { IMCPGateway, OperationResult } from '../interfaces/mcp-gateway.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type {
  OrchestrationLlmConfig,
  StructuredIntent,
  ClarificationRequest,
} from '../interfaces/orchestration-config.js';

/**
 * Default confidence threshold for intent parsing.
 * Intents below this threshold require operator confirmation.
 */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * The service ID used when routing orchestration LLM calls through the MCP Gateway.
 */
const ORCHESTRATION_LLM_SERVICE_ID = '__orchestration_llm';

/**
 * The agent ID used for the C2's own orchestration inference calls.
 * Distinguished from coding agent IDs to maintain audit clarity.
 */
const ORCHESTRATION_AGENT_ID = '__c2_orchestration';

/**
 * IntentResolver — Parses natural language messages into structured intents
 * using the orchestration LLM routed through the MCP Gateway.
 *
 * All inference calls are routed through the MCP Gateway to ensure audit
 * logging and policy enforcement apply uniformly to the C2's own LLM traffic.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 10.2, 10.3
 */
export class IntentResolver implements IIntentResolver {
  private readonly mcpGateway: IMCPGateway;
  private readonly auditLog: IAuditLog;
  private readonly orchestrationLlmConfig: OrchestrationLlmConfig;
  private confidenceThreshold: number;

  constructor(options: {
    mcpGateway: IMCPGateway;
    auditLog: IAuditLog;
    orchestrationLlmConfig: OrchestrationLlmConfig;
    confidenceThreshold?: number;
  }) {
    this.mcpGateway = options.mcpGateway;
    this.auditLog = options.auditLog;
    this.orchestrationLlmConfig = options.orchestrationLlmConfig;
    this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  }

  // ------------------------------------------------------------------
  // IIntentResolver — Intent parsing
  // ------------------------------------------------------------------

  /**
   * Parse a natural language message into a structured intent.
   *
   * Routes the inference call through the MCP Gateway using the configured
   * orchestration LLM. The LLM is prompted to extract repository, action,
   * branch, constraints, and confidence from the operator's message.
   *
   * Requirements: 1.1, 1.3, 10.2, 10.3
   */
  async parseIntent(
    message: string,
    operatorId: string,
    sessionContext?: { sessionId: string; recentMessages?: string[] },
  ): Promise<StructuredIntent> {
    const intentId = uuidv4();
    const now = new Date();

    // Build the prompt for intent parsing
    const prompt = this.buildParseIntentPrompt(message, sessionContext);

    // Route inference through MCP Gateway
    const result = await this.mcpGateway.executeOperation(
      ORCHESTRATION_AGENT_ID,
      ORCHESTRATION_LLM_SERVICE_ID,
      'chat.completions',
      {
        model: this.orchestrationLlmConfig.model,
        messages: [
          {
            role: 'system',
            content: this.orchestrationLlmConfig.systemPrompt ?? this.getDefaultSystemPrompt(),
          },
          { role: 'user', content: prompt },
        ],
        temperature: this.orchestrationLlmConfig.temperature ?? 0.3,
        max_tokens: this.orchestrationLlmConfig.maxTokens ?? 1024,
        response_format: { type: 'json_object' },
      },
    );

    // Parse the LLM response into a StructuredIntent
    const intent = this.parseIntentFromResponse(result, intentId, operatorId, message, now);

    // Record the intent parsing in the audit log
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      operatorId,
      eventType: 'operator_action',
      operation: 'intent_parsed',
      resource: `intent:${intentId}`,
      details: {
        intentId,
        action: intent.action,
        repository: intent.repository,
        confidence: intent.confidence,
        sourceType: intent.sourceType,
        rawInput: message,
      },
    });

    return intent;
  }

  // ------------------------------------------------------------------
  // IIntentResolver — Clarification
  // ------------------------------------------------------------------

  /**
   * Generate a clarification question when the intent is ambiguous.
   *
   * Uses the orchestration LLM to produce a natural language question
   * that helps the operator provide the missing information.
   *
   * Requirements: 1.2, 10.2, 10.3
   */
  async requestClarification(
    partialIntent: Partial<StructuredIntent>,
    reason: string,
  ): Promise<ClarificationRequest> {
    const sessionId = partialIntent.id ?? uuidv4();

    // Build the prompt for clarification generation
    const prompt = this.buildClarificationPrompt(partialIntent, reason);

    // Route inference through MCP Gateway
    const result = await this.mcpGateway.executeOperation(
      ORCHESTRATION_AGENT_ID,
      ORCHESTRATION_LLM_SERVICE_ID,
      'chat.completions',
      {
        model: this.orchestrationLlmConfig.model,
        messages: [
          {
            role: 'system',
            content: this.orchestrationLlmConfig.systemPrompt ?? this.getDefaultSystemPrompt(),
          },
          { role: 'user', content: prompt },
        ],
        temperature: this.orchestrationLlmConfig.temperature ?? 0.3,
        max_tokens: this.orchestrationLlmConfig.maxTokens ?? 512,
        response_format: { type: 'json_object' },
      },
    );

    // Parse the clarification response
    const clarification = this.parseClarificationFromResponse(result, sessionId, reason);

    // Record the clarification request in the audit log
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: new Date(),
      eventType: 'operator_action',
      operation: 'clarification_requested',
      resource: `intent:${sessionId}`,
      details: {
        sessionId,
        reason,
        question: clarification.question,
        partialIntent: {
          repository: partialIntent.repository,
          action: partialIntent.action,
          confidence: partialIntent.confidence,
        },
      },
    });

    return clarification;
  }

  // ------------------------------------------------------------------
  // IIntentResolver — Threshold management
  // ------------------------------------------------------------------

  /**
   * Get the configured confidence threshold.
   */
  getConfidenceThreshold(): number {
    return this.confidenceThreshold;
  }

  /**
   * Set the confidence threshold.
   *
   * @param threshold - Must be between 0.0 and 1.0 inclusive
   * @throws Error if threshold is out of range
   */
  setConfidenceThreshold(threshold: number): void {
    if (threshold < 0.0 || threshold > 1.0) {
      throw new Error(`Confidence threshold must be between 0.0 and 1.0, got ${threshold}`);
    }
    this.confidenceThreshold = threshold;
  }

  // ------------------------------------------------------------------
  // Private — Prompt construction
  // ------------------------------------------------------------------

  /**
   * Build the system prompt for intent parsing.
   */
  private getDefaultSystemPrompt(): string {
    return `You are an orchestration intelligence for a C2 AI Command Center. Your role is to parse natural language messages from operators into structured execution intents. You extract the target repository, desired action, branch, constraints, and assess your confidence in the interpretation. Always respond with valid JSON.`;
  }

  /**
   * Build the user prompt for intent parsing.
   */
  private buildParseIntentPrompt(
    message: string,
    sessionContext?: { sessionId: string; recentMessages?: string[] },
  ): string {
    let prompt = `Parse the following operator message into a structured intent.

Operator message: "${message}"

`;

    if (sessionContext?.recentMessages && sessionContext.recentMessages.length > 0) {
      prompt += `Recent conversation context:\n`;
      for (const msg of sessionContext.recentMessages) {
        prompt += `- ${msg}\n`;
      }
      prompt += '\n';
    }

    prompt += `Respond with a JSON object containing:
- "repository": string or null (e.g., "owner/repo" or full URL, null if not identifiable)
- "branch": string or null (target branch, null if not specified)
- "action": string (high-level description of what needs to be done)
- "constraints": object or null (any constraints or preferences expressed)
- "issueRef": string or null (issue reference like "#42" if mentioned)
- "prRef": string or null (PR reference like "#15" if mentioned)
- "confidence": number between 0.0 and 1.0 (how confident you are in this interpretation)

If you cannot determine the action or repository, set confidence to a low value and explain in the action field what is unclear.`;

    return prompt;
  }

  /**
   * Build the prompt for clarification generation.
   */
  private buildClarificationPrompt(
    partialIntent: Partial<StructuredIntent>,
    reason: string,
  ): string {
    return `The operator's message could not be fully resolved into an actionable intent.

Reason: ${reason}

What we understood so far:
- Repository: ${partialIntent.repository ?? 'unknown'}
- Action: ${partialIntent.action ?? 'unknown'}
- Branch: ${partialIntent.branch ?? 'not specified'}
- Confidence: ${partialIntent.confidence ?? 'N/A'}
- Raw input: "${partialIntent.rawInput ?? ''}"

Generate a clarification question to ask the operator. Respond with a JSON object containing:
- "question": string (a clear, concise question to ask the operator)
- "options": array of strings or null (suggested options if applicable)
- "context": string (brief explanation of what we understood and what's missing)`;
  }

  // ------------------------------------------------------------------
  // Private — Response parsing
  // ------------------------------------------------------------------

  /**
   * Parse the MCP Gateway response into a StructuredIntent.
   *
   * Handles both successful LLM responses and error cases gracefully.
   */
  private parseIntentFromResponse(
    result: OperationResult,
    intentId: string,
    operatorId: string,
    rawInput: string,
    parsedAt: Date,
  ): StructuredIntent {
    // Default intent for error cases
    const defaultIntent: StructuredIntent = {
      id: intentId,
      sourceType: 'operator',
      sourceId: operatorId,
      action: '',
      confidence: 0,
      rawInput,
      parsedAt,
    };

    if (!result.success || !result.data) {
      // LLM call failed — return a zero-confidence intent
      return {
        ...defaultIntent,
        action: 'Unable to parse intent: LLM service unavailable',
        confidence: 0,
      };
    }

    try {
      // Extract the JSON content from the LLM response
      const responseData = result.data as {
        choices?: Array<{ message?: { content?: string } }>;
        content?: string;
      };

      let content: string | undefined;
      if (responseData.choices && responseData.choices[0]?.message?.content) {
        content = responseData.choices[0].message.content;
      } else if (typeof responseData.content === 'string') {
        content = responseData.content;
      } else if (typeof result.data === 'string') {
        content = result.data as string;
      }

      if (!content) {
        return {
          ...defaultIntent,
          action: 'Unable to parse intent: empty LLM response',
          confidence: 0,
        };
      }

      const parsed = JSON.parse(content) as {
        repository?: string;
        branch?: string;
        action?: string;
        constraints?: Record<string, unknown>;
        issueRef?: string;
        prRef?: string;
        confidence?: number;
      };

      return {
        id: intentId,
        sourceType: 'operator',
        sourceId: operatorId,
        repository: parsed.repository ?? undefined,
        branch: parsed.branch ?? undefined,
        action: parsed.action ?? '',
        constraints: parsed.constraints ?? undefined,
        issueRef: parsed.issueRef ?? undefined,
        prRef: parsed.prRef ?? undefined,
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0,
        rawInput,
        parsedAt,
      };
    } catch {
      // JSON parse failure — return a zero-confidence intent
      return {
        ...defaultIntent,
        action: 'Unable to parse intent: malformed LLM response',
        confidence: 0,
      };
    }
  }

  /**
   * Parse the MCP Gateway response into a ClarificationRequest.
   */
  private parseClarificationFromResponse(
    result: OperationResult,
    sessionId: string,
    fallbackReason: string,
  ): ClarificationRequest {
    const defaultClarification: ClarificationRequest = {
      sessionId,
      question: `Could you please provide more details about what you'd like to do? ${fallbackReason}`,
      context: fallbackReason,
    };

    if (!result.success || !result.data) {
      return defaultClarification;
    }

    try {
      const responseData = result.data as {
        choices?: Array<{ message?: { content?: string } }>;
        content?: string;
      };

      let content: string | undefined;
      if (responseData.choices && responseData.choices[0]?.message?.content) {
        content = responseData.choices[0].message.content;
      } else if (typeof responseData.content === 'string') {
        content = responseData.content;
      } else if (typeof result.data === 'string') {
        content = result.data as string;
      }

      if (!content) {
        return defaultClarification;
      }

      const parsed = JSON.parse(content) as {
        question?: string;
        options?: string[];
        context?: string;
      };

      return {
        sessionId,
        question: parsed.question ?? defaultClarification.question,
        options: parsed.options ?? undefined,
        context: parsed.context ?? fallbackReason,
      };
    } catch {
      return defaultClarification;
    }
  }
}
