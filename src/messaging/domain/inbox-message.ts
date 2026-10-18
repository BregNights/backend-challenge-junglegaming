export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Registro persistente de uma mensagem de transporte tratada por um consumidor,
 * com chave (consumerName, messageId). Gravado na mesma transação SQL que o efeito
 * da mensagem, então "processada" e "registrada" nunca discordam.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    this._processedAt ??= at;
  }

  /** O mesmo id de mensagem com outro corpo é bug do produtor, não redelivery. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
