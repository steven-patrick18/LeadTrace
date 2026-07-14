import { Injectable } from '@nestjs/common';
import { BatchDataProvider } from './batchdata.provider';
import { EndatoProvider } from './endato.provider';
import { IpqsProvider } from './ipqs.provider';
import { MelissaProvider } from './melissa.provider';
import { MockProvider } from './mock.provider';
import { NumverifyProvider } from './numverify.provider';
import { OwnServerProvider } from './own-server.provider';
import { SearchBugProvider } from './searchbug.provider';
import { PersonDataProvider } from './provider.interface';
import { TrestleProvider } from './trestle.provider';
import { TwilioLookupProvider } from './twilio-lookup.provider';

/**
 * Adapter registry — the single place that knows which provider codes have a
 * working adapter. A provider can be cataloged (credentials stored, docs shown)
 * before its adapter exists, but it cannot be ACTIVATED until the adapter is
 * implemented and registered here.
 */
@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<string, PersonDataProvider>();

  constructor(
    mock: MockProvider,
    engine: OwnServerProvider,
    batchData: BatchDataProvider,
    trestle: TrestleProvider,
    melissa: MelissaProvider,
    twilio: TwilioLookupProvider,
    ipqs: IpqsProvider,
    numverify: NumverifyProvider,
    endato: EndatoProvider,
    searchbug: SearchBugProvider,
  ) {
    this.register(mock);
    this.register(engine); // free self-hosted tier
    this.register(batchData);
    this.register(trestle);
    this.register(melissa);
    this.register(twilio); // easy: caller name + line type
    this.register(ipqs); // easy: free 5k/mo, fraud/spam score
    this.register(numverify); // easy: free phone validation
    this.register(endato); // DEEP: name + aliases + addresses + relatives + emails
    this.register(searchbug); // DEEP: reverse phone → name + addresses + relatives
    // IDI adapter registers here when implemented — no other change.
  }

  register(adapter: PersonDataProvider) {
    this.adapters.set(adapter.code, adapter);
  }

  get(code: string): PersonDataProvider | undefined {
    return this.adapters.get(code);
  }

  isImplemented(code: string): boolean {
    return this.adapters.has(code);
  }

  implementedCodes(): string[] {
    return [...this.adapters.keys()];
  }
}
