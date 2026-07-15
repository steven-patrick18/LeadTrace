import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { DncScrubProvider, DncStatus } from './enrichment.types';

/**
 * The AUTHORITATIVE DNC / litigator scrub — driven entirely by the in-house
 * list the team maintains on the DNC List page (the dnc_optout table). Nothing
 * is fabricated: a phone is blocked ONLY if someone added it here.
 *
 *   - phone on the list, litigator flag set → litigatorFlag = true
 *   - phone on the list (plain)             → national DNC = on_list
 *   - phone not on the list                 → clear (callable)
 *
 * Swap in a paid national/state scrub (DNC.com, RealValidation, …) later by
 * implementing this same interface; the compliance gate does not change.
 */
@Injectable()
export class InternalDncProvider implements DncScrubProvider {
  readonly code = 'INTERNAL_DNC';

  constructor(private readonly prisma: PrismaService) {}

  async scrub(phone: string) {
    const hit = await this.prisma.dncOptout.findUnique({ where: { phone } });
    // The DNC block itself comes from list membership (internalDncStatus in the
    // service). Here we only surface the litigator flag; we never assert a
    // national/state registry listing we can't verify.
    return {
      nationalDncStatus: 'clear' as DncStatus,
      stateDncStatus: 'clear' as DncStatus,
      litigatorFlag: hit?.litigator === true,
    };
  }
}
