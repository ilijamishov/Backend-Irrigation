import * as path from 'node:path';

import { BackendVersion, type Git, ProcessGit } from '../lib/backend-version';

class FakeGit implements Git {
  constructor(
    private readonly answers: Record<string, string | Error>,
  ) {}

  run(args: string[]): string {
    const answer = this.answers[args.join(' ')];
    if (answer === undefined) throw new Error(`unexpected git ${args.join(' ')}`);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}

describe('BackendVersion', () => {
  it('is the short commit of a clean working tree', () => {
    const git = new FakeGit({ 'rev-parse --short HEAD': '7bf65f8\n', 'status --porcelain': '' });

    expect(new BackendVersion(git).describe()).toBe('7bf65f8');
  });

  it('says when the working tree had uncommitted changes', () => {
    const git = new FakeGit({
      'rev-parse --short HEAD': '7bf65f8\n',
      'status --porcelain': ' M lib/controllers-stack.ts\n',
    });

    expect(new BackendVersion(git).describe()).toBe('7bf65f8-dirty');
  });

  it('is unknown, not a failed build, when git cannot tell', () => {
    const noGit = new FakeGit({ 'rev-parse --short HEAD': new Error('not a git repository') });
    const garbage = new FakeGit({ 'rev-parse --short HEAD': 'fatal: something\n', 'status --porcelain': '' });

    expect(new BackendVersion(noGit).describe()).toBe('unknown');
    expect(new BackendVersion(garbage).describe()).toBe('unknown');
  });

  it('reads this repository with the real git', () => {
    const version = new BackendVersion(new ProcessGit(path.join(__dirname, '..'))).describe();

    expect(version).toMatch(/^([0-9a-f]{4,40}(-dirty)?|unknown)$/);
  });
});
