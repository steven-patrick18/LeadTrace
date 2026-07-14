import { Body, Controller, Get, Ip, Patch } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';

class UpdateSettingsDto {
  @IsInt()
  @Min(5)
  routingAgingThresholdMinutes!: number;
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
    await this.prisma.appSetting.upsert({
      where: { key: 'routing_aging_threshold_minutes' },
      update: { value: String(dto.routingAgingThresholdMinutes) },
      create: { key: 'routing_aging_threshold_minutes', value: String(dto.routingAgingThresholdMinutes) },
    });
    await this.audit.log({
      userId: user.id,
      action: 'SETTINGS_UPDATED',
      ip,
      detail: { routingAgingThresholdMinutes: dto.routingAgingThresholdMinutes },
    });
    return { ok: true };
  }
}
