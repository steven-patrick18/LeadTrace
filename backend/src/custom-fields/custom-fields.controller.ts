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
  Put,
} from '@nestjs/common';
import { CustomFieldType } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { AuditService } from '../common/audit.service';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { LeadAccessService } from '../leads/lead-access.service';

class CreateFieldDto {
  @IsString() @MinLength(2) label!: string;
  @IsOptional() @IsEnum(CustomFieldType) fieldType?: CustomFieldType;
  @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
  @IsOptional() @IsInt() sortOrder?: number;
}

class UpdateFieldDto {
  @IsOptional() @IsString() @MinLength(2) label?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class SetValueDto {
  @IsInt() fieldId!: number;
  @IsString() value!: string;
}

@Controller()
export class CustomFieldsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: LeadAccessService,
  ) {}

  /** Every user needs the field definitions to render lead forms. */
  @RequirePermission('view_own_leads')
  @Get('custom-fields')
  list() {
    return this.prisma.customFieldDef.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  /** Admin sees inactive definitions too, for management. */
  @RequirePermission('manage_custom_fields')
  @Get('custom-fields/all')
  listAll() {
    return this.prisma.customFieldDef.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  }

  @RequirePermission('manage_custom_fields')
  @Post('custom-fields')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateFieldDto, @Ip() ip: string) {
    if (dto.fieldType === 'DROPDOWN' && !dto.options?.length) {
      throw new BadRequestException('Dropdown fields need at least one option');
    }
    const field = await this.prisma.customFieldDef.create({
      data: {
        label: dto.label.trim(),
        fieldType: dto.fieldType ?? 'TEXT',
        options: dto.options ?? undefined,
        sortOrder: dto.sortOrder ?? 0,
        createdBy: user.id,
      },
    });
    await this.audit.log({
      userId: user.id, action: 'CUSTOM_FIELD_CREATED', ip,
      detail: { fieldId: field.id, label: field.label, type: field.fieldType },
    });
    return field;
  }

  /** Deactivate instead of delete — existing values stay auditable. */
  @RequirePermission('manage_custom_fields')
  @Patch('custom-fields/:id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFieldDto,
    @Ip() ip: string,
  ) {
    const field = await this.prisma.customFieldDef.update({
      where: { id },
      data: {
        label: dto.label?.trim(),
        options: dto.options,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });
    await this.audit.log({
      userId: user.id, action: 'CUSTOM_FIELD_UPDATED', ip,
      detail: { fieldId: id, changes: Object.keys(dto) },
    });
    return field;
  }

  /**
   * Fill or update a value — stays editable so details confirmed with the
   * customer can be corrected any time. Uses edit_lead scope (OWN/ASSIGNED/ALL)
   * plus the admin access-block check; every change lands on the timeline.
   */
  @RequirePermission('edit_lead')
  @Put('leads/:leadId/custom-values')
  async setValue(
    @CurrentUser() user: AuthUser,
    @Param('leadId', ParseIntPipe) leadId: number,
    @Body() dto: SetValueDto,
    @Ip() ip: string,
  ) {
    const lead = await this.access.assertViewAccess(user, leadId);
    const scope = user.permissionScope;
    if (scope === 'OWN' && lead.createdById !== user.id) {
      throw new ForbiddenException('edit_lead scope OWN: you may only edit leads you created');
    }
    if (scope === 'ASSIGNED' && lead.assignedToId !== user.id) {
      throw new ForbiddenException('edit_lead scope ASSIGNED: you may only edit leads assigned to you');
    }

    const field = await this.prisma.customFieldDef.findUnique({ where: { id: dto.fieldId } });
    if (!field || !field.isActive) throw new BadRequestException('Unknown or inactive field');
    if (field.fieldType === 'NUMBER' && dto.value.trim() && Number.isNaN(Number(dto.value))) {
      throw new BadRequestException(`${field.label} must be a number`);
    }
    if (field.fieldType === 'DROPDOWN') {
      const opts = (field.options as string[]) ?? [];
      if (dto.value.trim() && !opts.includes(dto.value)) {
        throw new BadRequestException(`${field.label} must be one of: ${opts.join(', ')}`);
      }
    }

    const before = await this.prisma.leadCustomValue.findUnique({
      where: { leadId_fieldId: { leadId, fieldId: dto.fieldId } },
    });
    const saved = await this.prisma.leadCustomValue.upsert({
      where: { leadId_fieldId: { leadId, fieldId: dto.fieldId } },
      update: { value: dto.value, updatedBy: user.id },
      create: { leadId, fieldId: dto.fieldId, value: dto.value, updatedBy: user.id },
    });
    await this.prisma.activity.create({
      data: {
        leadId,
        userId: user.id,
        type: 'NOTE',
        detail: before
          ? `Field "${field.label}" updated: "${before.value}" → "${dto.value}"`
          : `Field "${field.label}" set to "${dto.value}"`,
      },
    });
    await this.audit.log({
      userId: user.id, action: 'LEAD_FIELD_UPDATED', ip,
      detail: { leadId, fieldId: dto.fieldId, label: field.label },
    });
    return saved;
  }
}
