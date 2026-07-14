import { Injectable } from '@nestjs/common';
import { DncScrubProvider, DncStatus } from './enrichment.types';

/**
 * Deterministic mock DNC/litigator scrub (dev = $0). Real scrub services
 * (DNC.com, Contact Center Compliance, RealValidation) implement the same
 * interface. Deterministic rules so demos and tests are repeatable:
 *   - last digit 7  → national DNC
 *   - last digit 4  → state DNC
 *   - ends in "13"  → litigator list
 */
@Injectable()
export class MockDncProvider implements DncScrubProvider {
  readonly code = 'MOCK_DNC';

  async scrub(phone: string) {
    await new Promise((r) => setTimeout(r, 60));
    const last = phone.slice(-1);
    const lastTwo = phone.slice(-2);
    return {
      nationalDncStatus: (last === '7' ? 'on_list' : 'clear') as DncStatus,
      stateDncStatus: (last === '4' ? 'on_list' : 'clear') as DncStatus,
      litigatorFlag: lastTwo === '13',
    };
  }
}
