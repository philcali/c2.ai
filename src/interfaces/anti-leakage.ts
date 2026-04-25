import type { ACPMessagePayload } from './communication-bus.js';

export interface ScanResult {
  safe: boolean;
  violations: string[];
}

export interface IAntiLeakage {
  scanMessagePayload(payload: ACPMessagePayload): ScanResult;
  sanitizeExternalResponse(response: unknown, agentPermissions: string[]): unknown;
  validateNoTransitiveEscalation(originAgentId: string, targetAgentId: string, operation: string): boolean;
}
