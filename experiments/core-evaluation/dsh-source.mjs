import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const DSH_REVISION = 'c291e7961a515f6d7af9304e7fd1d257929aef26';

// A pinned label in a report is meaningful only when the source really matches.
export function resolveDshSource(input = process.env.DSH_SOURCE_DIR ?? process.env.DSH_REPO) {
  if (!input) return undefined;
  const directory = path.resolve(input);
  const revision = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (revision !== DSH_REVISION) {
    throw new Error(`Expected DSH ${DSH_REVISION}, got ${revision}. See experiments/core-evaluation/README.md.`);
  }
  execFileSync('git', ['-C', directory, 'diff', '--exit-code', 'HEAD', '--', 'vendor/cordis/src', 'vendor/cosmokit/src'], {
    stdio: 'pipe',
  });
  return directory;
}
