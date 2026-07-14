import { Body, Controller, Get, Ip, Patch } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';

class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(5)
  routingAgingThresholdMinutes?: number;

  /** Quick batch-session duration — auto-logout after this many minutes. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  batchSessionMinutes?: number;

  @IsOptional()
  @IsBoolean()
  requireDeskForCalls?: boolean;
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('manage_permissions')
  @Get()
  async get() {
    const rows = await this.prisma.appSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  @RequirePermission('manage_permissions')
  @Patch()
  async update(@CurrentUser() user: AuthUser, @Body() dto: UpdateSettingsDto, @Ip() ip: string) {
    const changes: Record<string, string> = {};
    if (dto.routingAgingThresholdMinutes !== undefined) {
      changes.routing_aging_threshold_minutes = String(dto.routingAgingThresholdMinutes);
    }
    if (dto.batchSessionMinutes !== undefined) {
      changes.batch_session_minutes = String(dto.batchSessionMinutes);
    }
    if (dto.requireDeskForCalls !== undefined) {
      changes.require_desk_for_calls = String(dto.requireDeskForCalls);
    }
    for (const [key, value] of Object.entries(changes)) {
      await this.prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
    }
    await this.audit.log({ userId: user.id, action: 'SETTINGS_UPDATED', ip, detail: changes });
    return { ok: true };
  }
}
