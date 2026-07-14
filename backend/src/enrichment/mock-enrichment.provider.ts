import { Injectable } from '@nestjs/common';
import { EnrichmentDataProvider, PersonEnrichment } from './enrichment.types';

/**
 * Deterministic mock enrichment provider (dev = $0). The same phone number
 * always produces the same enrichment, so cache tests can assert equality and
 * demos are stable. Real adapters (Trestle, Endato, TLO, Twilio Lookup,
 * BatchData) implement the same interface and register in EnrichmentService.
 */

function hashPhone(phone: string): number {
  let h = 0;
  for (const c of phone) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

const CARRIERS = ['Verizon', 'T-Mobile', 'AT&T', 'US Cellular', 'Spectrum Mobile'];
const STREETS = ['Oak St', 'Maple Ave', 'Cedar Ln', 'Pine Rd', 'Elm Dr'];
const RELATIONS = ['spouse', 'sibling', 'parent', undefined];
const FIRSTS = ['Chris', 'Pat', 'Alex', 'Sam', 'Jordan', 'Taylor'];

@Injectable()
export class MockEnrichmentProvider implements EnrichmentDataProvider {
  readonly code = 'MOCK';

  async enrichPerson(input: { phone: string; firstName: string; lastName: string; zip?: string | null }): Promise<PersonEnrichment> {
    await new Promise((r) => setTimeout(r, 100)); // simulated latency
    const h = hashPhone(input.phone);
    const pick = <T>(arr: T[], salt: number) => arr[(h + salt) % arr.length];
    const digit = (n: number) => (h >> (n * 3)) % 10;

    const lineType = (['mobile', 'mobile', 'mobile', 'landline', 'voip'] as const)[h % 5];
    const active = digit(1) !== 9; // ~90% active
    const ownership = (['own', 'rent', 'unknown'] as const)[h % 3];
    const zip = input.zip ?? String(10000 + (h % 89999));

    return {
      aliases: digit(2) > 6 ? [`${input.firstName.charAt(0)}. ${input.lastName}`] : [],
      addresses: [
        {
          line1: `${100 + (h % 9800)} ${pick(STREETS, 1)}`,
          city: 'Mockville',
          state: 'FL',
          zip,
          county: 'Mock County',
          type: 'current',
        },
        ...(digit(3) > 5
          ? [{ line1: `${100 + ((h >> 2) % 9800)} ${pick(STREETS, 2)}`, city: 'Oldtown', state: 'GA', zip: '30303', type: 'past' as const, since: '2019' }]
          : []),
      ],
      phones: [
        {
          number: input.phone,
          lineType,
          carrier: pick(CARRIERS, 3),
          active,
          spamRisk: (['low', 'low', 'low', 'med', 'high'] as const)[digit(4) % 5],
          isPrimary: true,
        },
      ],
      emails: digit(5) > 2 ? [`${input.firstName}.${input.lastName}${h % 97}@example.com`.toLowerCase()] : [],
      ageRange: `${25 + (h % 8) * 5}-${29 + (h % 8) * 5}`,
      relatives:
        digit(6) > 3
          ? [{ name: `${pick(FIRSTS, 4)} ${input.lastName}`, relation: pick(RELATIONS, 5) }]
          : [],
      associates: digit(7) > 6 ? [{ name: `${pick(FIRSTS, 6)} Miller` }] : [],
      property: {
        ownership,
        ...(ownership === 'own' ? { estValue: 150000 + (h % 40) * 10000, type: 'single_family' } : {}),
      },
      // URL strings only, as a real provider would return them. NEVER fetched.
      socialUrls:
        digit(8) > 4
          ? [`https://www.linkedin.com/in/${input.firstName}-${input.lastName}-${h % 999}`.toLowerCase()]
          : [],
      providerConfidence: 0.6 + (h % 40) / 100,
      sourceProvider: this.code,
    };
  }
}
