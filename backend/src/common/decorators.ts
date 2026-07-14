import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const PERMISSION_KEY_META = 'required_permission_key';
export const IS_PUBLIC_META = 'is_public_endpoint';

/**
 * Declares the permission_key required to hit an endpoint (spec §3:
 * "server-side guard on every endpoint, declaring its required permission_key").
 */
export const RequirePermission = (permissionKey: string) =>
  SetMetadata(PERMISSION_KEY_META, permissionKey);

/** Only for login/refresh — everything else must declare a permission. */
export const Public = () => SetMetadata(IS_PUBLIC_META, true);

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  roleId: number;
  roleCode: string;
  sessionId: string;
  /** Scope of the permission that admitted this request (set by PermissionsGuard). */
  permissionScope?: 'ALL' | 'OWN' | 'ASSIGNED' | 'VIEW';
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
