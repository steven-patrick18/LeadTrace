import { BadRequestException } from '@nestjs/common';
import { CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';

const DEFAULT_REGION = (process.env.DEFAULT_PHONE_REGION || 'US') as CountryCode;

/**
 * Normalize any phone input to E.164 (spec §4 invariant 3).
 * Throws on invalid numbers — accuracy over permissiveness.
 */
export function toE164(input: string, region: CountryCode = DEFAULT_REGION): string {
  const parsed = parsePhoneNumberFromString(input.trim(), region);
  if (!parsed || !parsed.isValid()) {
    throw new BadRequestException(`Invalid phone number: ${input}`);
  }
  return parsed.number; // E.164
}

/** Non-throwing variant for search inputs where we fall back to digit matching. */
export function tryToE164(input: string, region: CountryCode = DEFAULT_REGION): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), region);
  return parsed && parsed.isValid() ? parsed.number : null;
}
