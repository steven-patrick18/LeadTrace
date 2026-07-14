import { Body, Controller, Get, Ip, Post } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { LockdownService } from './lockdown.service';

class ConfirmDto {
  /** Frontend must send an explicit confirmation flag (spec §7.3). */
  @IsBoolean()
  confirmed!: boolean;
}

@Controller('lockdown')
export class LockdownController {
  constructor(private readonly lockdown: LockdownService) {}

  @RequirePermission('system_lockdown')
  @Get('status')
  async status() {
    return { hasActiveRecoveryKey: await this.lockdown.hasActiveKey() };
  }

  /** Returns the raw key exactly once — never stored, never shown again. */
  @RequirePermission('system_lockdown')
  @Post('recovery-key')
  generateKey(@CurrentUser() user: AuthUser, @Ip() ip: string) {
    return this.lockdown.generateRecoveryKey(user.id, ip);
  }

  @RequirePermission('system_lockdown')
  @Post('trigger')
  async trigger(@CurrentUser() user: AuthUser, @Body() dto: ConfirmDto, @Ip() ip: string) {
    if (!dto.confirmed) {
      return {
        error: 'Confirmation required',
        warning:
          'Lockdown blacks out the ENTIRE system including your own session. Recovery is only possible with the paper recovery key at the wake URL.',
      };
    }
    return this.lockdown.lockdown(user.id, ip);
  }
}
