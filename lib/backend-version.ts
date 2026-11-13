import { execFileSync } from 'node:child_process';

/** Runs git and returns what it prints; throws if git fails. */
export interface Git {
  run(args: string[]): string;
}

/**
 * The backend's version, as `GET /version` reports it: the short commit the
 * stacks were built from, with `-dirty` when the working tree had changes that
 * aren't committed. `unknown` when git can't tell, so a build never fails on
 * it.
 */
export class BackendVersion {
  constructor(private readonly git: Git) {}

  describe(): string {
    try {
      const commit = this.git.run(['rev-parse', '--short', 'HEAD']).trim();
      if (!/^[0-9a-f]{4,40}$/.test(commit)) return 'unknown';
      const dirty = this.git.run(['status', '--porcelain']).trim().length > 0;
      return dirty ? `${commit}-dirty` : commit;
    } catch {
      return 'unknown';
    }
  }
}

/** git of the repository in [directory]. */
export class ProcessGit implements Git {
  constructor(private readonly directory: string) {}

  run(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  }
}
