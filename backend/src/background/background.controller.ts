import { Body, Controller, Get, Ip, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { BackgroundService } from './background.service';

class ConfigureDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) attestation?: string;
}

class RunDto {
  @IsString() @MinLength(3) purpose!: string;
}

/**
 * Regulated-data endpoints. Reads/config need view_regulated_data; running a
 * report needs run_background_report — both OFF by default (see the matrix).
 */
@Controller()
export class BackgroundController {
  constructor(private readonly background: BackgroundService) {}

  @RequirePermission('view_regulated_data')
  @Get('regulated-data/status')
  status() {
    return this.background.status();
  }

  /** Admin config read (Settings page) — separate from the view gate so an
   *  admin can manage the module even without view_regulated_data. */
  @RequirePermission('manage_permissions')
  @Get('regulated-data/config')
  config() {
    return this.background.status();
  }

  @RequirePermission('manage_permissions')
  @Post('regulated-data/configure')
  configure(@CurrentUser() user: AuthUser, @Body() dto: ConfigureDto, @Ip() ip: string) {
    return this.background.configure(user, dto.enabled, dto.attestation ?? '', ip);
  }

  @RequirePermission('view_regulated_data')
  @Get('leads/:id/background-report')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.background.get(id);
  }

  @RequirePermission('run_background_report')
  @Post('leads/:id/background-report')
  run(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number, @Body() dto: RunDto, @Ip() ip: string) {
    return this.background.run(user, id, dto.purpose, ip);
  }
}
