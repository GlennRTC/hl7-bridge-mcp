import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT ?? 3000);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? undefined : JSON.parse(raw);
}

async function handleMcp(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  // Stateless: un server + transport por request, sin sesión. Encaja con el free
  // tier de Render, que hiberna el servicio tras inactividad. ponytail: si se
  // necesitan streams SSE persistentes, pasar a sessionIdGenerator con sesión.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readJson(req));
}

const http = createHttpServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.url !== '/mcp' || req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'POST /mcp o GET /healthz' }));
    return;
  }
  handleMcp(req, res).catch((e: unknown) => {
    console.error('[error]', e);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

http.listen(PORT, () => console.error(`[info] hl7-bridge-mcp escuchando HTTP en :${PORT} (POST /mcp)`));
