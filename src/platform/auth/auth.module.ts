import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PROVIDER_IDENTITY } from "../../shared/application/provider-identity";
import { AuthGuard } from "./auth.guard";
import { NoAuthProviderIdentity } from "./no-auth.provider-identity";

@Global()
@Module({
  providers: [
    // Swap for an OIDC adapter (Keycloak/Zitadel JWT verification) to turn authentication on.
    { provide: PROVIDER_IDENTITY, useClass: NoAuthProviderIdentity },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
