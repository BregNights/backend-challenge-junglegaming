import { Module } from "@nestjs/common";
import { OpenWallet } from "./application/open-wallet";
import { WalletQueries } from "./application/wallet-queries";
import { WalletsController } from "./http/wallets.controller";

@Module({
  controllers: [WalletsController],
  providers: [OpenWallet, WalletQueries],
})
export class WalletModule {}
