import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LeadStatus, Prisma } from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/decorators';
import { toE164 } from '../common/phone.util';
import { PrismaService } from '../common/prisma.service';
import { LeadAccessService } from './lead-access.service';

export interface CreateLeadInput {
  firstName: string;
  lastName: string;
  phones: Array<{ number: string; lineType?: string; isPrimary?: boolean }>;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  sourceProvider?: string;
  rawProviderData?: unknown;
  /** Set true to create anyway after a duplicate-phone warning. */
  force?: boolean;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: LeadAccessService,
  ) {}

  /**
   * One-click convert (spec §5 step 1): status NEW, tier AGENT, assigned_to = creator.
   * This is the ONLY place outside RoutingService that sets assigned_to, and only
   * ever at creation time — spec §4 invariant 1 allows initial assignment here.
   */
  async create(user: AuthUser, input: CreateLeadInput, ip?: string) {
    if (!input.phones?.length) throw new BadRequestException('At least one phone is required');
    const phones = input.phones.map((p, i) => ({
      number: toE164(p.number),
      lineType: p.lineType ?? 'unknown',
      isPrimary: p.isPrimary ?? i === 0,
    }));
    if (!phones.some((p) => p.isPrimary)) phones[0].isPrimary = true;
    const primary = phones.find((p) => p.isPrimary)!;

    // Duplicate-phone warning (spec Phase 2)
    const duplicates = await this.prisma.leadPhone.findMany({
      where: { phone: { in: phones.map((p) => p.number) } },
      include: { lead: { select: { id: true, firstName: true, lastName: true, status: true, currentTier: true } } },
    });
    if (duplicates.length && !input.force) {
      throw new ConflictException({
        message: 'A lead with this phone number already exists',
        duplicates: duplicates.map((d) => ({
          leadId: d.lead.id,
          name: `${d.lead.firstName} ${d.lead.lastName}`,
          phone: d.phone,
          status: d.lead.status,
          tier: d.lead.currentTier,
        })),
      });
    }

    const lead = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          createdById: user.id,
          assignedToId: user.id,
          currentTier: 'AGENT',
          status: 'NEW',
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          primaryPhone: primary.number,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          zip: input.zip ?? null,
          sourceProvider: input.sourceProvider ?? null,
          rawProviderData: (input.rawProviderData as Prisma.InputJsonValue) ?? undefined,
          phones: {
            create: phones.map((p) => ({ phone: p.number, lineType: p.lineType, isPrimary: p.isPrimary })),
          },
        },
        include: { phones: true },
      });
      await tx.activity.create({
        data: {
          leadId: created.id,
          userId: user.id,
          type: 'STATUS_CHANGE',
          detail: `Lead created from ${input.sourceProvider ?? 'manual entry'} (status NEW, tier AGENT)`,
        },
      });
      await this.audit.log({
        userId: user.id,
        action: 'LEAD_CREATED',
        ip,
        detail: { leadId: created.id, phone: primary.number, source: input.sourceProvider ?? 'manual' },
        tx,
      });
      return created;
    });
    return lead;
  }

  /**
   * List leads under the caller's admitted scope:
   * view_all_leads (ALL) → everything; view_own_leads → created-by-me OR assigned-to-me.
   */
  async list(
    user: AuthUser,
    opts: { scope: 'ALL' | 'OWN'; status?: LeadStatus; tier?: string; q?: string; page?: number; pageSize?: number },
  ) {
    // Admin-revoked leads never appear in this user's lists
    const where: Prisma.LeadWhereInput = { ...(await this.access.blockFilter(user)) };
    if (opts.scope !== 'ALL') {
      where.OR = [{ assignedToId: user.id }, { createdById: user.id }];
    }
    if (opts.status) where.status = opts.status;
    if (opts.tier) where.currentTier = opts.tier as never;
    if (opts.q?.trim()) {
      const q = opts.q.trim();
      const digits = q.replace(/\D/g, '');
      where.AND = [
        {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { city: { contains: q, mode: 'insensitive' } },
            ...(digits.length >= 4 ? [{ phones: { some: { phone: { contains: digits } } } }] : []),
          ],
        },
      ];
    }
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
    const [total, items] = await this.prisma.$transaction([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          assignedTo: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
        },
      }),
    ]);
    return { total, page, pageSize, items };
  }

  async getOne(user: AuthUser, id: number) {
    if (await this.access.isBlocked(user.id, id, user.roleId)) {
      throw new ForbiddenException('Your access to this lead has been revoked by an admin');
    }
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        phones: true,
        assignedTo: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        activities: {
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { id: true, name: true } } },
        },
        routingHistory: { orderBy: { createdAt: 'asc' } },
        queueEntries: { where: { status: 'PENDING' } },
        customValues: { include: { field: true } },
      },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    if (user.permissionScope !== 'ALL' && lead.assignedToId !== user.id && lead.createdById !== user.id) {
      throw new ForbiddenException('You can only view your own leads');
    }
    return lead;
  }

  /**
   * Scoped edit (spec matrix: OWN for Agent, ASSIGNED for SS/Closer, ALL for Manager/Admin).
   * Contact details stay editable so info confirmed with the customer can be
   * corrected any time; changes land on the timeline. NOTE: assigned_to /
   * current_tier / status are NOT editable here — the routing service owns
   * those (spec §4 invariant 1).
   */
  async update(
    user: AuthUser,
    id: number,
    data: Partial<Pick<CreateLeadInput, 'firstName' | 'lastName' | 'address' | 'city' | 'state' | 'zip'>> & {
      primaryPhone?: string;
    },
    ip?: string,
  ) {
    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (await this.access.isBlocked(user.id, id, user.roleId)) {
      throw new ForbiddenException('Your access to this lead has been revoked by an admin');
    }

    const scope = user.permissionScope;
    if (scope === 'OWN' && lead.createdById !== user.id) {
      throw new ForbiddenException('edit_lead scope OWN: you may only edit leads you created');
    }
    if (scope === 'ASSIGNED' && lead.assignedToId !== user.id) {
      throw new ForbiddenException('edit_lead scope ASSIGNED: you may only edit leads assigned to you');
    }

    const newPhone = data.primaryPhone?.trim() ? toE164(data.primaryPhone) : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (newPhone && newPhone !== lead.primaryPhone) {
        const primaryRow = await tx.leadPhone.findFirst({ where: { leadId: id, isPrimary: true } });
        if (primaryRow) await tx.leadPhone.update({ where: { id: primaryRow.id }, data: { phone: newPhone } });
        else await tx.leadPhone.create({ data: { leadId: id, phone: newPhone, isPrimary: true } });
        await tx.activity.create({
          data: {
            leadId: id,
            userId: user.id,
            type: 'NOTE',
            detail: `Primary phone corrected: ${lead.primaryPhone} → ${newPhone}`,
          },
        });
      }
      return tx.lead.update({
        where: { id },
        data: {
          firstName: data.firstName?.trim(),
          lastName: data.lastName?.trim(),
          address: data.address,
          city: data.city,
          state: data.state,
          zip: data.zip,
          ...(newPhone ? { primaryPhone: newPhone } : {}),
        },
      });
    });
    await this.audit.log({
      userId: user.id,
      action: 'LEAD_UPDATED',
      ip,
      detail: { leadId: id, fields: Object.keys(data).filter((k) => data[k as keyof typeof data] !== undefined) },
    });
    return updated;
  }
}
