/**
 * ConfigLoader — reads, validates, serializes, and generates default c2.config.json.
 *
 * Responsible for:
 * - Parsing and validating the JSON configuration file
 * - Environment variable interpolation in string values
 * - Generating a default config file when none exists
 * - Round-trip serialization (parse → serialize → parse produces equivalent object)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface OrchestrationLlmConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKeyRef: string;
  systemPrompt: string;
}

export interface AuthConfig {
  tokenExpirationSeconds: number;
}

export interface C2Config {
  port: number;
  corsOrigins: string | string[];
  maxConcurrentSessions: number;
  maxMessageSize: number;
  orchestrationLlm: OrchestrationLlmConfig;
  auth: AuthConfig;
  [key: string]: unknown; // forward-compatibility for unknown fields
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const REQUIRED_TOP_LEVEL_FIELDS = [
  'port',
  'corsOrigins',
  'maxConcurrentSessions',
  'maxMessageSize',
  'orchestrationLlm',
  'auth',
] as const;

const REQUIRED_LLM_FIELDS = [
  'provider',
  'endpoint',
  'model',
  'apiKeyRef',
  'systemPrompt',
] as const;

const REQUIRED_AUTH_FIELDS = ['tokenExpirationSeconds'] as const;

function validateRequiredFields(config: Record<string, unknown>): void {
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (!(field in config) || config[field] === undefined) {
      throw new Error(`Missing required configuration field: "${field}"`);
    }
  }

  const llm = config['orchestrationLlm'] as Record<string, unknown> | undefined;
  if (typeof llm !== 'object' || llm === null) {
    throw new Error('Missing required configuration field: "orchestrationLlm" must be an object');
  }
  for (const field of REQUIRED_LLM_FIELDS) {
    if (!(field in llm) || llm[field] === undefined) {
      throw new Error(`Missing required configuration field: "orchestrationLlm.${field}"`);
    }
  }

  const auth = config['auth'] as Record<string, unknown> | undefined;
  if (typeof auth !== 'object' || auth === null) {
    throw new Error('Missing required configuration field: "auth" must be an object');
  }
  for (const field of REQUIRED_AUTH_FIELDS) {
    if (!(field in auth) || auth[field] === undefined) {
      throw new Error(`Missing required configuration field: "auth.${field}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Environment variable interpolation
// ---------------------------------------------------------------------------

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Recursively interpolates `${ENV_VAR_NAME}` patterns in all string values.
 * If the environment variable is not defined, the pattern is left as-is.
 */
function interpolateEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_PATTERN, (match, varName: string) => {
      const envValue = process.env[varName];
      return envValue !== undefined ? envValue : match;
    });
  }
  if (Array.isArray(value)) {
    return value.map(interpolateEnvVars);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateEnvVars(val);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: C2Config = {
  port: 8080,
  corsOrigins: 'http://localhost:5173',
  maxConcurrentSessions: 10,
  maxMessageSize: 1048576,
  orchestrationLlm: {
    provider: 'openai-compatible',
    endpoint: '${ORCHESTRATION_LLM_ENDPOINT}',
    model: '${ORCHESTRATION_LLM_MODEL}',
    apiKeyRef: '${ORCHESTRATION_LLM_API_KEY}',
    systemPrompt: 'You are a senior project manager orchestrating coding tasks.',
  },
  auth: {
    tokenExpirationSeconds: 3600,
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a validated C2Config.
 * Throws on invalid JSON (includes parse error message) or missing required fields.
 * Preserves unknown fields without error.
 */
export function parseConfig(json: string): C2Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in configuration file: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid configuration: expected a JSON object at the top level');
  }

  validateRequiredFields(parsed as Record<string, unknown>);

  return parsed as C2Config;
}

/**
 * Serialize a C2Config object to JSON with 2-space indentation.
 */
export function serializeConfig(config: C2Config): string {
  return JSON.stringify(config, null, 2);
}

/**
 * Generate a default c2.config.json file at the given path and return the default config.
 */
export function generateDefaultConfig(filePath: string): C2Config {
  const json = serializeConfig(DEFAULT_CONFIG);
  writeFileSync(filePath, json + '\n', 'utf-8');
  return { ...DEFAULT_CONFIG };
}

/**
 * Load configuration from disk, validate, and apply environment variable interpolation.
 * If the file does not exist, generates a default config file and returns defaults.
 *
 * @param filePath - Path to the config file. Defaults to `c2.config.json` in the project root.
 */
export function loadConfig(filePath?: string): C2Config {
  const resolvedPath = filePath ?? resolve(process.cwd(), 'c2.config.json');

  if (!existsSync(resolvedPath)) {
    return generateDefaultConfig(resolvedPath);
  }

  const raw = readFileSync(resolvedPath, 'utf-8');
  const config = parseConfig(raw);
  return interpolateEnvVars(config) as C2Config;
}
