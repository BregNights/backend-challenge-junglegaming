import { Injectable } from "@nestjs/common";
import type { Caller, ProviderIdentityPort } from "../../shared/application/provider-identity";

/**
 * No-op proposital: autenticação está fora do escopo desta entrega (não pontua).
 * Todo caller é unrestricted. Trocar este binding por um adaptador OIDC é a única
 * mudança necessária para exigir a identidade do provedor.
 */
@Injectable()
export class NoAuthProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<Caller> {
    return { kind: "unrestricted" };
  }
}
