import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { PROVIDER_CATALOG } from './provider-catalog';

/**
 * Keeps the provider_settings CATALOG in sync with code on every boot.
 *
 * The System page "Update from Git" button pulls code + runs migrations, but NOT
 * the seed — so new providers would never appear on production without this.
 * On startup we upsert every catalog entry, refreshing ONLY the catalog copy
 * (name/description/URLs/howToGet). Admin-managed state — isActive, credentials,
 * costs, request limits — is never touched.
 */
@Injectable()
export class ProviderCatalogService implements OnModuleInit {
  private readonly logger = new Logger(ProviderCatalogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      let created = 0;
      for (const p of PROVIDER_CATALOG) {
        const { code, isActive, ...fields } = p;
        const existing = await this.prisma.providerSetting.findUnique({ where: { code } });
        if (!existing) created += 1;
        await this.prisma.providerSetting.upsert({
          where: { code },
          // refresh only the catalog copy; keep isActive/credentials/costs as-is
          update: {
            displayName: fields.displayName,
            description: fields.description,
            websiteUrl: fields.websiteUrl,
            signupUrl: fields.signupUrl,
            docsUrl: fields.docsUrl,
            howToGet: fields.howToGet,
          },
          create: { code, isActive: isActive ?? false, ...fields },
        });
      }
      this.logger.log(`Provider catalog synced (${PROVIDER_CATALOG.length} entries, ${created} new)`);
    } catch (e) {
      // Never block app startup on a catalog sync failure.
      this.logger.error(`Provider catalog sync failed: ${(e as Error).message}`);
    }
  }
}
