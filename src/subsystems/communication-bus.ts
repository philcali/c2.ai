import { v4 as uuidv4 } from 'uuid';
import type {
  ICommunicationBus,
  ACPMessagePayload,
  DeliveryResult,
  BusMessage,
} from '../interfaces/communication-bus.js';
import type { IPolicyEngine } from '../interfaces/policy-engine.js';
import type { IAntiLeakage } from '../interfaces/anti-leakage.js';
import type { IAuditLog } from '../interfaces/audit-log.js';
import type { ISessionManager } from '../interfaces/session-manager.js';

/**
 * Default maximum message size in bytes (1 MB).
 */
const DEFAULT_MAX_MESSAGE_SIZE = 1_048_576;

/**
 * In-memory Communication Bus with ACP message format and policy enforcement.
 *
 * Guarantees:
 *  - All point-to-point messages undergo bilateral policy checks:
 *    sender must be allowed to send, recipient must be allowed to receive.
 *  - All messages are scanned by the Anti-Leakage module before delivery.
 *  - Broadcast messages are delivered per-recipient with individual policy checks.
 *  - Undeliverable messages return a failure result and are logged to the Audit Log.
 *  - Configurable max message size is enforced.
 *  - All messages use ACP-compatible ACPMessagePayload with MIME-type contentType.
 *  - Every delivery attempt (success or failure) is recorded in the Audit Log.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 9.3, 11.1
 */
export class CommunicationBus implements ICommunicationBus {
  /** Policy Engine for bilateral authorization checks. */
  private readonly policyEngine: IPolicyEngine;

  /** Anti-Leakage module for payload scanning. */
  private readonly antiLeakage: IAntiLeakage;

  /** Audit Log for recording communication events. */
  private readonly auditLog: IAuditLog;

  /** Session Manager for verifying recipient session state. */
  private readonly sessionManager: ISessionManager;

  /** Channel subscriptions: channel name → set of subscribed agent IDs. */
  private readonly subscriptions: Map<string, Set<string>> = new Map();

  /** Configurable maximum message payload size in bytes. */
  private maxMessageSize: number;

  /**
   * Delivered messages stored for potential retrieval.
   * In a production system this would be backed by a persistent store.
   */
  private readonly messages: Map<string, BusMessage> = new Map();

  constructor(options: {
    policyEngine: IPolicyEngine;
    antiLeakage: IAntiLeakage;
    auditLog: IAuditLog;
    sessionManager: ISessionManager;
    maxMessageSize?: number;
  }) {
    this.policyEngine = options.policyEngine;
    this.antiLeakage = options.antiLeakage;
    this.auditLog = options.auditLog;
    this.sessionManager = options.sessionManager;
    this.maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
  }

  // ------------------------------------------------------------------
  // ICommunicationBus — Point-to-point messaging
  // ------------------------------------------------------------------

  /**
   * Send a message from one agent to another with bilateral policy checks,
   * anti-leakage scanning, and audit logging.
   *
   * Flow:
   *  1. Validate message size.
   *  2. Check sender policy (can send to recipient).
   *  3. Check recipient policy (can receive from sender).
   *  4. Verify recipient session is active.
   *  5. Scan payload for credential material / restricted namespace refs.
   *  6. Deliver message and log success.
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 9.3, 11.1
   */
  async sendMessage(
    senderId: string,
    recipientId: string,
    payload: ACPMessagePayload,
  ): Promise<DeliveryResult> {
    const now = new Date();
    const messageId = uuidv4();
    const correlationId = payload.correlationId ?? uuidv4();

    // 1. Enforce message size limit.
    const sizeCheck = this.checkMessageSize(payload);
    if (!sizeCheck.ok) {
      return this.failDelivery(
        messageId,
        now,
        senderId,
        recipientId,
        correlationId,
        sizeCheck.reason!,
        payload,
      );
    }

    // 2. Bilateral policy check — sender can send to recipient.
    const senderDecision = this.policyEngine.evaluate({
      agentId: senderId,
      operation: 'send',
      resource: `communication:agent:${recipientId}`,
    });

    if (!senderDecision.allowed) {
      return this.failDelivery(
        messageId,
        now,
        senderId,
        recipientId,
        correlationId,
        `Sender policy denied: ${senderDecision.reason}`,
        payload,
        'deny',
      );
    }

    // 3. Bilateral policy check — recipient can receive from sender.
    const recipientDecision = this.policyEngine.evaluate({
      agentId: recipientId,
      operation: 'receive',
      resource: `communication:agent:${senderId}`,
    });

    if (!recipientDecision.allowed) {
      return this.failDelivery(
        messageId,
        now,
        senderId,
        recipientId,
        correlationId,
        `Recipient policy denied: ${recipientDecision.reason}`,
        payload,
        'deny',
      );
    }

    // 4. Verify recipient session is active.
    const recipientSession = this.sessionManager.getSession(recipientId);
    if (!recipientSession || recipientSession.state === 'terminated' || recipientSession.state === 'completed') {
      return this.failDelivery(
        messageId,
        now,
        senderId,
        recipientId,
        correlationId,
        `Recipient session '${recipientId}' is not active`,
        payload,
      );
    }

    // 5. Anti-leakage scan.
    const scanResult = this.antiLeakage.scanMessagePayload(payload);
    if (!scanResult.safe) {
      // Record security violation.
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: senderId,
        eventType: 'security_violation',
        operation: 'send_message',
        resource: `communication:agent:${recipientId}`,
        decision: 'deny',
        details: {
          messageId,
          correlationId,
          violations: scanResult.violations,
          reason: 'Payload blocked by anti-leakage scan',
        },
      });

      return {
        delivered: false,
        messageId,
        timestamp: now,
        failureReason: `Payload blocked: ${scanResult.violations.join('; ')}`,
      };
    }

    // 6. Build and store the message.
    const busMessage: BusMessage = {
      id: messageId,
      senderId,
      recipientId,
      payload,
      timestamp: now,
      correlationId,
    };

    this.messages.set(messageId, busMessage);

    // Record successful delivery.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: senderId,
      eventType: 'communication',
      operation: 'send_message',
      resource: `communication:agent:${recipientId}`,
      decision: 'allow',
      details: {
        messageId,
        correlationId,
        recipientId,
        contentType: payload.contentType,
      },
    });

    return {
      delivered: true,
      messageId,
      timestamp: now,
    };
  }

  // ------------------------------------------------------------------
  // ICommunicationBus — Broadcast messaging
  // ------------------------------------------------------------------

  /**
   * Broadcast a message to all subscribers of a channel.
   *
   * Each subscriber undergoes an individual policy check (bilateral:
   * sender can broadcast to channel, each recipient can receive from sender).
   * The anti-leakage scan is performed once for the payload.
   *
   * Returns a summary DeliveryResult. If at least one subscriber received
   * the message, `delivered` is true. Individual failures are logged.
   *
   * Requirements: 4.1, 4.2, 4.3, 4.5, 9.3, 11.1
   */
  async broadcast(
    senderId: string,
    channel: string,
    payload: ACPMessagePayload,
  ): Promise<DeliveryResult> {
    const now = new Date();
    const broadcastId = uuidv4();
    const correlationId = payload.correlationId ?? uuidv4();

    // 1. Enforce message size limit.
    const sizeCheck = this.checkMessageSize(payload);
    if (!sizeCheck.ok) {
      return this.failBroadcast(
        broadcastId,
        now,
        senderId,
        channel,
        correlationId,
        sizeCheck.reason!,
        payload,
      );
    }

    // 2. Check sender policy — can broadcast to this channel.
    const senderDecision = this.policyEngine.evaluate({
      agentId: senderId,
      operation: 'send',
      resource: `communication:channel:${channel}`,
    });

    if (!senderDecision.allowed) {
      return this.failBroadcast(
        broadcastId,
        now,
        senderId,
        channel,
        correlationId,
        `Sender policy denied: ${senderDecision.reason}`,
        payload,
        'deny',
      );
    }

    // 3. Anti-leakage scan (once for the payload).
    const scanResult = this.antiLeakage.scanMessagePayload(payload);
    if (!scanResult.safe) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: senderId,
        eventType: 'security_violation',
        operation: 'broadcast',
        resource: `communication:channel:${channel}`,
        decision: 'deny',
        details: {
          broadcastId,
          correlationId,
          violations: scanResult.violations,
          reason: 'Payload blocked by anti-leakage scan',
        },
      });

      return {
        delivered: false,
        messageId: broadcastId,
        timestamp: now,
        failureReason: `Payload blocked: ${scanResult.violations.join('; ')}`,
      };
    }

    // 4. Get channel subscribers.
    const subscribers = this.subscriptions.get(channel);
    if (!subscribers || subscribers.size === 0) {
      await this.auditLog.record({
        sequenceNumber: 0,
        timestamp: now,
        agentId: senderId,
        eventType: 'communication',
        operation: 'broadcast',
        resource: `communication:channel:${channel}`,
        details: {
          broadcastId,
          correlationId,
          subscriberCount: 0,
          reason: 'No subscribers on channel',
        },
      });

      return {
        delivered: false,
        messageId: broadcastId,
        timestamp: now,
        failureReason: 'No subscribers on channel',
      };
    }

    // 5. Deliver to each subscriber with individual policy checks.
    let deliveredCount = 0;
    const failedRecipients: string[] = [];

    for (const subscriberId of subscribers) {
      // Skip sender — don't deliver broadcast back to the sender.
      if (subscriberId === senderId) {
        continue;
      }

      // Recipient policy check — can receive from sender.
      const recipientDecision = this.policyEngine.evaluate({
        agentId: subscriberId,
        operation: 'receive',
        resource: `communication:agent:${senderId}`,
      });

      if (!recipientDecision.allowed) {
        failedRecipients.push(subscriberId);

        await this.auditLog.record({
          sequenceNumber: 0,
          timestamp: now,
          agentId: senderId,
          eventType: 'communication',
          operation: 'broadcast',
          resource: `communication:channel:${channel}`,
          decision: 'deny',
          details: {
            broadcastId,
            correlationId,
            recipientId: subscriberId,
            reason: `Recipient policy denied: ${recipientDecision.reason}`,
          },
        });

        continue;
      }

      // Verify recipient session is active.
      const recipientSession = this.sessionManager.getSession(subscriberId);
      if (!recipientSession || recipientSession.state === 'terminated' || recipientSession.state === 'completed') {
        failedRecipients.push(subscriberId);

        await this.auditLog.record({
          sequenceNumber: 0,
          timestamp: now,
          agentId: senderId,
          eventType: 'communication',
          operation: 'broadcast',
          resource: `communication:channel:${channel}`,
          details: {
            broadcastId,
            correlationId,
            recipientId: subscriberId,
            reason: `Recipient session '${subscriberId}' is not active`,
          },
        });

        continue;
      }

      // Store individual message for this recipient.
      const messageId = uuidv4();
      const busMessage: BusMessage = {
        id: messageId,
        senderId,
        recipientId: subscriberId,
        channel,
        payload,
        timestamp: now,
        correlationId,
      };

      this.messages.set(messageId, busMessage);
      deliveredCount++;
    }

    // Record broadcast summary.
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp: now,
      agentId: senderId,
      eventType: 'communication',
      operation: 'broadcast',
      resource: `communication:channel:${channel}`,
      decision: deliveredCount > 0 ? 'allow' : 'deny',
      details: {
        broadcastId,
        correlationId,
        channel,
        subscriberCount: subscribers.size,
        deliveredCount,
        failedRecipients,
        contentType: payload.contentType,
      },
    });

    if (deliveredCount === 0) {
      return {
        delivered: false,
        messageId: broadcastId,
        timestamp: now,
        failureReason: `No subscribers could receive the message. Failed: ${failedRecipients.join(', ')}`,
      };
    }

    return {
      delivered: true,
      messageId: broadcastId,
      timestamp: now,
    };
  }

  // ------------------------------------------------------------------
  // ICommunicationBus — Channel subscription management
  // ------------------------------------------------------------------

  /**
   * Subscribe an agent to a named channel.
   *
   * Requirements: 4.1
   */
  subscribe(agentId: string, channel: string): void {
    let channelSubs = this.subscriptions.get(channel);
    if (!channelSubs) {
      channelSubs = new Set<string>();
      this.subscriptions.set(channel, channelSubs);
    }
    channelSubs.add(agentId);
  }

  /**
   * Unsubscribe an agent from a named channel.
   *
   * Requirements: 4.1
   */
  unsubscribe(agentId: string, channel: string): void {
    const channelSubs = this.subscriptions.get(channel);
    if (channelSubs) {
      channelSubs.delete(agentId);
      // Clean up empty channel sets.
      if (channelSubs.size === 0) {
        this.subscriptions.delete(channel);
      }
    }
  }

  // ------------------------------------------------------------------
  // ICommunicationBus — Message size configuration
  // ------------------------------------------------------------------

  /**
   * Get the current maximum message size in bytes.
   *
   * Requirements: 4.6
   */
  getMaxMessageSize(): number {
    return this.maxMessageSize;
  }

  /**
   * Set the maximum message size in bytes.
   *
   * Requirements: 4.6
   */
  setMaxMessageSize(bytes: number): void {
    if (bytes < 1) {
      throw new Error('Maximum message size must be at least 1 byte.');
    }
    this.maxMessageSize = bytes;
  }

  // ------------------------------------------------------------------
  // Public helpers for other subsystems
  // ------------------------------------------------------------------

  /**
   * Get the subscribers for a given channel.
   * Useful for subsystems that need to inspect channel membership.
   */
  getChannelSubscribers(channel: string): string[] {
    const subs = this.subscriptions.get(channel);
    return subs ? Array.from(subs) : [];
  }

  /**
   * Get a delivered message by ID.
   */
  getMessage(messageId: string): BusMessage | undefined {
    return this.messages.get(messageId);
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Check whether a message payload exceeds the configured max size.
   * Serializes the payload to JSON and measures byte length.
   *
   * Requirements: 4.6
   */
  private checkMessageSize(payload: ACPMessagePayload): { ok: boolean; reason?: string } {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch {
      return { ok: false, reason: 'Payload is not serializable' };
    }

    const byteLength = Buffer.byteLength(serialized, 'utf-8');
    if (byteLength > this.maxMessageSize) {
      return {
        ok: false,
        reason: `Message size (${byteLength} bytes) exceeds maximum (${this.maxMessageSize} bytes)`,
      };
    }

    return { ok: true };
  }

  /**
   * Record a failed point-to-point delivery in the Audit Log and return
   * a failure DeliveryResult.
   *
   * Requirements: 4.5
   */
  private async failDelivery(
    messageId: string,
    timestamp: Date,
    senderId: string,
    recipientId: string,
    correlationId: string,
    reason: string,
    payload: ACPMessagePayload,
    decision?: 'allow' | 'deny',
  ): Promise<DeliveryResult> {
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp,
      agentId: senderId,
      eventType: 'communication',
      operation: 'send_message',
      resource: `communication:agent:${recipientId}`,
      decision: decision ?? 'deny',
      details: {
        messageId,
        correlationId,
        recipientId,
        reason,
        contentType: payload.contentType,
      },
    });

    return {
      delivered: false,
      messageId,
      timestamp,
      failureReason: reason,
    };
  }

  /**
   * Record a failed broadcast in the Audit Log and return a failure
   * DeliveryResult.
   *
   * Requirements: 4.5
   */
  private async failBroadcast(
    broadcastId: string,
    timestamp: Date,
    senderId: string,
    channel: string,
    correlationId: string,
    reason: string,
    payload: ACPMessagePayload,
    decision?: 'allow' | 'deny',
  ): Promise<DeliveryResult> {
    await this.auditLog.record({
      sequenceNumber: 0,
      timestamp,
      agentId: senderId,
      eventType: 'communication',
      operation: 'broadcast',
      resource: `communication:channel:${channel}`,
      decision: decision ?? 'deny',
      details: {
        broadcastId,
        correlationId,
        channel,
        reason,
        contentType: payload.contentType,
      },
    });

    return {
      delivered: false,
      messageId: broadcastId,
      timestamp,
      failureReason: reason,
    };
  }
}
