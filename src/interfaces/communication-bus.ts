export interface ACPMessagePayload {
  type: string;
  contentType: string;
  body: unknown;
  correlationId?: string;
  acceptedContentTypes?: string[];
}

export interface DeliveryResult {
  delivered: boolean;
  messageId: string;
  timestamp: Date;
  failureReason?: string;
}

export interface BusMessage {
  id: string;
  senderId: string;
  recipientId: string;
  channel?: string;
  payload: ACPMessagePayload;
  timestamp: Date;
  correlationId: string;
}

export interface ICommunicationBus {
  sendMessage(senderId: string, recipientId: string, payload: ACPMessagePayload): Promise<DeliveryResult>;
  broadcast(senderId: string, channel: string, payload: ACPMessagePayload): Promise<DeliveryResult>;
  subscribe(agentId: string, channel: string): void;
  unsubscribe(agentId: string, channel: string): void;
  getMaxMessageSize(): number;
  setMaxMessageSize(bytes: number): void;
}
