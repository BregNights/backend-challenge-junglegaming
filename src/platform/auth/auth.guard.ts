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

/** Opts a controller or route out of authentication (health checks, metrics). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

type AuthenticatedRequest = Request & { caller?: Caller };

/** The caller resolved by AuthGuard for the current request. */
export const CurrentCaller = createParamDecorator(
  (_: unknown, context: ExecutionContext): Caller | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().caller,
);

/**
 * Global guard: every route is authenticated unless marked @Public(). It only
 * resolves the caller through the ProviderIdentityPort; authorization rules
 * (a provider acts on its own operations) live with the use cases' callers.
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
