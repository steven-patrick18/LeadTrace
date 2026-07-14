import { Injectable } from '@nestjs/common';
import { MockProvider } from './mock.provider';
import { PersonDataProvider } from './provider.interface';

/**
 * Adapter registry — the single place that knows which provider codes have a
 * working adapter. A provider can be cataloged (credentials stored, docs shown)
 * before its adapter exists, but it cannot be ACTIVATED until the adapter is
 * implemented and registered here.
 */
@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<string, PersonDataProvider>();

  constructor(mock: MockProvider) {
    this.register(mock);
    // Real adapters (EndatoProvider, TrestleProvider, …) register here as they
    // are implemented — no other file needs to change.
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
