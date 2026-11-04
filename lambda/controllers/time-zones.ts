import { zones as POSIX_RULES } from './posix-time-zones.json';

/** The time zone of one place. */
export interface TimeZone {
  /** The IANA name, for example `Europe/Skopje`. */
  readonly name: string;
  /** The rule the controller runs on, for example `CET-1CEST,M3.5.0,M10.5.0/3`. */
  readonly posix: string;
}

export interface TimeZoneLookup {
  at(latitude: number, longitude: number): Promise<TimeZone>;
}

type FindTimeZones = (latitude: number, longitude: number) => string[];

/** One piece of the map at a time, so a long-lived Lambda doesn't fill its memory. */
class LastPieceOnly {
  private key: string | undefined;
  private value: unknown;

  get(key: string): unknown {
    return key === this.key ? this.value : undefined;
  }

  set(key: string, value: unknown): void {
    this.key = key;
    this.value = value;
  }
}

/** Loaded on first use: the other API calls shouldn't wait for the map's index. */
async function loadFinder(): Promise<FindTimeZones> {
  const { find, setCache } = await import('geo-tz/dist/find-all');
  setCache({ store: new LastPieceOnly() });
  return find;
}

/**
 * Finds the time zone in the time zone map that is bundled with the Lambda. It
 * is geo-tz's largest map, because the smaller ones merge zones whose clocks
 * agree: Skopje would be named Europe/Paris, and share its future rule changes.
 */
export class MapTimeZoneLookup implements TimeZoneLookup {
  private finder: Promise<FindTimeZones> | undefined;

  constructor(private readonly load: () => Promise<FindTimeZones> = loadFinder) {}

  async at(latitude: number, longitude: number): Promise<TimeZone> {
    this.finder ??= this.load();
    const [name] = (await this.finder)(latitude, longitude);

    return { name, posix: posixRuleOf(name) };
  }
}

/** Throws for a name that isn't in the table, which a test rules out. */
export function posixRuleOf(name: string): string {
  const rule = (POSIX_RULES as Record<string, string>)[name];
  if (rule === undefined) throw new Error('A time zone without a POSIX rule.');

  return rule;
}
