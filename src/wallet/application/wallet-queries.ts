import { Inject, Injectable, Logger } from "@nestjs/common";
import { WalletNotFoundError } from "../../shared/application/errors";
import { WAGERING_METRICS, type WageringMetrics } from "../../shared/application/metrics";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";
import {
  type LedgerPage,
  type ReconciliationReport,
  toLedgerEntryView,
  toWalletView,
  type WalletView,
} from "./views";

@Injectable()
export class WalletQueries {
  private readonly logger = new Logger(WalletQueries.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGERING_METRICS) private readonly metrics: WageringMetrics,
  ) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((store) => store.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, options: { cursor?: string; limit: number }): Promise<LedgerPage> {
    const beforeVersion = options.cursor === undefined ? undefined : decodeLedgerCursor(options.cursor);

    return this.uow.run(async (store) => {
      if (!(await store.wallets.findById(walletId))) throw new WalletNotFoundError(walletId);

      // Uma linha a mais diz se existe outra página, sem precisar de um count.
      const entries = await store.ledger.page(walletId, { beforeVersion, limit: options.limit + 1 });
      const page = entries.slice(0, options.limit);
      const last = page.at(-1);
      return {
        items: page.map(toLedgerEntryView),
        nextCursor: entries.length > options.limit && last ? encodeLedgerCursor(last.walletVersion) : null,
      };
    });
  }

  /**
   * Compara o saldo materializado com o reconstruído a partir do ledger.
   * Divergências nunca são corrigidas em silêncio: são logadas, contabilizadas e
   * reportadas, e ficam para um operador investigar.
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const summary = await this.uow.run((store) => store.ledger.summarize(walletId));
    if (!summary) throw new WalletNotFoundError(walletId);

    const difference = summary.storedBalance.subtract(summary.calculatedBalance);
    const consistent = difference.isZero();
    this.metrics.reconciliationChecked(consistent);
    if (!consistent) {
      this.logger.error({
        msg: "wallet balance diverges from its ledger",
        walletId,
        correlationId,
        difference: difference.toString(),
        checkedEntries: summary.entries,
      });
    }

    return {
      walletId,
      storedBalance: summary.storedBalance.toJSON(),
      calculatedBalance: summary.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entries,
    };
  }
}
