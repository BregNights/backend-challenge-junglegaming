import { ProviderForbiddenError } from "./errors";

/**
 * Who is calling. `unrestricted` is what the no-op adapter returns (and what an
 * operator/back-office identity would be); `provider` is a game provider
 * authenticated by the identity provider, allowed to act only on its own data.
 */
export type Caller = { kind: "unrestricted" } | { kind: "provider"; providerId: string };

export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");

/**
 * Extension point for authentication. The adapter bound today authenticates
 * nobody (see ARCHITECTURE.md, "Autenticação"); an OIDC adapter (Keycloak,
 * Zitadel...) would verify the bearer token here, and nothing else changes.
 */
export interface ProviderIdentityPort {
  /** Resolves the caller from the request credentials; throws UnauthenticatedError when they are missing or invalid. */
  authenticate(credentials: { authorization?: string }): Promise<Caller>;
}

/** Domain rule: an authenticated provider may only submit and read its own operations. */
export function assertCallerMayActAs(caller: Caller | undefined, providerId: string | undefined): void {
  if (caller?.kind === "provider" && caller.providerId !== providerId) {
    throw new ProviderForbiddenError(`Provider ${caller.providerId} cannot act on behalf of ${providerId ?? "another party"}`);
  }
}
