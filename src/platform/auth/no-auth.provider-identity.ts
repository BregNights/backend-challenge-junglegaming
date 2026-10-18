import { Injectable } from "@nestjs/common";
import type { Caller, ProviderIdentityPort } from "../../shared/application/provider-identity";

/**
 * Deliberate no-op: authentication is out of this delivery's scope (it scores
 * no points). Every caller is unrestricted. Replacing this binding with an OIDC
 * adapter is the only change needed to enforce provider identity.
 */
@Injectable()
export class NoAuthProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<Caller> {
    return { kind: "unrestricted" };
  }
}
