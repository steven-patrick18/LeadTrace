import { Body, Controller, Get, Ip, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, Public, RequirePermission } from '../common/decorators';
import { PermissionsService } from '../permissions/permissions.service';
import { AuthService } from './auth.service';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class BatchSessionDto {
  @IsString()
  @MinLength(4)
  batchId!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly permissions: PermissionsService,
  ) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.auth.login(dto.email, dto.password, ip);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  // Any authenticated user may log out; view_own_leads is the universal baseline key.
  @RequirePermission('view_own_leads')
  @Post('logout')
  async logout(@CurrentUser() user: AuthUser) {
    await this.auth.logout(user.id, user.sessionId);
    return { ok: true };
  }

  // ── Quick batch-ID sessions ────────────────────────────────

  /** Start working as the batch ID's owner on this (already logged-in) screen. */
  @RequirePermission('view_own_leads')
  @Post('batch-session')
  startBatchSession(@CurrentUser() user: AuthUser, @Body() dto: BatchSessionDto, @Ip() ip: string) {
    return this.auth.startBatchSession(user, dto.batchId, ip);
  }

  /** End the current quick session (End button or auto-expiry cleanup). */
  @RequirePermission('view_own_leads')
  @Post('batch-session/end')
  endBatchSession(@CurrentUser() user: AuthUser, @Ip() ip: string) {
    return this.auth.endBatchSession(user, ip);
  }

  /** Sessions currently running under MY identity, anywhere on the floor. */
  @RequirePermission('view_own_leads')
  @Get('batch-sessions/mine')
  myBatchSessions(@CurrentUser() user: AuthUser) {
    return this.auth.myBatchSessions(user.id);
  }

  @RequirePermission('view_own_leads')
  @Post('batch-sessions/:id/revoke')
  async revokeBatchSession(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ) {
    const manageUsers = await this.permissions.check(user.roleId, 'manage_users');
    const canManage = manageUsers.allowed && manageUsers.scope !== 'VIEW';
    return this.auth.revokeBatchSession(user, id, canManage, ip);
  }
}
