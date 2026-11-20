import { AppVersion, AppVersionGate } from '../lambda/controllers/app-version';

describe('AppVersion', () => {
  it.each(['1.0.0', '0.9.12', '10.20.30', ' 1.2.3 '])('reads %p', (text) => {
    expect(AppVersion.parse(text)?.toString()).toBe(text.trim());
  });

  it.each([undefined, '', '1.0', '1.0.0+1', 'v1.0.0', '01.0.0', '1.0.0-beta', 5])(
    'refuses %p',
    (text) => {
      expect(AppVersion.parse(text)).toBeUndefined();
    },
  );

  it('compares by number, not as text', () => {
    const version = (text: string) => AppVersion.parse(text)!;

    expect(version('1.9.0').isBelow(version('1.10.0'))).toBe(true);
    expect(version('1.10.0').isBelow(version('1.9.0'))).toBe(false);
    expect(version('0.9.9').isBelow(version('1.0.0'))).toBe(true);
    expect(version('1.0.0').isBelow(version('1.0.1'))).toBe(true);
    expect(version('1.0.0').isBelow(version('1.0.0'))).toBe(false);
  });
});

describe('AppVersionGate', () => {
  const gate = AppVersionGate.of('1.2.0');

  it('lets the minimum and anything newer through', () => {
    expect(gate.allows('1.2.0')).toBe(true);
    expect(gate.allows('1.2.1')).toBe(true);
    expect(gate.allows('2.0.0')).toBe(true);
  });

  it('refuses an older app', () => {
    expect(gate.allows('1.1.9')).toBe(false);
  });

  it('treats an app that names no readable version as the oldest', () => {
    expect(gate.allows(undefined)).toBe(false);
    expect(gate.allows('latest')).toBe(false);
  });

  it('lets every app through while the minimum is 0.0.0', () => {
    const open = AppVersionGate.of('0.0.0');

    expect(open.allows(undefined)).toBe(true);
    expect(open.allows('garbage')).toBe(true);
  });

  it('refuses a minimum that is not a version', () => {
    expect(() => AppVersionGate.of('1.0')).toThrow("isn't MAJOR.MINOR.PATCH");
  });
});
