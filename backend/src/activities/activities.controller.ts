import {
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsIn, IsString, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';

class LogActivityDto {
  @IsIn(['CALL', 'NOTE'])
  type!: 'CALL' | 'NOTE';

  @IsString()
  @MinLength(1)
  detail!: string;
}

@Controller('leads/:leadId/activities')
export class ActivitiesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Log a call or note (spec: every touch is an activities row). */
  @RequirePermission('log_activity')
  @Post()
  async log(
    @CurrentUser() user: AuthUser,
    @Param('leadId', ParseIntPipe) leadId: number,
    @Body() dto: LogActivityDto,
  ) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');
    const canViewAll = (await this.permissions.check(user.roleId, 'view_all_leads')).allowed;
    if (!canViewAll && lead.assignedToId !== user.id && lead.createdById !== user.id) {
      throw new ForbiddenException('You can only log activity on your own leads');
    }
    return this.prisma.activity.create({
      data: { leadId, userId: user.id, type: dto.type, detail: dto.detail },
      include: { user: { select: { id: true, name: true } } },
    });
  }
}
