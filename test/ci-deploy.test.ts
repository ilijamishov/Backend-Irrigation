import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');
const scripts = (require('../package.json') as { scripts: Record<string, string> }).scripts;
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('the deploy on a push to main', () => {
  it('deploys the dev stage only', () => {
    const command = scripts['deploy:ci'];

    expect(command).toContain('-c stage=dev');
    expect(command).toContain('--all');
    // A prod stack name would deploy prod, whatever the stage.
    expect(command).not.toMatch(/Irrigation-(Auth|Controllers|GithubDeploy|Firmware)\b/);
  });

  it("signs in to dev's region", () => {
    expect(workflow).toContain('aws-region: us-east-2');
    expect(workflow).not.toContain('aws-region: us-east-1');
    expect(workflow).toContain('run: npm run deploy:ci');
  });
});
