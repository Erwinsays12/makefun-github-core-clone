// app.ts — HTTP server: routing, auth, body handling. Written fresh in
// this session.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  uploadPackAdvertisementV0,
  uploadPackAdvertisementV2,
  receivePackAdvertisementV0,
  handleUploadPackV2,
  handleUploadPackV0,
  handleReceivePack,
} from './gitproto.ts';

const MAX_BODY = 64 * 1024 * 1024;

export function createApp(): (req: IncomingMessage, res: ServerResponse) => void {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let reqCounter = 0;

  function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': data.length,
      ...extraHeaders,
    });
    res.end(data);
  }

  function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>): void {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      ...extraHeaders,
    });
    res.end(body);
  }

  function authorized(req: IncomingMessage): boolean {
    if (!expectedToken) return true;
    const h = req.headers.authorization ?? '';
    return h === `Bearer ${expectedToken}`;
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const b = chunk as Buffer;
      total += b.length;
      if (total > MAX_BODY) throw new Error('request body too large');
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  }

  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const method = (req.method ?? 'GET').toUpperCase();
        const reqId = `req-${++reqCounter}`;
        const origin = `${url.protocol}//${url.host}`;

        // Health check: no auth.
        if (url.pathname === '/healthz') {
          if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
          return sendJson(res, 200, { ok: true });
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(url.pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const tail = gitMatch[3];
          if (!authorized(req)) return sendJson(res, 401, { message: 'Bad credentials' });
          if (owner !== VIEWER_LOGIN) return sendJson(res, 404, { message: 'Not Found' });
          const repo = store.getRepo(repoName);
          if (!repo) return sendJson(res, 404, { message: 'Not Found' });
          if (method === 'GET' && tail === 'info/refs') {
            const service = url.searchParams.get('service');
            if (service === 'git-upload-pack') {
              const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
              const body = v2 ? uploadPackAdvertisementV2(store, repo) : uploadPackAdvertisementV0(store, repo);
              return sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
            }
            if (service === 'git-receive-pack') {
              const body = receivePackAdvertisementV0(store, repo);
              return sendBuffer(res, 200, body, 'application/x-git-receive-pack-advertisement');
            }
            return sendJson(res, 400, { message: 'Unknown service' });
          }
          if (method === 'POST' && tail === 'git-upload-pack') {
            const body = await readBody(req);
            const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const out = v2 ? handleUploadPackV2(store, repo, body) : handleUploadPackV0(store, repo, body);
            return sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
          }
          if (method === 'POST' && tail === 'git-receive-pack') {
            const body = await readBody(req);
            const { response } = handleReceivePack(store, repo, body);
            return sendBuffer(res, 200, response, 'application/x-git-receive-pack-result');
          }
          return sendJson(res, 404, { message: 'Not Found' });
        }

        // GraphQL.
        if (url.pathname === '/api/graphql') {
          if (!authorized(req)) return sendJson(res, 401, { message: 'Bad credentials' }, { 'X-GitHub-Request-Id': reqId });
          if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' }, { 'X-GitHub-Request-Id': reqId });
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            return sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] }, { 'X-GitHub-Request-Id': reqId });
          }
          const out = handleGraphQL(store, parsed);
          return sendJson(res, out.status, out.body, { 'X-GitHub-Request-Id': reqId });
        }

        // MCP.
        if (url.pathname === '/mcp') {
          if (!authorized(req)) return sendJson(res, 401, { message: 'Bad credentials' });
          if (method !== 'POST') return sendJson(res, 405, { message: 'Method Not Allowed' });
          const raw = await readBody(req);
          const out = handleMcp(store, raw);
          if (out.body === null) {
            res.writeHead(out.status, { 'content-length': 0 });
            return res.end();
          }
          return sendJson(res, out.status, out.body);
        }

        // REST v3.
        if (url.pathname === '/api/v3' || url.pathname.startsWith('/api/v3/')) {
          if (!authorized(req)) return sendJson(res, 401, { message: 'Bad credentials' }, { 'X-GitHub-Request-Id': reqId });
          let parsed: unknown = {};
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw.toString('utf8'));
              } catch {
                return sendJson(res, 400, { message: 'Invalid JSON' }, { 'X-GitHub-Request-Id': reqId });
              }
            }
          }
          const out = handleRest({ store, reqId, origin }, method, url, parsed);
          const headers: Record<string, string> = { 'X-GitHub-Request-Id': reqId, ...(out.headers ?? {}) };
          if (out.status === 204) {
            res.writeHead(204, headers);
            return res.end();
          }
          return sendJson(res, out.status, out.body ?? {}, headers);
        }

        return sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        console.error('handler error:', e);
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  };
}

export function serve(): ReturnType<typeof createServer> {
  return createServer(createApp());
}
