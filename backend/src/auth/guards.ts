import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_META, PERMISSION_KEY_META } from '../common/decorators';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService } from './auth.service';

/** Global guard #1 — authenticates the bearer token and loads the user. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_META, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing token');
    req.user = await this.auth.validateAccess(header.slice(7));
    return true;
  }
}

/**
 * Global guard #2 — the permission guard (spec §3, build FIRST).
 * Every non-public endpoint MUST declare @RequirePermission('key');
 * an undeclared endpoint is denied by design, so nothing ships unguarded.
 * Resolves role permissions from DB via cache; attaches the admitted
 * permission's scope to req.user for OWN/ASSIGNED filtering in services.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_META, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const key = this.reflector.getAllAndOverride<string>(PERMISSION_KEY_META, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!key) {
      // Fail closed: an endpoint without a declared permission is a bug, not a pass.
      throw new ForbiddenException('Endpoint has no declared permission');
    }

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new UnauthorizedException();

    const resolved = await this.permissions.check(user.roleId, key);
    if (!resolved.allowed) {
      throw new ForbiddenException(`Missing permission: ${key}`);
    }
    user.permissionScope = resolved.scope;
    return true;
  }
}
