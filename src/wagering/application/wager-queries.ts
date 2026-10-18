import { Inject, Injectable } from "@nestjs/common";
import { TransactionNotFoundError } from "../../shared/application/errors";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/unit-of-work";
import { toWagerTransactionView, type WagerTransactionView } from "./views";

@Injectable()
export class WagerQueries {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  async getById(transactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.run((store) => store.transactions.findById(transactionId));
    if (!transaction) throw new TransactionNotFoundError(`Transaction ${transactionId} not found`);
    return toWagerTransactionView(transaction);
  }

  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.uow.run((store) => store.transactions.findByExternalId(providerId, externalTransactionId));
    if (!transaction) {
      throw new TransactionNotFoundError(`Transaction ${externalTransactionId} of provider ${providerId} not found`);
    }
    return toWagerTransactionView(transaction);
  }
}
