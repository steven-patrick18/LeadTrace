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
import { InternalDncProvider } from './enrichment/internal-dnc.provider';
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
import { OfficesController } from './offices/offices.controller';
import { PermissionsController } from './permissions/permissions.controller';
import { PermissionsService } from './permissions/permissions.service';
import { PermissionSyncService } from './permissions/permission-sync.service';
import { BatchDataProvider } from './providers/batchdata.provider';
import { EndatoProvider } from './providers/endato.provider';
import { IpqsProvider } from './providers/ipqs.provider';
import { MelissaProvider } from './providers/melissa.provider';
import { MockProvider } from './providers/mock.provider';
import { NumverifyProvider } from './providers/numverify.provider';
import { OwnServerProvider } from './providers/own-server.provider';
import { ProviderCatalogService } from './providers/provider-catalog.service';
import { SearchBugProvider } from './providers/searchbug.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { TrestleProvider } from './providers/trestle.provider';
import { TwilioLookupProvider } from './providers/twilio-lookup.provider';
import { ProvidersController } from './providers/providers.controller';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { AgingScheduler } from './routing/aging.scheduler';
import { RoutingController } from './routing/routing.controller';
import { RoutingService } from './routing/routing.service';
import { SearchController } from './search/search.controller';
import { SearchService } from './search/search.service';
import { SettingsController } from './settings/settings.controller';
import { SystemController } from './system/system.controller';
import { TierStatusesController } from './tier-statuses/tier-statuses.controller';
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
    TierStatusesController,
    SystemController,
    OfficesController,
  ],
  providers: [
    PrismaService,
    CacheService,
    AuditService,
    AuthService,
    PermissionsService,
    PermissionSyncService,
    MockProvider,
    OwnServerProvider,
    BatchDataProvider,
    TrestleProvider,
    MelissaProvider,
    TwilioLookupProvider,
    IpqsProvider,
    NumverifyProvider,
    EndatoProvider,
    SearchBugProvider,
    ProviderCatalogService,
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
    InternalDncProvider,
    EnrichmentService,
    // Global guard order matters: authenticate, then authorize (spec §3).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
