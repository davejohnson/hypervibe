import { serveLocalReviews } from './local-review-host.js';

serveLocalReviews().catch(() => { process.exitCode = 1; });
