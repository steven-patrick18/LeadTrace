import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthUser, CurrentUser, RequirePermission } from '../common/decorators';
import { PermissionsService } from '../permissions/permissions.service';
import { ReportsService } from './reports.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Team-wide when the caller's role holds view_reports_team, else own-only. */
  private async scopeUserId(user: AuthUser): Promise<number | null> {
    const team = await this.permissions.check(user.roleId, 'view_reports_team');
    return team.allowed ? null : user.id;
  }

  @RequirePermission('view_reports_own')
  @Get('dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    return this.reports.dashboard(await this.scopeUserId(user));
  }

  @RequirePermission('view_reports_own')
  @Get('performance')
  async performance(@CurrentUser() user: AuthUser) {
    return this.reports.performance(await this.scopeUserId(user));
  }

  /** The Reports & Analysis page — team-wide by definition. */
  @RequirePermission('view_reports_team')
  @Get('analysis')
  analysis(@Query('days') days?: string) {
    return this.reports.analysis(days ? Math.min(365, Math.max(1, Number(days))) : 30);
  }

  @RequirePermission('export_data')
  @Get('export/performance.csv')
  @Header('Content-Type', 'text/csv')
  async exportPerformance(@Res() res: Response) {
    const csv = await this.reports.exportPerformanceCsv();
    res.setHeader('Content-Disposition', `attachment; filename="leadtrace-performance-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  @RequirePermission('view_api_costs')
  @Get('api-costs')
  apiCosts(@Query('days') days?: string) {
    return this.reports.apiCosts(days ? Math.min(365, Math.max(1, Number(days))) : 30);
  }

  @RequirePermission('view_enrichment_cost')
  @Get('enrichment-costs')
  enrichmentCosts(@Query('days') days?: string) {
    return this.reports.enrichmentCosts(days ? Math.min(365, Math.max(1, Number(days))) : 30);
  }

  @RequirePermission('export_data')
  @Get('export/leads.csv')
  @Header('Content-Type', 'text/csv')
  async exportLeads(@Res() res: Response) {
    const csv = await this.reports.exportLeadsCsv();
    res.setHeader('Content-Disposition', `attachment; filename="leadtrace-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }
}
