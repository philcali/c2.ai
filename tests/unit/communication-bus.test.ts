import { describe, it, expect, beforeEach } from 'vitest';
import { CommunicationBus } from '../../src/subsystems/communication-bus.js';
import { PolicyEngine } from '../../src/subsystems/policy-engine.js';
import { AuditLog } from '../../src/subsystems/audit-log.js';
import { AntiLeakage } from '../../src/subsystems/anti-leakage.js';
import { SessionManager } from '../../src/subsystems/session-manager.js';
import type { AccessPolicy } from '../../src/interfaces/policy-engine.js';
import type { ACPMessagePayload } from '../../src/interfaces/communication-bus.js';
import type { AgentSession } from '../../src/interfaces/session-manager.js';

describe('CommunicationBus', () => {
  let bus: CommunicationBus;
  let policyEngine: PolicyEngine;
  let auditLog: AuditLog;
  let antiLeakage: AntiLeakage;
  let sessionManager: SessionManager;

  /** Valid ACP message payload for testing. */
  function makePayload(overrides?: Partial<ACPMessagePayload>): ACPMessagePayload {
    return {
      type: 'test-message',
      contentType: 'application/json',
      body: { data: 'hello' },
      ...overrides,
    };
  }

  /** Helper to add an allow policy for communication. */
  function allowCommPolicy(
    agentId: string,
    operations: string[],
    resources: string[],
  ): AccessPolicy {
    const policy: AccessPolicy = {
      id: `allow-${agentId}-${operations.join('-')}-${resources.join('-')}-${Date.now()}-${Math.random()}`,
      version: 1,
      agentId,
      operations,
      resources,
      effect: 'allow',
    };
    policyEngine.addPolicy(policy);
    return policy;
  }

  /** Helper to add a deny policy for communication. */
  function denyCommPolicy(
    agentId: string,
    operations: string[],
    resources: string[],
  ): AccessPolicy {
    const policy: AccessPolicy = {
      id: `deny-${agentId}-${operations.join('-')}-${resources.join('-')}-${Date.now()}-${Math.random()}`,
      version: 1,
      agentId,
      operations,
      resources,
      effect: 'deny',
    };
    policyEngine.addPolicy(policy);
    return policy;
  }

  /** Helper to create an agent session and return the session ID. */
  async function createAgentSession(manifestId: string): Promise<AgentSession> {
    return sessionManager.createSession(
      {
        id: manifestId,
        agentIdentity: manifestId,
        description: `Test agent ${manifestId}`,
        memoryNamespaces: [],
        communicationChannels: [],
        mcpOperations: [],
      },
      'operator-test',
    );
  }

  /** Set up bilateral allow policies for point-to-point messaging using session IDs. */
  function allowBilateral(senderId: string, recipientId: string): void {
    allowCommPolicy(senderId, ['send'], [`communication:agent:${recipientId}`]);
    allowCommPolicy(recipientId, ['receive'], [`communication:agent:${senderId}`]);
  }

  beforeEach(() => {
    policyEngine = new PolicyEngine();
    auditLog = new AuditLog();
    antiLeakage = new AntiLeakage({ policyEngine });
    sessionManager = new SessionManager({
      policyEngine,
      auditLog,
      maxConcurrentSessions: 20,
    });
    bus = new CommunicationBus({
      policyEngine,
      antiLeakage,
      auditLog,
      sessionManager,
    });
  });

  // ----------------------------------------------------------------
  // Point-to-point message delivery
  // ----------------------------------------------------------------

  describe('point-to-point message delivery', () => {
    it('should deliver a message when both sender and recipient policies allow', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.failureReason).toBeUndefined();
    });

    it('should store the delivered message and make it retrievable', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const payload = makePayload({ correlationId: 'corr-123' });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      const stored = bus.getMessage(result.messageId);
      expect(stored).toBeDefined();
      expect(stored!.senderId).toBe(sender.id);
      expect(stored!.recipientId).toBe(recipient.id);
      expect(stored!.payload.contentType).toBe('application/json');
      expect(stored!.correlationId).toBe('corr-123');
    });

    it('should generate a correlationId when not provided in payload', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());
      const stored = bus.getMessage(result.messageId);
      expect(stored).toBeDefined();
      expect(stored!.correlationId).toBeDefined();
      expect(stored!.correlationId.length).toBeGreaterThan(0);
    });

    it('should record successful delivery in audit log', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      await bus.sendMessage(sender.id, recipient.id, makePayload());

      const entries = await auditLog.query({
        agentId: sender.id,
        eventType: 'communication',
        decision: 'allow',
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.some((e) => e.operation === 'send_message')).toBe(true);
    });

    it('should deliver messages with different MIME content types', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const textPayload = makePayload({ contentType: 'text/plain', body: 'hello world' });
      const result = await bus.sendMessage(sender.id, recipient.id, textPayload);
      expect(result.delivered).toBe(true);

      const stored = bus.getMessage(result.messageId);
      expect(stored!.payload.contentType).toBe('text/plain');
    });

    it('should deliver multiple messages between the same agents', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const r1 = await bus.sendMessage(sender.id, recipient.id, makePayload({ body: 'msg-1' }));
      const r2 = await bus.sendMessage(sender.id, recipient.id, makePayload({ body: 'msg-2' }));
      const r3 = await bus.sendMessage(sender.id, recipient.id, makePayload({ body: 'msg-3' }));

      expect(r1.delivered).toBe(true);
      expect(r2.delivered).toBe(true);
      expect(r3.delivered).toBe(true);
      // Each message should have a unique ID.
      expect(new Set([r1.messageId, r2.messageId, r3.messageId]).size).toBe(3);
    });
  });

  // ----------------------------------------------------------------
  // Broadcast to channel subscribers
  // ----------------------------------------------------------------

  describe('broadcast to channel subscribers', () => {
    it('should deliver broadcast to all subscribed agents with valid policies', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const sub1 = await createAgentSession('sub-1');
      const sub2 = await createAgentSession('sub-2');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:updates']);
      allowCommPolicy(sub1.id, ['receive'], [`communication:agent:${broadcaster.id}`]);
      allowCommPolicy(sub2.id, ['receive'], [`communication:agent:${broadcaster.id}`]);

      bus.subscribe(sub1.id, 'updates');
      bus.subscribe(sub2.id, 'updates');

      const result = await bus.broadcast(broadcaster.id, 'updates', makePayload());

      expect(result.delivered).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should not deliver broadcast back to the sender', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const sub1 = await createAgentSession('sub-1');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:ch']);
      allowCommPolicy(sub1.id, ['receive'], [`communication:agent:${broadcaster.id}`]);

      bus.subscribe(broadcaster.id, 'ch');
      bus.subscribe(sub1.id, 'ch');

      const result = await bus.broadcast(broadcaster.id, 'ch', makePayload());
      expect(result.delivered).toBe(true);
    });

    it('should fail broadcast when no subscribers exist on channel', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:empty-ch']);

      const result = await bus.broadcast(broadcaster.id, 'empty-ch', makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('No subscribers');
    });

    it('should handle subscribe and unsubscribe correctly', () => {
      bus.subscribe('agent-1', 'channel-a');
      expect(bus.getChannelSubscribers('channel-a')).toContain('agent-1');

      bus.unsubscribe('agent-1', 'channel-a');
      expect(bus.getChannelSubscribers('channel-a')).not.toContain('agent-1');
    });

    it('should return empty array for channel with no subscribers', () => {
      expect(bus.getChannelSubscribers('nonexistent')).toEqual([]);
    });

    it('should handle unsubscribe from non-existent channel gracefully', () => {
      // Should not throw.
      bus.unsubscribe('agent-1', 'no-such-channel');
    });

    it('should record broadcast in audit log', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const sub1 = await createAgentSession('sub-1');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:ch']);
      allowCommPolicy(sub1.id, ['receive'], [`communication:agent:${broadcaster.id}`]);

      bus.subscribe(sub1.id, 'ch');
      await bus.broadcast(broadcaster.id, 'ch', makePayload());

      const entries = await auditLog.query({
        agentId: broadcaster.id,
        eventType: 'communication',
      });
      expect(entries.some((e) => e.operation === 'broadcast')).toBe(true);
    });

    it('should partially deliver broadcast when some recipients fail policy check', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const subOk = await createAgentSession('sub-ok');
      const subDenied = await createAgentSession('sub-denied');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:mixed']);
      allowCommPolicy(subOk.id, ['receive'], [`communication:agent:${broadcaster.id}`]);
      // subDenied has no receive policy — default deny.

      bus.subscribe(subOk.id, 'mixed');
      bus.subscribe(subDenied.id, 'mixed');

      const result = await bus.broadcast(broadcaster.id, 'mixed', makePayload());

      // At least one subscriber received it.
      expect(result.delivered).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // Bilateral policy denial scenarios
  // ----------------------------------------------------------------

  describe('bilateral policy denial scenarios', () => {
    it('should deny when sender has no send policy (default deny)', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      // Only recipient has receive policy, sender has no send policy.
      allowCommPolicy(recipient.id, ['receive'], [`communication:agent:${sender.id}`]);

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('Sender policy denied');
    });

    it('should deny when recipient has no receive policy (default deny)', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      // Only sender has send policy, recipient has no receive policy.
      allowCommPolicy(sender.id, ['send'], [`communication:agent:${recipient.id}`]);

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('Recipient policy denied');
    });

    it('should deny when both sender and recipient lack policies', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      // No policies at all.

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('denied');
    });

    it('should deny when explicit deny policy overrides allow for sender', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);
      denyCommPolicy(sender.id, ['send'], [`communication:agent:${recipient.id}`]);

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('Sender policy denied');
    });

    it('should deny when explicit deny policy overrides allow for recipient', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);
      denyCommPolicy(recipient.id, ['receive'], [`communication:agent:${sender.id}`]);

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('Recipient policy denied');
    });

    it('should record sender denial in audit log', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');

      await bus.sendMessage(sender.id, recipient.id, makePayload());

      const entries = await auditLog.query({
        agentId: sender.id,
        eventType: 'communication',
        decision: 'deny',
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].operation).toBe('send_message');
    });

    it('should record recipient denial in audit log', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      // Allow sender but not recipient.
      allowCommPolicy(sender.id, ['send'], [`communication:agent:${recipient.id}`]);

      await bus.sendMessage(sender.id, recipient.id, makePayload());

      const entries = await auditLog.query({
        agentId: sender.id,
        eventType: 'communication',
        decision: 'deny',
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
    });

    it('should deny broadcast when sender lacks channel send policy', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const sub1 = await createAgentSession('sub-1');

      // No send policy for broadcaster on this channel.
      allowCommPolicy(sub1.id, ['receive'], [`communication:agent:${broadcaster.id}`]);
      bus.subscribe(sub1.id, 'restricted-ch');

      const result = await bus.broadcast(broadcaster.id, 'restricted-ch', makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('Sender policy denied');
    });
  });

  // ----------------------------------------------------------------
  // Message size limit rejection
  // ----------------------------------------------------------------

  describe('message size limit rejection', () => {
    it('should reject point-to-point message exceeding max size', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      bus.setMaxMessageSize(50); // Very small limit.
      const largePayload = makePayload({ body: 'x'.repeat(200) });

      const result = await bus.sendMessage(sender.id, recipient.id, largePayload);

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('exceeds maximum');
    });

    it('should reject broadcast message exceeding max size', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const sub1 = await createAgentSession('sub-1');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:ch']);
      allowCommPolicy(sub1.id, ['receive'], [`communication:agent:${broadcaster.id}`]);
      bus.subscribe(sub1.id, 'ch');

      bus.setMaxMessageSize(50);
      const largePayload = makePayload({ body: 'x'.repeat(200) });

      const result = await bus.broadcast(broadcaster.id, 'ch', largePayload);

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('exceeds maximum');
    });

    it('should accept message within the size limit', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      // Set a generous limit and send a small message.
      bus.setMaxMessageSize(1_048_576);
      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(true);
    });

    it('should get and set max message size', () => {
      expect(bus.getMaxMessageSize()).toBe(1_048_576); // Default 1MB.

      bus.setMaxMessageSize(2048);
      expect(bus.getMaxMessageSize()).toBe(2048);
    });

    it('should throw when setting max message size to less than 1', () => {
      expect(() => bus.setMaxMessageSize(0)).toThrow('at least 1 byte');
      expect(() => bus.setMaxMessageSize(-1)).toThrow('at least 1 byte');
    });

    it('should record size rejection in audit log', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      bus.setMaxMessageSize(10);
      await bus.sendMessage(sender.id, recipient.id, makePayload());

      const entries = await auditLog.query({
        agentId: sender.id,
        eventType: 'communication',
        decision: 'deny',
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].details).toHaveProperty('reason');
    });
  });

  // ----------------------------------------------------------------
  // Undeliverable message handling
  // ----------------------------------------------------------------

  describe('undeliverable message handling', () => {
    it('should fail delivery when recipient session is terminated', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      // Terminate the recipient session.
      await sessionManager.terminateSession(recipient.id, 'test termination');

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('not active');
    });

    it('should fail delivery when recipient session does not exist', async () => {
      const sender = await createAgentSession('sender-1');
      // Use a fake ID that doesn't exist in session manager.
      const fakeRecipientId = 'nonexistent-session-id';
      allowCommPolicy(sender.id, ['send'], [`communication:agent:${fakeRecipientId}`]);
      allowCommPolicy(fakeRecipientId, ['receive'], [`communication:agent:${sender.id}`]);

      const result = await bus.sendMessage(sender.id, fakeRecipientId, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('not active');
    });

    it('should return failure result to sender on policy denial', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      // No policies — default deny.

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toBeDefined();
      expect(result.messageId).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should record undeliverable message event in audit log', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      await sessionManager.terminateSession(recipient.id, 'gone');
      await bus.sendMessage(sender.id, recipient.id, makePayload());

      const entries = await auditLog.query({
        agentId: sender.id,
        eventType: 'communication',
      });
      expect(entries.some((e) =>
        e.operation === 'send_message' && (e.details as Record<string, unknown>).reason !== undefined,
      )).toBe(true);
    });

    it('should skip terminated subscribers during broadcast', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const subAlive = await createAgentSession('sub-alive');
      const subDead = await createAgentSession('sub-dead');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:ch']);
      allowCommPolicy(subAlive.id, ['receive'], [`communication:agent:${broadcaster.id}`]);
      allowCommPolicy(subDead.id, ['receive'], [`communication:agent:${broadcaster.id}`]);

      bus.subscribe(subAlive.id, 'ch');
      bus.subscribe(subDead.id, 'ch');

      await sessionManager.terminateSession(subDead.id, 'terminated');

      const result = await bus.broadcast(broadcaster.id, 'ch', makePayload());

      // Should still deliver to the alive subscriber.
      expect(result.delivered).toBe(true);
    });

    it('should fail broadcast when all subscribers are terminated', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const sub1 = await createAgentSession('sub-1');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:ch']);
      allowCommPolicy(sub1.id, ['receive'], [`communication:agent:${broadcaster.id}`]);

      bus.subscribe(sub1.id, 'ch');
      await sessionManager.terminateSession(sub1.id, 'terminated');

      const result = await bus.broadcast(broadcaster.id, 'ch', makePayload());

      expect(result.delivered).toBe(false);
    });

    it('should block message when anti-leakage scan detects credential material', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const dangerousPayload = makePayload({
        body: { secret: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token' },
      });

      const result = await bus.sendMessage(sender.id, recipient.id, dangerousPayload);

      // Anti-leakage should block this.
      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('blocked');
    });

    it('should record anti-leakage violation as security_violation in audit log', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const dangerousPayload = makePayload({
        body: { key: 'AKIA1234567890ABCDEF' },
      });

      await bus.sendMessage(sender.id, recipient.id, dangerousPayload);

      const entries = await auditLog.query({
        agentId: sender.id,
        eventType: 'security_violation',
      });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].operation).toBe('send_message');
    });
  });

  // ----------------------------------------------------------------
  // ACP message format validation
  // ----------------------------------------------------------------

  describe('ACP message format validation', () => {
    it('should deliver messages with application/json content type', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const payload = makePayload({ contentType: 'application/json', body: { key: 'value' } });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      expect(result.delivered).toBe(true);
      const stored = bus.getMessage(result.messageId);
      expect(stored!.payload.contentType).toBe('application/json');
    });

    it('should deliver messages with text/plain content type', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const payload = makePayload({ contentType: 'text/plain', body: 'plain text message' });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      expect(result.delivered).toBe(true);
      const stored = bus.getMessage(result.messageId);
      expect(stored!.payload.contentType).toBe('text/plain');
    });

    it('should preserve acceptedContentTypes in delivered message', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const payload = makePayload({
        acceptedContentTypes: ['application/json', 'text/plain'],
      });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      const stored = bus.getMessage(result.messageId);
      expect(stored).toBeDefined();
      expect(stored!.payload.acceptedContentTypes).toEqual(['application/json', 'text/plain']);
    });

    it('should preserve the message type field', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const payload = makePayload({ type: 'task-result' });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      const stored = bus.getMessage(result.messageId);
      expect(stored).toBeDefined();
      expect(stored!.payload.type).toBe('task-result');
    });

    it('should preserve correlationId for message threading', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const payload = makePayload({ correlationId: 'thread-abc-123' });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      const stored = bus.getMessage(result.messageId);
      expect(stored).toBeDefined();
      expect(stored!.correlationId).toBe('thread-abc-123');
    });

    it('should include sender, recipient, and timestamp in stored BusMessage', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const result = await bus.sendMessage(sender.id, recipient.id, makePayload());

      const stored = bus.getMessage(result.messageId);
      expect(stored).toBeDefined();
      expect(stored!.senderId).toBe(sender.id);
      expect(stored!.recipientId).toBe(recipient.id);
      expect(stored!.timestamp).toBeInstanceOf(Date);
      expect(stored!.id).toBe(result.messageId);
    });

    it('should handle complex body payloads', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      const complexBody = {
        nested: { deep: { value: [1, 2, 3] } },
        array: ['a', 'b'],
        number: 42,
        boolean: true,
        nullValue: null,
      };
      const payload = makePayload({ body: complexBody });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      expect(result.delivered).toBe(true);
      const stored = bus.getMessage(result.messageId);
      expect(stored!.payload.body).toEqual(complexBody);
    });

    it('should include channel in audit details for broadcast messages', async () => {
      const broadcaster = await createAgentSession('broadcaster');
      const sub1 = await createAgentSession('sub-1');

      allowCommPolicy(broadcaster.id, ['send'], ['communication:channel:events']);
      allowCommPolicy(sub1.id, ['receive'], [`communication:agent:${broadcaster.id}`]);
      bus.subscribe(sub1.id, 'events');

      await bus.broadcast(broadcaster.id, 'events', makePayload());

      // Verify audit log records the channel.
      const entries = await auditLog.query({
        agentId: broadcaster.id,
        eventType: 'communication',
      });
      const broadcastEntry = entries.find(
        (e) => e.operation === 'broadcast' && e.decision === 'allow',
      );
      expect(broadcastEntry).toBeDefined();
      expect((broadcastEntry!.details as Record<string, unknown>).channel).toBe('events');
    });

    it('should reject non-serializable payload', async () => {
      const sender = await createAgentSession('sender-1');
      const recipient = await createAgentSession('recipient-1');
      allowBilateral(sender.id, recipient.id);

      // Create a circular reference that can't be serialized.
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const payload = makePayload({ body: circular });
      const result = await bus.sendMessage(sender.id, recipient.id, payload);

      expect(result.delivered).toBe(false);
      expect(result.failureReason).toContain('not serializable');
    });
  });
});
