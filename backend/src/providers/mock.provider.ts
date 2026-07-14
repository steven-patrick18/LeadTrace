import { Injectable } from '@nestjs/common';
import { PersonDataProvider, PersonMatch, PersonSearchQuery } from './provider.interface';

/**
 * Deterministic mock provider (spec Phase 2: "mock provider first so no money
 * is spent in dev"). Generates a stable synthetic population of 600 people from
 * a fixed PRNG seed, so the same search always returns the same results —
 * which also lets cache-behavior tests assert exact equality.
 * All phone numbers use the reserved fictional 555-01XX range (valid E.164
 * format, never real numbers).
 */

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = ['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda','David','Elizabeth','William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen','Christopher','Lisa','Daniel','Nancy','Matthew','Betty','Anthony','Margaret','Mark','Sandra','Donald','Ashley','Steven','Kimberly','Paul','Emily','Andrew','Donna','Joshua','Michelle'];
const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson'];
const STREETS = ['Oak St','Maple Ave','Cedar Ln','Pine Rd','Elm Dr','Washington Blvd','Lake View Ct','Sunset Ter','Hillcrest Ave','River Rd'];
const CITIES: Array<{ city: string; state: string; zips: string[]; area: string }> = [
  { city: 'Miami', state: 'FL', zips: ['33101', '33125', '33130'], area: '305' },
  { city: 'Tampa', state: 'FL', zips: ['33602', '33607'], area: '813' },
  { city: 'Atlanta', state: 'GA', zips: ['30303', '30309'], area: '404' },
  { city: 'Dallas', state: 'TX', zips: ['75201', '75204'], area: '214' },
  { city: 'Houston', state: 'TX', zips: ['77002', '77006'], area: '713' },
  { city: 'Phoenix', state: 'AZ', zips: ['85003', '85008'], area: '602' },
  { city: 'Denver', state: 'CO', zips: ['80202', '80205'], area: '303' },
  { city: 'Chicago', state: 'IL', zips: ['60601', '60614'], area: '312' },
  { city: 'New York', state: 'NY', zips: ['10001', '10016'], area: '212' },
  { city: 'Los Angeles', state: 'CA', zips: ['90012', '90026'], area: '213' },
];
const AGE_RANGES = ['25-29', '30-34', '35-39', '40-44', '45-49', '50-54', '55-59', '60-64'];
const LINE_TYPES: Array<'mobile' | 'landline' | 'voip'> = ['mobile', 'mobile', 'mobile', 'landline', 'voip'];

interface MockPerson {
  firstName: string;
  lastName: string;
  phones: Array<{ number: string; lineType: 'mobile' | 'landline' | 'voip'; isPrimary: boolean }>;
  address: string;
  city: string;
  state: string;
  zip: string;
  ageRange: string;
  relatives: string[];
}

function buildPopulation(): MockPerson[] {
  const rand = mulberry32(0x1eadace);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const people: MockPerson[] = [];
  for (let i = 0; i < 600; i++) {
    const loc = pick(CITIES);
    // Reserved fictional range: +1 <area> 555-01XX
    const line = String(i % 100).padStart(2, '0');
    const primary = `+1${loc.area}55501${line}`;
    const phones: MockPerson['phones'] = [
      { number: primary, lineType: pick(LINE_TYPES), isPrimary: true },
    ];
    if (rand() > 0.55) {
      const altLoc = pick(CITIES);
      phones.push({
        number: `+1${altLoc.area}55502${line}`,
        lineType: pick(LINE_TYPES),
        isPrimary: false,
      });
    }
    people.push({
      firstName: pick(FIRST_NAMES),
      lastName: pick(LAST_NAMES),
      phones,
      address: `${100 + Math.floor(rand() * 9800)} ${pick(STREETS)}`,
      city: loc.city,
      state: loc.state,
      zip: pick(loc.zips),
      ageRange: pick(AGE_RANGES),
      relatives:
        rand() > 0.4 ? [`${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`] : [],
    });
  }
  return people;
}

const POPULATION = buildPopulation();

@Injectable()
export class MockProvider implements PersonDataProvider {
  readonly code = 'MOCK';

  async searchPerson(query: PersonSearchQuery): Promise<PersonMatch[]> {
    // Simulate provider latency without breaking the <3s NFR
    await new Promise((r) => setTimeout(r, 120));

    const results: PersonMatch[] = [];
    for (const person of POPULATION) {
      let confidence = 0;
      let matched = false;

      if (query.phone) {
        if (person.phones.some((p) => p.number === query.phone)) {
          confidence += 70; // exact phone match — strongest identity signal
          matched = true;
        } else {
          continue; // phone searches are exact: no partial phone matches
        }
      }
      if (query.lastName) {
        if (person.lastName.toLowerCase() !== query.lastName.toLowerCase()) {
          if (!query.phone) continue;
        } else {
          confidence += 15;
          matched = true;
          if (query.firstName) {
            if (person.firstName.toLowerCase() === query.firstName.toLowerCase()) confidence += 15;
            else if (person.firstName.toLowerCase().startsWith(query.firstName.toLowerCase())) confidence += 8;
            else if (!query.phone) continue;
          }
        }
      }
      if (query.zip) {
        if (person.zip === query.zip) {
          confidence += query.phone || query.lastName ? 10 : 40;
          matched = true;
        } else if (!query.phone && !query.lastName) {
          continue;
        } else {
          confidence -= 10; // conflicting location lowers confidence
        }
      }

      if (!matched) continue;
      results.push({
        firstName: person.firstName,
        lastName: person.lastName,
        phones: person.phones,
        address: person.address,
        city: person.city,
        state: person.state,
        zip: person.zip,
        ageRange: person.ageRange,
        relatives: person.relatives,
        confidence: Math.max(5, Math.min(99, confidence)),
        sourceProvider: this.code,
      });
    }

    return results.sort((a, b) => b.confidence - a.confidence).slice(0, 25);
  }
}
