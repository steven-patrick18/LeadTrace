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
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';

class CreateUserDto {
  @IsString() @MinLength(2) name!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(10) password!: string;
  @IsInt() roleId!: number;
  @IsOptional() @IsInt() reportsToId?: number;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MinLength(10) password?: string;
  @IsOptional() @IsInt() roleId?: number;
  @IsOptional() @IsInt() reportsToId?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** manage_users with scope VIEW (Manager default) may list but not mutate. */
  @RequirePermission('manage_users')
  @Get()
  list() {
    return this.prisma.user.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true, name: true, email: true, isActive: true, createdAt: true,
        role: { select: { id: true, roleCode: true, displayName: true, tier: true } },
        reportsTo: { select: { id: true, name: true } },
      },
    });
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
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        email: dto.email?.toLowerCase().trim(),
        roleId: dto.roleId,
        reportsToId: dto.reportsToId,
        isActive: dto.isActive,
        ...(dto.password ? { passwordHash: await argon2.hash(dto.password) } : {}),
      },
      select: { id: true, name: true, email: true, roleId: true, isActive: true },
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
