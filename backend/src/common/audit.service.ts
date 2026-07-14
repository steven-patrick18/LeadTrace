import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

/**
 * Append-only audit trail (spec §9): login, lead create, transfer request,
 * every routing decision, close, permission change, lockdown/wake.
 * DB triggers block UPDATE/DELETE on audit_log.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    userId?: number | null;
    action: string;
    detail?: Record<string, unknown>;
    ip?: string | null;
    tx?: Prisma.TransactionClient;
  }): Promise<void> {
    const client = params.tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        detail: (params.detail as Prisma.InputJsonValue) ?? undefined,
        ip: params.ip ?? null,
      },
    });
  }
}
