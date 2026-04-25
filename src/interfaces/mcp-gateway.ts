import type { ValidationResult } from './manifest-validator.js';

export interface ServiceConfig {
  id: string;
  name: string;
  endpoint: string;
  credentialRef: string;
  rateLimits: { perAgent: number; perService: number; windowMs: number };
}

export interface OperationResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface ServiceStatus {
  serviceId: string;
  available: boolean;
  lastChecked: Date;
}

export interface IMCPGateway {
  registerService(config: ServiceConfig): ValidationResult;
  unregisterService(serviceId: string): void;
  executeOperation(agentId: string, serviceId: string, operation: string, params: unknown): Promise<OperationResult>;
  listServices(): ServiceConfig[];
  getServiceStatus(serviceId: string): ServiceStatus;
}
