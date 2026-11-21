import { localReviewSettings } from '../../application/local-review-service.js';
import { startLocalReviewServer } from '../../application/local-review-server.js';

export async function serveLocalReviews(): Promise<void> {
  const { close } = await startLocalReviewServer(localReviewSettings());
  process.once('SIGTERM', () => { void close(); });
  process.once('SIGINT', () => { void close(); });
}
