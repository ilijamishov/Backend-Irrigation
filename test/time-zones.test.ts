import * as fs from 'node:fs';
import * as path from 'node:path';

import { MapTimeZoneLookup, posixRuleOf } from '../lambda/controllers/time-zones';

/** What the firmware accepts (MQTT contract §4). */
const VALID_FOR_THE_CONTROLLER = /^[A-Za-z<][A-Za-z0-9+\-,.:/<>]{0,62}$/;

describe('MapTimeZoneLookup', () => {
  const lookup = new MapTimeZoneLookup();

  it.each([
    ['Skopje', 41.9981, 21.4254, 'CET-1CEST,M3.5.0,M10.5.0/3'],
    ['New York', 40.7128, -74.006, 'EST5EDT,M3.2.0,M11.1.0'],
    ['Tokyo', 35.6762, 139.6503, 'JST-9'],
    ['Sydney', -33.8688, 151.2093, 'AEST-10AEDT,M10.1.0,M4.1.0/3'],
    ['Delhi', 28.6139, 77.209, 'IST-5:30'],
    ['Reykjavik', 64.1466, -21.9426, 'GMT0'],
  ])('finds the rule of %s', async (_city, latitude, longitude, posix) => {
    const zone = await lookup.at(latitude, longitude);

    expect(zone.posix).toBe(posix);
  });

  it('names the zone of the place itself, not of another with the same clock', async () => {
    await expect(lookup.at(42.05, 21.45)).resolves.toEqual({
      name: 'Europe/Skopje',
      posix: 'CET-1CEST,M3.5.0,M10.5.0/3',
    });
  });

  it('gives a zone in the middle of the ocean as well', async () => {
    await expect(lookup.at(0, -30)).resolves.toEqual({ name: 'Etc/GMT+2', posix: '<-02>2' });
  });

  it('gives a rule everywhere on a rough grid of the world', async () => {
    for (let latitude = -90; latitude <= 90; latitude += 15) {
      for (let longitude = -180; longitude <= 180; longitude += 15) {
        const zone = await lookup.at(latitude, longitude);
        expect(zone.posix).toMatch(VALID_FOR_THE_CONTROLLER);
      }
    }
  }, 60_000);

  it('loads the map only once, on first use', async () => {
    const find = jest.fn(() => ['Europe/Skopje']);
    const load = jest.fn(async () => find);
    const lazy = new MapTimeZoneLookup(load);

    expect(load).not.toHaveBeenCalled();
    await lazy.at(1, 2);
    await lazy.at(3, 4);

    expect(load).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('fails rather than guess for a zone it has no rule for', async () => {
    const lazy = new MapTimeZoneLookup(async () => () => ['Nowhere/Land']);

    await expect(lazy.at(1, 2)).rejects.toThrow();
  });
});

describe('posixRuleOf', () => {
  it('knows every zone the map can answer with', () => {
    const index = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          '..',
          'node_modules',
          'geo-tz',
          'data',
          'timezones.geojson.index.json',
        ),
        'utf8',
      ),
    ) as { timezones: string[] };

    expect(index.timezones.length).toBeGreaterThan(0);
    for (const name of index.timezones) {
      expect(posixRuleOf(name)).toMatch(VALID_FOR_THE_CONTROLLER);
    }
  });
});
