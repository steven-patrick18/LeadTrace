import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { LeadStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PermissionsService } from '../permissions/permissions.service';
import { CreateLeadInput, LeadsService } from './leads.service';

class LeadPhoneDto {
  @IsString()
  @MinLength(7)
  number!: string;

  @IsOptional()
  @IsString()
  lineType?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

class CreateLeadDto implements CreateLeadInput {
  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LeadPhoneDto)
  phones!: LeadPhoneDto[];

  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() zip?: string;
  @IsOptional() @IsString() sourceProvider?: string;
  @IsOptional() rawProviderData?: unknown;
  @IsOptional() @IsBoolean() force?: boolean;
}

class UpdateLeadDto {
  @IsOptional() @IsString() @MinLength(1) firstName?: string;
  @IsOptional() @IsString() @MinLength(1) lastName?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() zip?: string;
}

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly permissions: PermissionsService,
  ) {}

  @RequirePermission('create_lead')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLeadDto, @Ip() ip: string) {
    return this.leads.create(user, dto, ip);
  }

  /**
   * Guarded by the baseline view_own_leads; widened to ALL only when the
   * caller's role also holds view_all_leads — resolved from the matrix,
   * never hard-coded to a role (spec §0).
   */
  @RequirePermission('view_own_leads')
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: LeadStatus,
    @Query('tier') tier?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('scope') scope?: string,
  ) {
    const canViewAll = (await this.permissions.check(user.roleId, 'view_all_leads')).allowed;
    if (scope === 'all' && !canViewAll) {
      throw new ForbiddenException('Missing permission: view_all_leads');
    }
    const effectiveScope = canViewAll && scope !== 'own' ? 'ALL' : 'OWN';
    return this.leads.list(user, {
      scope: effectiveScope,
      status,
      tier,
      q,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @RequirePermission('view_own_leads')
  @Get(':id')
  async getOne(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    const canViewAll = (await this.permissions.check(user.roleId, 'view_all_leads')).allowed;
    user.permissionScope = canViewAll ? 'ALL' : user.permissionScope;
    return this.leads.getOne(user, id);
  }

  @RequirePermission('edit_lead')
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateLeadDto,
    @Ip() ip: string,
  ) {
    return this.leads.update(user, id, dto, ip);
  }
}
