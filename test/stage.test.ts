import { Stage } from '../lib/stage';

const stages = {
  prod: {
    region: 'us-east-1',
    iotDataEndpoint: 'abc-ats.iot.us-east-1.amazonaws.com',
    stackPrefix: 'Irrigation',
    githubDeployStack: true,
    firmwareReleaseRoleName: 'irrigation-firmware-release',
    firmwareReleaseTag: 'v*',
    minimumAppVersion: '1.0.0',
  },
  dev: {
    region: 'us-east-2',
    iotDataEndpoint: 'abc-ats.iot.us-east-2.amazonaws.com',
    stackPrefix: 'Irrigation-Dev',
    githubDeployStack: false,
    firmwareReleaseRoleName: 'irrigation-dev-firmware-release',
    firmwareReleaseTag: 'dev-v*',
    minimumAppVersion: '1.2.0',
  },
};

function contextWith(values: Record<string, unknown>): (key: string) => unknown {
  return (key) => values[key];
}

describe('Stage', () => {
  it('is prod when no stage is named', () => {
    const stage = Stage.fromContext(contextWith({ stages }));

    expect(stage.name).toBe('prod');
    expect(stage.region).toBe('us-east-1');
    expect(stage.iotDataEndpoint).toBe('abc-ats.iot.us-east-1.amazonaws.com');
    expect(stage.hasGithubDeployStack).toBe(true);
    expect(stage.firmwareReleaseRoleName).toBe('irrigation-firmware-release');
    expect(stage.firmwareReleaseRef).toBe('refs/tags/v*');
  });

  it('reads the named stage', () => {
    const stage = Stage.fromContext(contextWith({ stage: 'dev', stages }));

    expect(stage.name).toBe('dev');
    expect(stage.region).toBe('us-east-2');
    expect(stage.iotDataEndpoint).toBe('abc-ats.iot.us-east-2.amazonaws.com');
    expect(stage.hasGithubDeployStack).toBe(false);
    expect(stage.firmwareReleaseRoleName).toBe('irrigation-dev-firmware-release');
    expect(stage.firmwareReleaseRef).toBe('refs/tags/dev-v*');
    expect(stage.minimumAppVersion).toBe('1.2.0');
  });

  it("keeps prod's stack names and prefixes dev's", () => {
    expect(Stage.fromContext(contextWith({ stages })).stackName('Auth')).toBe('Irrigation-Auth');
    expect(Stage.fromContext(contextWith({ stage: 'dev', stages })).stackName('Auth')).toBe(
      'Irrigation-Dev-Auth',
    );
  });

  it('lists the region of every stage, whichever is chosen', () => {
    expect(Stage.regionsOf(contextWith({ stage: 'dev', stages }))).toEqual([
      'us-east-1',
      'us-east-2',
    ]);
    expect(() => Stage.regionsOf(contextWith({}))).toThrow('Missing CDK context "stages"');
  });

  it('refuses an unknown stage and names the known ones', () => {
    expect(() => Stage.fromContext(contextWith({ stage: 'test', stages }))).toThrow(
      'Unknown stage "test". Known stages: prod, dev.',
    );
  });

  it('refuses an empty stage name', () => {
    expect(() => Stage.fromContext(contextWith({ stage: ' ', stages }))).toThrow(
      'must name a stage',
    );
  });

  it('needs the stages', () => {
    expect(() => Stage.fromContext(contextWith({}))).toThrow('Missing CDK context "stages"');
  });

  it('needs every setting of the stage', () => {
    const { region: _region, ...withoutRegion } = stages.dev;
    expect(() =>
      Stage.fromContext(contextWith({ stage: 'dev', stages: { ...stages, dev: withoutRegion } })),
    ).toThrow('Stage "dev" needs "region"');

    const { firmwareReleaseTag: _tag, ...withoutTag } = stages.dev;
    expect(() =>
      Stage.fromContext(contextWith({ stage: 'dev', stages: { ...stages, dev: withoutTag } })),
    ).toThrow('Stage "dev" needs "firmwareReleaseTag"');

    expect(() =>
      Stage.fromContext(
        contextWith({
          stage: 'dev',
          stages: { ...stages, dev: { ...stages.dev, githubDeployStack: 'no' } },
        }),
      ),
    ).toThrow('Stage "dev" needs "githubDeployStack" (true or false)');
  });

  it('needs the minimum app version as MAJOR.MINOR.PATCH', () => {
    const withMinimum = (minimumAppVersion: unknown) =>
      contextWith({ stage: 'dev', stages: { ...stages, dev: { ...stages.dev, minimumAppVersion } } });

    expect(() => Stage.fromContext(withMinimum(undefined))).toThrow(
      'Stage "dev" needs "minimumAppVersion"',
    );
    for (const bad of ['1.0', '1.0.0+1', 'v1.0.0']) {
      expect(() => Stage.fromContext(withMinimum(bad))).toThrow(
        'Stage "dev" needs "minimumAppVersion" as MAJOR.MINOR.PATCH',
      );
    }
    expect(Stage.fromContext(withMinimum('0.0.0')).minimumAppVersion).toBe('0.0.0');
  });
});
