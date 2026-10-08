// 慢记 Manji v3.6 —— 服务入口：路由分发、幂等、静态资源、公共链锚定后台
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { config } from './config.js';
import {
  ApiError, errors, userForRequest, readBody, parseJsonBuffer, sendJson, sendError,
  sha256, idempotencyLookup, idempotencyStore,
} from './core.js';
import { routes as accountRoutes, ensureAdmin } from './routes/accounts.js';
import { routes as memoryRoutes } from './routes/memories.js';
import { routes as mediaRoutes, cleanupStaleUploads } from './routes/media.js';
import { routes as lifeRoutes } from './routes/life.js';
import { routes as chainRoutes } from './routes/chain.js';
import { routes as onchainRoutes } from './routes/onchain.js';
import { startOnchainSubmitter, onchainMode } from './domain/public-chain.js';

const routes = {};
for (const group of [accountRoutes, memoryRoutes, mediaRoutes, lifeRoutes, chainRoutes, onchainRoutes]) {
  for (const [k, v] of Object.entries(group)) {
    const [method, pattern] = k.split(' ');
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:([A-Za-z]+)/g, (_, name) => {
        keys.push(name);
        return '([^/]+)';
      }) + '$'
    );
    routes[k] = { handler: v, method, regex, keys };
  }
}

const PUBLIC_ROUTES = new Set([
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/invites/info',
  'GET /api/invites/preview',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(config.root, 'public', path.normalize(p).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(path.join(config.root, 'public'))) {
    res.statusCode = 403;
    return res.end();
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA 回退
    const index = path.join(config.root, 'public', 'index.html');
    if (existsSync(index)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(index));
      return;
    }
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(readFileSync(file));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // A malformed request path must answer 400, never crash the whole server.
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { res.statusCode = 400; return res.end('Bad request'); }
    if (!pathname.startsWith('/api/')) {
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, pathname);
      res.statusCode = 405;
      return res.end();
    }

    const routeKey = `${req.method} ${pathname}`;
    let route = routes[routeKey];
    let matched = null;
    if (route) {
      matched = { params: {} };
    } else {
      for (const r of Object.values(routes)) {
        if (r.method !== req.method) continue;
        const m = r.regex.exec(pathname);
        if (m) {
          route = r;
          const params = {};
          for (let i = 0; i < r.keys.length; i++) params[r.keys[i]] = m[i + 1];
          matched = { params };
          break;
        }
      }
    }
    if (!route || !matched) throw errors.notFound('接口不存在');

    const user = userForRequest(req);
    if (!user && !PUBLIC_ROUTES.has(routeKey)) throw errors.unauthorized();

    // CSRF 防线：变更类请求要求自定义头（浏览器无法跨站伪造自定义头）
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-manji-client'] !== '1') {
        throw errors.forbidden('缺少客户端标识头');
      }
    }

    const params = matched.params;

    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? null
        : await readBody(req, Math.max(config.maxUploadBytes * 2, 32 * 1024 * 1024));

    const ctx = {
      req,
      res,
      user,
      params,
      query: url.searchParams,
      body,
      routeKey,
      json() {
        return parseJsonBuffer(this.body);
      },
    };

    // 幂等：同键同负载重放原结果；同键异负载 409（计划书 8.1）
    const idemKey = req.headers['idempotency-key'];
    if (idemKey && req.method !== 'GET') {
      const payloadHash = sha256(body ? body.toString('base64') : '');
      const owner = user ? user.id : 'anon';
      const prior = idempotencyLookup(owner, routeKey, String(idemKey), payloadHash);
      if (prior) {
        res.statusCode = prior.status_code;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Idempotent-Replay', 'true');
        return res.end(prior.response_body);
      }
      const result = await route.handler(ctx);
      if (result && result.rawFile) {
        // 二进制响应不参与幂等记录
        return sendRaw(res, result.rawFile);
      }
      const bodyJson = sendJson(res, result.status, result.data ? result.data : result);
      idempotencyStore(owner, routeKey, String(idemKey), payloadHash, res.statusCode, bodyJson);
      return;
    }

    const result = await route.handler(ctx);
    if (result && result.rawFile) return sendRaw(res, result.rawFile);
    sendJson(res, result.status, result.data ? result.data : result);
  } catch (err) {
    if (!(err instanceof ApiError)) console.error('[manji]', req.method, url.pathname, err);
    sendError(res, err);
  }
});

function sendRaw(res, { buf, mime, filename }) {
  res.statusCode = 200;
  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.end(buf);
}

cleanupStaleUploads();
setInterval(cleanupStaleUploads, 12 * 3600 * 1000).unref();
ensureAdmin();
startOnchainSubmitter(); // v3.6：公共链提交/复核后台（未配置时静默关闭）

server.listen(config.port, () => {
  console.log(`慢记 Manji v${config.version} 已启动`);
  console.log(`  地址:    http://127.0.0.1:${config.port}`);
  console.log(`  数据库:  ${config.dbPath}`);
  console.log(`  媒体库:  ${config.mediaRoot}`);
  console.log(`  时区:    ${config.bizTimezone}`);
  console.log(`  公共链:  ${onchainMode() === 'off' ? '未配置（本地永恒之链不受影响）' : `${onchainMode()} 模式 · 合约 ${config.onchain.contract}`}`);
  console.log(`  管理员:  ${config.adminDisplayName}（密码见 .env 的 ADMIN_PASSWORD，默认 admin-2026）`);
});

export { server };
