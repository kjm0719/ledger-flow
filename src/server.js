import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger, AppError } from './ledger.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function createApp(dbPath) {
  const ledger = createLedger(dbPath);
  const assets = { '/': ['public/index.html', 'text/html'], '/app.js': ['public/app.js', 'text/javascript'],
    '/style.css': ['public/style.css', 'text/css'], '/portfolio': ['docs/portfolio.html', 'text/html'] };
  const server = http.createServer(async (req, res) => {
    const reply = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || ''))
        throw new AppError(403, 'HOST_REJECTED', '127.0.0.1 주소를 이용하세요.');
      const url = new URL(req.url, 'http://' + req.headers.host);
      if (req.method === 'GET' && assets[url.pathname]) {
        const [path, type] = assets[url.pathname]; return reply(200, readFileSync(join(root, path)), type);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return reply(200, { status: 'ok', mode: 'local-demo' });
      if (req.method === 'GET' && url.pathname === '/api/wallets') return reply(200, { items: ledger.wallets() });
      if (req.method === 'GET' && url.pathname === '/api/audit') return reply(200, ledger.audit());
      if (req.method === 'GET' && url.pathname === '/api/transfers') {
        const p = url.searchParams;
        return reply(200, ledger.list({ walletId: p.get('walletId') || '',
          limit: Number(p.get('limit') ?? 10), offset: Number(p.get('offset') ?? 0) }));
      }
      if (req.method === 'POST' && url.pathname === '/api/transfers') {
        if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)
          throw new AppError(403, 'ORIGIN_REJECTED', '다른 출처의 요청은 허용하지 않습니다.');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
          throw new AppError(415, 'JSON_REQUIRED', 'application/json 형식으로 요청하세요.');
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          chunks.push(chunk); bytes += chunk.length;
          if (bytes > 8192) throw new AppError(413, 'BODY_TOO_LARGE', '요청이 너무 큽니다.');
        }
        const body = Buffer.concat(chunks).toString('utf8');
        let input;
        try { input = JSON.parse(body); } catch { throw new AppError(400, 'INVALID_JSON', '올바른 JSON을 입력하세요.'); }
        const result = ledger.transfer(input, req.headers['idempotency-key']);
        return reply(result.replayed ? 200 : 201, result);
      }
      return reply(404, { error: { code: 'NOT_FOUND', message: '경로를 찾을 수 없습니다.' } });
    } catch (e) {
      if (!(e instanceof AppError)) console.error(e);
      if (!res.headersSent) reply(e.status || 500, { error: {
        code: e.code && e instanceof AppError ? e.code : 'INTERNAL_ERROR',
        message: e instanceof AppError ? e.message : '서버 오류가 발생했습니다.' } });
    }
  });
  server.on('close', () => ledger.close());
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.DB_PATH || join(root, 'data', 'ledger.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const port = Number(process.env.PORT || 3000);
  const server = createApp(dbPath);
  server.listen(port, '127.0.0.1', () => console.log('Ledger Flow → http://127.0.0.1:' + server.address().port));
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
}
