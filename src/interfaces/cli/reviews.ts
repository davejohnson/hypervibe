import { currentLocalReviewOrigin, ensureLocalReviewOrigin, localReviewUrl } from '../../application/local-review-service.js';
import type { CliIo } from './io.js';

export async function runReviews(args: string[], io: CliIo): Promise<number> {
  const json = args.includes('--json');
  const words = args.filter(word => word !== '--json');
  if (words.length === 1 && ['--help', '-h', 'help'].includes(words[0])) {
    io.writeOut('Usage: hypervibe reviews [status | serve] [--json]\nOpen the local review library. Use status to check it or serve to run it in the foreground.\n');
    return 0;
  }
  if (words.length > 1 || (words.length && !['status', 'serve'].includes(words[0]))) {
    io.writeErr('Use "hypervibe reviews --help" for available options.\n');
    return 2;
  }
  try {
    if (words[0] === 'serve') {
      const { serveLocalReviews } = await import('./local-review-host.js');
      await serveLocalReviews();
    }
    const base = words.length ? await currentLocalReviewOrigin() : await ensureLocalReviewOrigin();
    const url = base && localReviewUrl(base);
    io.writeOut(json ? JSON.stringify({ running: Boolean(url), url }) + '\n' :
      url ? url + '\n' : 'Local reviews are offline. Run "hypervibe reviews" to open them.\n');
    return 0;
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? 'The local review address is already in use. Run "hypervibe reviews status" to find the library.'
      : error instanceof Error ? error.message : 'Could not open local reviews.';
    io.writeErr(message + '\n');
    return 1;
  }
}
