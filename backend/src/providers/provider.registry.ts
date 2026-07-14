import { Injectable } from '@nestjs/common';
import { BatchDataProvider } from './batchdata.provider';
import { MelissaProvider } from './melissa.provider';
import { MockProvider } from './mock.provider';
import { OwnServerProvider } from './own-server.provider';
import { PersonDataProvider } from './provider.interface';
import { TrestleProvider } from './trestle.provider';

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
  ) {
    this.register(mock);
    this.register(engine); // free self-hosted tier
    this.register(batchData); // needs account balance
    this.register(trestle); // needs a valid key
    this.register(melissa); // needs an enabled license
    // Endato + IDI adapters register here when implemented — no other change.
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
