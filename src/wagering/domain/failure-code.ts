/**
 * Stable, machine-readable reasons for REJECTED/FAILED transactions. Providers
 * branch on these to decide whether to resend, fix the payload or give up
 * (see ARCHITECTURE.md, "Códigos de falha").
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** A reversal (ROLLBACK of WIN/REFUND) would overdraw: operationally different from a BET without funds. */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  /** Permanent infrastructure failure, recorded for audit (FAILED status). */
  ProcessingFailed = "PROCESSING_FAILED",
}
