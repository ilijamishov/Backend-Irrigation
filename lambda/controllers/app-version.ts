/** The header in which the app names its own version, such as `1.2.0`. */
export const APP_VERSION_HEADER = 'x-irrigation-app-version';

/** A release version of the app: `MAJOR.MINOR.PATCH`. */
export class AppVersion {
  static readonly NONE = new AppVersion(0, 0, 0);

  private static readonly PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

  private constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
  ) {}

  /** [text] as a version, or `undefined` when it isn't `MAJOR.MINOR.PATCH`. */
  static parse(text: unknown): AppVersion | undefined {
    if (typeof text !== 'string') return undefined;
    const match = AppVersion.PATTERN.exec(text.trim());
    if (!match) return undefined;
    return new AppVersion(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  isBelow(other: AppVersion): boolean {
    if (this.major !== other.major) return this.major < other.major;
    if (this.minor !== other.minor) return this.minor < other.minor;
    return this.patch < other.patch;
  }

  toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}

/**
 * Decides whether an app may still use the API. An app that names no version,
 * or one that can't be read, was built before apps named theirs, so it counts
 * as the oldest: it is refused as soon as any minimum is set.
 */
export class AppVersionGate {
  constructor(readonly minimum: AppVersion) {}

  /** [setting] is the stage's `minimumAppVersion`; it must be a version. */
  static of(setting: string): AppVersionGate {
    const minimum = AppVersion.parse(setting);
    if (!minimum) {
      throw new Error(`The minimum app version "${setting}" isn't MAJOR.MINOR.PATCH.`);
    }
    return new AppVersionGate(minimum);
  }

  /** Whether the app that sent [reported] in its header may go on. */
  allows(reported: string | undefined): boolean {
    const version = AppVersion.parse(reported) ?? AppVersion.NONE;
    return !version.isBelow(this.minimum);
  }
}
