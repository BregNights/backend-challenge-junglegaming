import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { PROVIDER_IDENTITY } from "../../shared/application/provider-identity";
import { AuthGuard } from "./auth.guard";
import { NoAuthProviderIdentity } from "./no-auth.provider-identity";

@Global()
@Module({
  providers: [
    // Troque por um adaptador OIDC (validação de JWT do Keycloak/Zitadel) para ligar a autenticação.
    { provide: PROVIDER_IDENTITY, useClass: NoAuthProviderIdentity },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PROVIDER_IDENTITY],
})
export class AuthModule {}
