import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { LeadAccessService } from '../leads/lead-access.service';
import { NotificationsService } from '../notifications/notifications.service';

class CommentDto {
  @IsString()
  @MinLength(1)
  body!: string;
}

/**
 * Lead comments. Who may write them (per requirement): the Manager, the Admin,
 * and the lead's owners — anyone who actually worked it (creator, assignee,
 * routed to/from it, or logged activity on it). Enforced by
 * LeadAccessService.assertParticipant, not by role names.
 * Works on closed leads too: a WON lead stays with its Closer for post-sale
 * processing, and the discussion continues there.
 */
@Controller('leads/:leadId/comments')
export class CommentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: LeadAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  @RequirePermission('comment_lead')
  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('leadId', ParseIntPipe) leadId: number) {
    await this.access.assertViewAccess(user, leadId);
    return this.prisma.leadComment.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, role: { select: { displayName: true } } } } },
    });
  }

  @RequirePermission('comment_lead')
  @Post()
  async add(
    @CurrentUser() user: AuthUser,
    @Param('leadId', ParseIntPipe) leadId: number,
    @Body() dto: CommentDto,
    @Ip() ip: string,
  ) {
    const lead = await this.access.assertParticipant(user, leadId);
    const comment = await this.prisma.leadComment.create({
      data: { leadId, userId: user.id, body: dto.body.trim() },
      include: { user: { select: { id: true, name: true, role: { select: { displayName: true } } } } },
    });
    await this.audit.log({ userId: user.id, action: 'LEAD_COMMENT_ADDED', ip, detail: { leadId } });
    await this.notifications.notifyLeadWatchers(leadId, user.id, {
      type: 'LEAD_COMMENT',
      title: `💬 ${user.name} commented on lead #${leadId} (${lead.firstName} ${lead.lastName})`,
      body: dto.body.trim().slice(0, 140),
    });
    return comment;
  }
}
