import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { type Caller, PROVIDER_IDENTITY, type ProviderIdentityPort } from "../../shared/application/provider-identity";

const IS_PUBLIC = "auth:public";

/** Tira um controller ou rota da autenticação (health checks, métricas). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

type AuthenticatedRequest = Request & { caller?: Caller };

/** O caller resolvido pelo AuthGuard para a requisição atual. */
export const CurrentCaller = createParamDecorator(
  (_: unknown, context: ExecutionContext): Caller | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().caller,
);

/**
 * Guard global: toda rota é autenticada, a menos que marcada com @Public(). Ele só
 * resolve o caller pela ProviderIdentityPort; as regras de autorização (um provedor
 * age sobre as próprias operações) ficam com quem chama os use cases.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.caller = await this.identity.authenticate({ authorization: request.headers.authorization });
    return true;
  }
}
