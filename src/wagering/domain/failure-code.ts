/**
 * Motivos estáveis e legíveis por máquina para transações REJECTED/FAILED. O
 * provedor decide com base neles se reenvia, corrige o payload ou desiste
 * (ver ARCHITECTURE.md, "Códigos de falha").
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** Uma reversão (ROLLBACK de WIN/REFUND) deixaria o saldo negativo: operacionalmente diferente de uma BET sem saldo. */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  /** Falha permanente de infraestrutura, registrada para auditoria (status FAILED). */
  ProcessingFailed = "PROCESSING_FAILED",
}
