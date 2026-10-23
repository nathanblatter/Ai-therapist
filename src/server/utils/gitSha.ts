// Short git sha of the running build: GIT_SHA (stamped by the CI image build)
// first, `git rev-parse` for local checkouts, else 'unknown'. Shared by the
// dataset export codebook and the IRB packet header.
import { execSync } from 'node:child_process';

export function gitSha(): string {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}
