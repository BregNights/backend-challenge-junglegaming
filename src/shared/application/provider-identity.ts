import { ProviderForbiddenError } from "./errors";

/**
 * Quem está chamando. `unrestricted` é o que o adaptador no-op devolve (e o que
 * seria uma identidade de operador/back-office); `provider` é um provedor de jogos
 * autenticado pelo identity provider, que só pode agir sobre os próprios dados.
 */
export type Caller = { kind: "unrestricted" } | { kind: "provider"; providerId: string };

export const PROVIDER_IDENTITY = Symbol("ProviderIdentityPort");

/**
 * Ponto de extensão da autenticação. O adaptador ligado hoje não autentica
 * ninguém (ver ARCHITECTURE.md, "Autenticação"); um adaptador OIDC (Keycloak,
 * Zitadel...) validaria o bearer token aqui, e nada mais muda.
 */
export interface ProviderIdentityPort {
  /** Resolve o caller a partir das credenciais da requisição; lança UnauthenticatedError se estiverem ausentes ou inválidas. */
  authenticate(credentials: { authorization?: string }): Promise<Caller>;
}

/** Regra de domínio: um provedor autenticado só pode submeter e consultar as próprias operações. */
export function assertCallerMayActAs(caller: Caller | undefined, providerId: string | undefined): void {
  if (caller?.kind === "provider" && caller.providerId !== providerId) {
    throw new ProviderForbiddenError(`Provider ${caller.providerId} cannot act on behalf of ${providerId ?? "another party"}`);
  }
}
