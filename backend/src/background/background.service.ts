import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { SearchBugProvider } from '../providers/searchbug.provider';

/**
 * Regulated-data (FCRA/DPPA) module — background / criminal / vehicle records.
 *
 * DELIBERATELY GATED. A run requires ALL of:
 *   1. the module is enabled (regulated_data_enabled setting), AND
 *   2. a permissible-use attestation has been recorded, AND
 *   3. the caller holds run_background_report (off by default), AND
 *   4. a permissible purpose is supplied per request.
 * Every run is stored with its purpose + who + when for the FCRA audit trail.
 */
@Injectable()
export class BackgroundService {
  // The lawful bases a client may assert. Sales/marketing is NOT here — that is
  // exactly the use FCRA/DPPA forbids, so it cannot be selected.
  static readonly PERMISSIBLE_PURPOSES = [
    'Written consumer consent on file',
    'Collection of a debt owed by the consumer',
    'Licensed investigation / legal proceeding',
    'Insurance underwriting the consumer applied for',
    'Tenant / employment screening with FCRA adverse-action process',
    'Fraud prevention / identity verification',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly searchbug: SearchBugProvider,
  ) {}

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  /** Module status for the UI (enabled + whether an attestation is on file). */
  async status() {
    const enabled = (await this.setting('regulated_data_enabled')) === 'true';
    const attestation = await this.setting('regulated_data_attestation');
    return {
      enabled,
      hasAttestation: !!attestation && attestation.trim().length > 0,
      attestation: attestation ?? '',
      purposes: BackgroundService.PERMISSIBLE_PURPOSES,
    };
  }

  /** Admin: enable/disable the module and record the permissible-use attestation. */
  async configure(user: AuthUser, enabled: boolean, attestation: string, ip?: string) {
    if (enabled && (!attestation || attestation.trim().length < 20)) {
      throw new BadRequestException(
        'To enable regulated data you must record a permissible-use attestation (your lawful basis, min 20 chars).',
      );
    }
    await this.prisma.appSetting.upsert({
      where: { key: 'regulated_data_enabled' },
      update: { value: String(enabled) },
      create: { key: 'regulated_data_enabled', value: String(enabled) },
    });
    await this.prisma.appSetting.upsert({
      where: { key: 'regulated_data_attestation' },
      update: { value: attestation ?? '' },
      create: { key: 'regulated_data_attestation', value: attestation ?? '' },
    });
    await this.audit.log({
      userId: user.id,
      action: enabled ? 'REGULATED_DATA_ENABLED' : 'REGULATED_DATA_DISABLED',
      ip,
      detail: { enabled, attestationLength: (attestation ?? '').length },
    });
    return this.status();
  }

  /** View the stored background report for a lead (gated by view_regulated_data). */
  async get(leadId: number) {
    const row = await this.prisma.leadBackgroundReport.findFirst({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      include: { runBy: { select: { id: true, name: true } } },
    });
    if (!row) throw new NotFoundException('No background report has been run for this lead');
    return row;
  }

  /** Run a background report (gated by run_background_report + the checks below). */
  async run(user: AuthUser, leadId: number, purpose: string, ip?: string) {
    if ((await this.setting('regulated_data_enabled')) !== 'true') {
      throw new ForbiddenException('The regulated-data module is disabled. An admin must enable it in Settings.');
    }
    const attestation = await this.setting('regulated_data_attestation');
    if (!attestation || attestation.trim().length < 20) {
      throw new ForbiddenException('No permissible-use attestation is on file. An admin must record one in Settings.');
    }
    if (!purpose || !BackgroundService.PERMISSIBLE_PURPOSES.includes(purpose)) {
      throw new BadRequestException('A valid permissible purpose is required for every background report.');
    }

    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead not found');

    let parsed: ReturnType<SearchBugProvider['parseBackground']>;
    try {
      const raw = await this.searchbug.backgroundReport({
        phone: lead.primaryPhone,
        firstName: lead.firstName,
        lastName: lead.lastName,
        zip: lead.zip,
      });
      parsed = this.searchbug.parseBackground(raw);
    } catch (e) {
      throw new BadRequestException(`Background report failed: ${(e as Error).message}`);
    }

    const row = await this.prisma.leadBackgroundReport.create({
      data: {
        leadId,
        data: parsed as unknown as Prisma.InputJsonValue,
        purpose,
        runById: user.id,
      },
    });
    // FCRA audit trail: who accessed regulated data on whom, for what purpose.
    await this.audit.log({
      userId: user.id,
      action: 'BACKGROUND_REPORT_RUN',
      ip,
      detail: {
        leadId,
        purpose,
        criminalCount: parsed.criminalRecords.length,
        vehicleCount: parsed.vehicles.length,
      },
    });
    return this.prisma.leadBackgroundReport.findUnique({
      where: { id: row.id },
      include: { runBy: { select: { id: true, name: true } } },
    });
  }
}
