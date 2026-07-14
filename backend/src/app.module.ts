import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';

import { ActivitiesController } from './activities/activities.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard, PermissionsGuard } from './auth/guards';
import { AuditService } from './common/audit.service';
import { CacheService } from './common/cache.service';
import { PrismaService } from './common/prisma.service';
import { EnrichmentController } from './enrichment/enrichment.controller';
import { EnrichmentService } from './enrichment/enrichment.service';
import { GeoService } from './enrichment/geo.service';
import { MockDncProvider } from './enrichment/mock-dnc.provider';
import { MockEnrichmentProvider } from './enrichment/mock-enrichment.provider';
import { ScoringService } from './enrichment/scoring.service';
import { CommentsController } from './comments/comments.controller';
import { CustomFieldsController } from './custom-fields/custom-fields.controller';
import { DesksController } from './desks/desks.controller';
import { DesksService } from './desks/desks.service';
import { LeadAccessController } from './leads/lead-access.controller';
import { LeadAccessService } from './leads/lead-access.service';
import { LeadsController } from './leads/leads.controller';
import { LeadsService } from './leads/leads.service';
import { LockdownController } from './lockdown/lockdown.controller';
import { LockdownGate } from './lockdown/lockdown.middleware';
import { LockdownService } from './lockdown/lockdown.service';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { PermissionsController } from './permissions/permissions.controller';
import { PermissionsService } from './permissions/permissions.service';
import { MockProvider } from './providers/mock.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { ProvidersController } from './providers/providers.controller';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { AgingScheduler } from './routing/aging.scheduler';
import { RoutingController } from './routing/routing.controller';
import { RoutingService } from './routing/routing.service';
import { SearchController } from './search/search.controller';
import { SearchService } from './search/search.service';
import { SettingsController } from './settings/settings.controller';
import { UsersController } from './users/users.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    JwtModule.register({ global: true }),
  ],
  controllers: [
    AuthController,
    SearchController,
    LeadsController,
    ActivitiesController,
    RoutingController,
    NotificationsController,
    ReportsController,
    UsersController,
    PermissionsController,
    ProvidersController,
    SettingsController,
    LockdownController,
    EnrichmentController,
    CustomFieldsController,
    CommentsController,
    LeadAccessController,
    DesksController,
  ],
  providers: [
    PrismaService,
    CacheService,
    AuditService,
    AuthService,
    PermissionsService,
    MockProvider,
    ProviderRegistry,
    SearchService,
    LeadAccessService,
    LeadsService,
    DesksService,
    NotificationsService,
    RoutingService,
    AgingScheduler,
    ReportsService,
    LockdownService,
    LockdownGate,
    GeoService,
    ScoringService,
    MockEnrichmentProvider,
    MockDncProvider,
    EnrichmentService,
    // Global guard order matters: authenticate, then authorize (spec §3).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
