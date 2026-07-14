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
import { IsBoolean, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { DesksService } from './desks.service';

class ClockInDto {
  @IsString()
  @MinLength(3)
  batchCode!: string;
}

class CreateDeskDto {
  @IsString()
  @Matches(/^[A-Z0-9-]{3,20}$/, { message: 'Batch ID must be like DESK-07 (A-Z, 0-9, dashes)' })
  code!: string;

  @IsString() @MinLength(2) name!: string;
}

class UpdateDeskDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('desks')
export class DesksController {
  constructor(
    private readonly desks: DesksService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Every user: clock in/out with a batch id ───────────────

  @RequirePermission('view_own_leads')
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const session = await this.desks.activeSession(user.id);
    return session
      ? { clockedIn: true, sessionId: session.id, desk: { code: session.desk.code, name: session.desk.name }, since: session.startedAt }
      : { clockedIn: false };
  }

  @RequirePermission('view_own_leads')
  @Post('clock-in')
  clockIn(@CurrentUser() user: AuthUser, @Body() dto: ClockInDto, @Ip() ip: string) {
    return this.desks.clockIn(user, dto.batchCode, ip);
  }

  @RequirePermission('view_own_leads')
  @Post('clock-out')
  clockOut(@CurrentUser() user: AuthUser, @Ip() ip: string) {
    return this.desks.clockOut(user, ip);
  }

  // ── Floor management: manager VIEW, admin full ─────────────

  @RequirePermission('manage_desks')
  @Get('floor')
  floor() {
    return this.desks.floor();
  }

  @RequirePermission('manage_desks')
  @Post()
  async createDesk(@CurrentUser() user: AuthUser, @Body() dto: CreateDeskDto, @Ip() ip: string) {
    this.assertWrite(user);
    const code = dto.code.toUpperCase();
    if (await this.prisma.desk.findUnique({ where: { code } })) {
      throw new BadRequestException('A desk with that batch ID already exists');
    }
    const desk = await this.prisma.desk.create({ data: { code, name: dto.name } });
    await this.audit.log({ userId: user.id, action: 'DESK_CREATED', ip, detail: { code } });
    return desk;
  }

  @RequirePermission('manage_desks')
  @Patch(':id')
  async updateDesk(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeskDto,
    @Ip() ip: string,
  ) {
    this.assertWrite(user);
    const desk = await this.prisma.desk.update({ where: { id }, data: dto });
    await this.audit.log({ userId: user.id, action: 'DESK_UPDATED', ip, detail: { id, changes: Object.keys(dto) } });
    return desk;
  }

  @RequirePermission('manage_desks')
  @Post('sessions/:id/force-complete')
  forceComplete(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Ip() ip: string) {
    this.assertWrite(user);
    return this.desks.forceComplete(user, id, ip);
  }

  private assertWrite(user: AuthUser) {
    if (user.permissionScope === 'VIEW') {
      throw new ForbiddenException('manage_desks is view-only for your role');
    }
  }
}
