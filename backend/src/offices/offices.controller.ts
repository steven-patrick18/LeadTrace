import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';

class OfficeDto {
  @IsString()
  @MinLength(2)
  name!: string;
}

class UpdateOfficeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Offices — branches of the operation. Users belong to one; leads are stamped
 * with their creator's office; routing and the Manager bucket are scoped by it.
 * Admin manages the list (manage_offices); Manager holds VIEW for dropdowns.
 */
@Controller('offices')
export class OfficesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission('manage_offices')
  @Get()
  list() {
    return this.prisma.office.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { users: { where: { isActive: true } }, leads: true } } },
    });
  }

  @RequirePermission('manage_offices')
  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: OfficeDto, @Ip() ip: string) {
    this.assertWriteScope(user);
    const name = dto.name.trim();
    const exists = await this.prisma.office.findUnique({ where: { name } });
    if (exists) throw new BadRequestException(`Office "${name}" already exists`);
    const office = await this.prisma.office.create({ data: { name } });
    await this.audit.log({ userId: user.id, action: 'OFFICE_CREATED', ip, detail: { officeId: office.id, name } });
    return office;
  }

  @RequirePermission('manage_offices')
  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOfficeDto,
    @Ip() ip: string,
  ) {
    this.assertWriteScope(user);
    const office = await this.prisma.office.findUnique({ where: { id } });
    if (!office) throw new BadRequestException('Office not found');
    const name = dto.name?.trim();
    if (name && name !== office.name) {
      const taken = await this.prisma.office.findUnique({ where: { name } });
      if (taken) throw new BadRequestException(`Office "${name}" already exists`);
    }
    const updated = await this.prisma.office.update({
      where: { id },
      data: { name, isActive: dto.isActive },
    });
    await this.audit.log({
      userId: user.id, action: 'OFFICE_UPDATED', ip,
      detail: { officeId: id, fields: Object.keys(dto) },
    });
    return updated;
  }

  /** Manager holds manage_offices with VIEW scope — reads only. */
  private assertWriteScope(user: AuthUser) {
    if (user.permissionScope === 'VIEW') {
      throw new BadRequestException('View-only access — ask an Admin to change offices');
    }
  }
}
