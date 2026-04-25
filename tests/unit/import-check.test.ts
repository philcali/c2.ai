/**
 * Smoke test: verify all interfaces, error types, and generators are importable.
 */
import { describe, it, expect } from 'vitest';

// Core interfaces
import type { ISessionManager, AgentSession, SessionState, AgentSessionInfo } from '../../src/interfaces/session-manager.js';
import type { IPolicyEngine, AuthzRequest, AuthzDecision, AccessPolicy, PolicyScope, PolicyCondition } from '../../src/interfaces/policy-engine.js';
import type { IMemoryStore, MemoryEntry, MemoryQuery, WriteResult, ReadResult } from '../../src/interfaces/memory-store.js';
import type { ICommunicationBus, ACPMessagePayload, DeliveryResult, BusMessage } from '../../src/interfaces/communication-bus.js';
import type { IMCPGateway, ServiceConfig, OperationResult, ServiceStatus } from '../../src/interfaces/mcp-gateway.js';
import type { IAuditLog, AuditEntry, AuditEventType, AuditQuery, AuditFilter } from '../../src/interfaces/audit-log.js';
import type { IOperatorInterface, EventChannel, WebSocketMessage, WebSocketResponse, SystemEvent } from '../../src/interfaces/operator-interface.js';
import type { IAntiLeakage, ScanResult } from '../../src/interfaces/anti-leakage.js';
import type { IManifestValidator, AgentManifest, ValidationResult, ConflictResult, IsolationBoundary } from '../../src/interfaces/manifest-validator.js';
import type { IACPAdapter, ACPAgentCard, ACPSkill, ACPTaskSubmission, ACPTask, ACPTaskStatus, ACPTaskEvent } from '../../src/interfaces/acp-adapter.js';
import type { IAgentCPBridge, AgentCPProcessHandle, AgentCPSession, AgentCPSessionState, AgentCPCapabilities, AgentCPRequest, AgentCPResponse, AgentCPNotification, AgentCPMethod, AgentCPPermissionRequest } from '../../src/interfaces/agentcp-bridge.js';
import type { IAgentDiscoveryRegistry, DiscoveryQuery } from '../../src/interfaces/agent-discovery-registry.js';

// Error types
import { C2Error } from '../../src/errors/c2-error.js';
import { ErrorCode } from '../../src/errors/error-codes.js';
import type { ErrorResponse, StructuredError } from '../../src/errors/error-response.js';

// Generators
import { arbitraryAgentManifest } from '../generators/manifest.generator.js';
import { arbitraryAccessPolicy, arbitraryAuthzRequest } from '../generators/policy.generator.js';
import { arbitraryACPMessagePayload } from '../generators/message.generator.js';
import { arbitraryAuditEntry, arbitraryMemoryEntry } from '../generators/audit.generator.js';
import { arbitraryACPAgentCard } from '../generators/acp-agent-card.generator.js';
import { arbitraryACPTaskSubmission } from '../generators/acp-task.generator.js';
import { arbitraryAgentCPRequest, arbitraryAgentCPCapabilities } from '../generators/agentcp.generator.js';

describe('Import verification', () => {
  it('all interfaces are importable (type-level check passes via compilation)', () => {
    // If this file compiles and runs, all imports resolved successfully
    expect(true).toBe(true);
  });

  it('error classes are instantiable', () => {
    const err = new C2Error({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'test error',
      details: { field: 'test' },
      correlationId: 'test-123',
    });
    expect(err).toBeInstanceOf(C2Error);
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(err.message).toBe('test error');
    expect(err.correlationId).toBe('test-123');
  });

  it('generators produce values', () => {
    expect(arbitraryAgentManifest).toBeDefined();
    expect(arbitraryAccessPolicy).toBeDefined();
    expect(arbitraryAuthzRequest).toBeDefined();
    expect(arbitraryACPMessagePayload).toBeDefined();
    expect(arbitraryAuditEntry).toBeDefined();
    expect(arbitraryMemoryEntry).toBeDefined();
    expect(arbitraryACPAgentCard).toBeDefined();
    expect(arbitraryACPTaskSubmission).toBeDefined();
    expect(arbitraryAgentCPRequest).toBeDefined();
    expect(arbitraryAgentCPCapabilities).toBeDefined();
  });
});
