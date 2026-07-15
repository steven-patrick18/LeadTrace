import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';

class CreateUserDto {
  @IsString() @MinLength(2) name!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(10) password!: string;
  @IsInt() roleId!: number;
  @IsOptional() @IsInt() reportsToId?: number;
  @IsOptional() @IsInt() officeId?: number;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MinLength(10) password?: string;
  @IsOptional() @IsInt() roleId?: number;
  @IsOptional() @IsInt() reportsToId?: number;
  /** null clears the office (user floats across all offices) */
  @IsOptional() officeId?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Assign a specific batch ID (must be unique; uppercase letters/digits/dashes). */
  @IsOptional() @Matches(/^[A-Z0-9-]{4,20}$/i, { message: 'Batch ID must be 4-20 chars: letters, digits, dashes' })
  batchId?: string;
}

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** manage_users with scope VIEW (Manager default) may list but not mutate.
   *  Batch IDs are quasi-credentials: only full (non-VIEW) managers see them. */
  @RequirePermission('manage_users')
  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.user.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true, name: true, email: true, isActive: true, createdAt: true, batchId: true,
        role: { select: { id: true, roleCode: true, displayName: true, tier: true } },
        reportsTo: { select: { id: true, name: true } },
        office: { select: { id: true, name: true } },
      },
    });
    if (user.permissionScope === 'VIEW') {
      return rows.map((r) => ({ ...r, batchId: r.batchId ? '••••••' : null }));
    }
    return rows;
  }

  /**
   * Per-user overview for the expanded Users page: performance counters,
   * currently assigned leads, recent activity, live desk/batch state.
   * VIEW scope (Manager) may read this — it's oversight, not mutation.
   */
  @RequirePermission('manage_users')
  @Get(':id/overview')
  async overview(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const targetRaw = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true, name: true, email: true, isActive: true, batchId: true, createdAt: true,
        role: { select: { id: true, roleCode: true, displayName: true } },
        reportsTo: { select: { id: true, name: true } },
        office: { select: { id: true, name: true } },
      },
    });
    if (!targetRaw) throw new BadRequestException('User not found');
    // Batch IDs are quasi-credentials — masked for VIEW-scope callers.
    const target =
      user.permissionScope === 'VIEW' && targetRaw.batchId
        ? { ...targetRaw, batchId: '••••••' }
        : targetRaw;

    const [createdCount, activeAssigned, callsLogged, transfersRaised, leadsReceived, closedWon, closedLost,
      assignedLeads, recentActivity, deskSession, comments] = await Promise.all([
      this.prisma.lead.count({ where: { createdById: id } }),
      this.prisma.lead.count({ where: { assignedToId: id, status: { in: ['NEW', 'IN_PROGRESS', 'PENDING_ROUTING'] } } }),
      this.prisma.activity.count({ where: { userId: id, type: 'CALL' } }),
      this.prisma.routingQueue.count({ where: { raisedById: id } }),
      this.prisma.routingHistory.count({ where: { toUserId: id } }),
      this.prisma.activity.count({ where: { userId: id, type: 'STATUS_CHANGE', detail: { startsWith: 'Deal WON' } } }),
      this.prisma.activity.count({ where: { userId: id, type: 'STATUS_CHANGE', detail: { startsWith: 'Deal lost' } } }),
      this.prisma.lead.findMany({
        where: { assignedToId: id },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, firstName: true, lastName: true, primaryPhone: true, currentTier: true, status: true, updatedAt: true },
      }),
      this.prisma.activity.findMany({
        where: { userId: id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { id: true, type: true, detail: true, createdAt: true, leadId: true },
      }),
      this.prisma.deskSession.findFirst({
        where: { userId: id, endedAt: null },
        include: { desk: { select: { code: true } } },
      }),
      this.prisma.leadComment.count({ where: { userId: id } }),
    ]);

    return {
      user: target,
      stats: { createdCount, activeAssigned, callsLogged, transfersRaised, leadsReceived, closedWon, closedLost, comments },
      assignedLeads,
      recentActivity,
      desk: deskSession ? { code: deskSession.desk.code, since: deskSession.startedAt } : null,
    };
  }

  /** Everyone can see their OWN batch ID ("everyone gets their id"). */
  @RequirePermission('view_own_leads')
  @Get('my-batch-id')
  async myBatchId(@CurrentUser() user: AuthUser) {
    const me = await this.prisma.user.findUnique({ where: { id: user.id }, select: { batchId: true } });
    return { batchId: me?.batchId ?? null };
  }

  /** Rotate a user's batch ID (e.g. if it leaked). Admin-only (write scope). */
  @RequirePermission('manage_users')
  @Post(':id/regenerate-batch-id')
  async regenerateBatchId(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Ip() ip: string,
  ) {
    this.assertWriteScope(user);
    const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
    let batchId = '';
    for (let tries = 0; tries < 10; tries++) {
      batchId = 'LT-' + Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
      if (!(await this.prisma.user.findUnique({ where: { batchId } }))) break;
    }
    const updated = await this.prisma.user.update({
      where: { id },
      data: { batchId },
      select: { id: true, name: true, batchId: true },
    });
    await this.audit.log({ userId: user.id, action: 'BATCH_ID_REGENERATED', ip, detail: { targetUserId: id } });
    return updated;
  }

  @RequirePermission('manage_users')
  @Get('roles')
  roles() {
    return this.prisma.role.findMany({ orderBy: { id: 'asc' } });
  }

  @RequirePermission('manage_users')
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto, @Ip() ip: string) {
    this.assertWriteScope(user);
    const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role) throw new BadRequestException('Unknown role');
    const created = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email.toLowerCase().trim(),
        passwordHash: await argon2.hash(dto.password),
        roleId: dto.roleId,
        reportsToId: dto.reportsToId ?? null,
        officeId: dto.officeId ?? null,
      },
      select: { id: true, name: true, email: true, roleId: true },
    });
    await this.audit.log({
      userId: user.id, action: 'USER_CREATED', ip,
      detail: { newUserId: created.id, email: created.email, roleCode: role.roleCode },
    });
    return created;
  }

  @RequirePermission('manage_users')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
    @Ip() ip: string,
  ) {
    this.assertWriteScope(user);
    if (id === user.id && dto.isActive === false) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    let batchId: string | undefined;
    if (dto.batchId) {
      batchId = dto.batchId.toUpperCase();
      const taken = await this.prisma.user.findUnique({ where: { batchId } });
      if (taken && taken.id !== id) {
        throw new BadRequestException(`Batch ID ${batchId} is already assigned to ${taken.name}`);
      }
    }
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        email: dto.email?.toLowerCase().trim(),
        roleId: dto.roleId,
        reportsToId: dto.reportsToId,
        officeId: dto.officeId === undefined ? undefined : dto.officeId,
        isActive: dto.isActive,
        batchId,
        ...(dto.password ? { passwordHash: await argon2.hash(dto.password) } : {}),
      },
      select: { id: true, name: true, email: true, roleId: true, isActive: true, batchId: true, officeId: true },
    });
    await this.audit.log({
      userId: user.id, action: 'USER_UPDATED', ip,
      detail: { targetUserId: id, fields: Object.keys(dto).filter((k) => k !== 'password') },
    });
    return updated;
  }

  private assertWriteScope(user: AuthUser) {
    if (user.permissionScope === 'VIEW') {
      throw new ForbiddenException('manage_users is view-only for your role');
    }
  }
}
