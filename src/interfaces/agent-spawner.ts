import type {
  SpawnRequest,
  SpawnResult,
  AgentHarnessConfig,
} from './orchestration-config.js';

/**
 * IAgentSpawner — Selects and spawns coding agents on demand based on
 * task requirements.
 *
 * The Agent_Spawner checks the Agent_Discovery_Registry for idle connected
 * agents that match the capability requirements. If a match is found, the
 * existing agent is reused. If not, a new agent process is spawned using
 * the configured harness command and connected through the Agent_Connector.
 *
 * The spawner respects the Session_Manager's maximum concurrent session
 * limit when deciding whether to spawn a new agent.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */
export interface IAgentSpawner {
  /**
   * Spawn or reuse an agent for the given requirements.
   *
   * 1. Checks the Agent_Discovery_Registry for idle connected agents
   *    whose capabilities satisfy the requirements.
   * 2. If a matching idle agent is found, reuses it (returns reused: true).
   * 3. If no match is found, spawns a new agent process using the
   *    configured harness command and workspace path.
   * 4. Connects the new agent through the Agent_Connector with a manifest
   *    derived from the task requirements.
   *
   * @param request - The spawn request containing workspace, requirements, and context
   * @returns The spawn result with agent ID, session ID, and reuse flag
   * @throws Error if spawning is not allowed (session limit) or spawn fails
   */
  spawn(request: SpawnRequest): Promise<SpawnResult>;

  /**
   * Check if spawning is possible given current session limits and resources.
   *
   * Compares the number of active sessions against the Session_Manager's
   * maximum concurrent session limit.
   *
   * @returns Object indicating whether spawning is allowed, with reason if not
   */
  canSpawn(): { allowed: boolean; reason?: string };

  /**
   * Get the configured harness command for agent spawning.
   *
   * @returns The current agent harness configuration
   */
  getHarnessConfig(): AgentHarnessConfig;

  /**
   * Set the harness configuration for agent spawning.
   *
   * @param config - The new agent harness configuration
   */
  setHarnessConfig(config: AgentHarnessConfig): void;
}
