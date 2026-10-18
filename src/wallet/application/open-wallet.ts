import { Inject, Injectable } from "@nestjs/common";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { UniqueConstraintConflict, WalletAlreadyExistsError } from "../../shared/application/errors";
import { CLOCK, type Clock, ID_GENERATOR, type IdGenerator } from "../../shared/application/ports";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { WalletBalanceChanged } from "../domain/wallet-balance-changed";
import { toWalletView, type WalletView } from "./views";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/**
 * Cria uma wallet. Um saldo inicial positivo é registrado como uma transação
 * interna OPENING, com o lançamento CREDIT no ledger, na mesma transação SQL.
 */
@Injectable()
export class OpenWallet {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  async execute(command: OpenWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);

    try {
      return await this.uow.run(async (store) => {
        if (await store.wallets.findByPlayer(command.playerId, initialBalance.currency)) {
          throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
        }

        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTransactionId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          at: now,
          opening: { transactionId: openingTransactionId, entryId: this.ids.next() },
        });

        store.wallets.insert(wallet);
        if (openingEntry) {
          store.transactions.insert(
            WagerTransaction.opening({ id: openingTransactionId, walletId, playerId: command.playerId, money: initialBalance, at: now }),
          );
          store.ledger.insert(openingEntry);
          store.outbox.add(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, {
                eventId: this.ids.next(),
                correlationId: command.correlationId,
                occurredAt: now,
              }),
            ),
          );
        }
        return toWalletView(wallet);
      });
    } catch (error) {
      // Duas criações concorrentes passaram pela checagem de existência; a constraint única escolheu uma.
      if (error instanceof UniqueConstraintConflict && error.constraint === "wallets_player_currency_uq") {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}
