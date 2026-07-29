import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/health') {
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.end(JSON.stringify({
    service: 'hypervibe-provider-conformance',
    revision: process.env.HYPERVIBE_CONFORMANCE_REVISION || 'unknown'
  }));
});

server.listen(port, '0.0.0.0');
