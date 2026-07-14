import { Body, Controller, Get, Ip, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { PermissionScope } from '@prisma/client';
import { IsBoolean, IsEnum, IsString, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PermissionsService } from './permissions.service';

class UpdateCellDto {
  @IsString() permissionKey!: string;
  @IsBoolean() allowed!: boolean;
  @IsEnum(PermissionScope) scope!: PermissionScope;
}

class RenameRoleDto {
  @IsString() @MinLength(2) displayName!: string;
}

@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  /** The matrix editor reads this (spec §3: roles × permissions grid). */
  @RequirePermission('manage_permissions')
  @Get('matrix')
  matrix() {
    return this.permissions.getMatrix();
  }

  /** Any authenticated user needs its own permission map to drive UI visibility. */
  @RequirePermission('view_own_leads')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.permissions.getRolePermissions(user.roleId);
  }

  @RequirePermission('manage_permissions')
  @Patch('roles/:roleId')
  updateCell(
    @CurrentUser() user: AuthUser,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() dto: UpdateCellDto,
    @Ip() ip: string,
  ) {
    return this.permissions.updateCell(user.id, roleId, dto.permissionKey, dto.allowed, dto.scope, ip);
  }

  @RequirePermission('manage_permissions')
  @Patch('roles/:roleId/rename')
  renameRole(
    @CurrentUser() user: AuthUser,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() dto: RenameRoleDto,
    @Ip() ip: string,
  ) {
    return this.permissions.renameRole(user.id, roleId, dto.displayName, ip);
  }
}
