'use strict';

const { createServer } = require('node:http');

// No application configuration, credential access, request logging or outgoing
// requests. The installer checks TCP readiness; 503 never claims app health.
function holdingServer() {
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, (request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
    response.end('Deployment pending\n');
    request.resume();
  });
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 1;
  return server;
}
module.exports = holdingServer;

if (require.main === module) {
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) process.exitCode = 1;
  else {
    const server = holdingServer();
    server.on('error', () => { process.exitCode = 1; server.close(); });
    server.listen(port, '0.0.0.0');
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      server.close(); server.closeAllConnections();
    });
  }
}
