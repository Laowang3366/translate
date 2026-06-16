import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackendApp } from './backend.mjs';
import { translateText } from '../dist-electron/shared/translator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(__dirname);
const port = Number(process.env.PORT ?? process.env.QUICK_TRANSLATE_PORT ?? 8787);
const dataDir = process.env.QUICK_TRANSLATE_DATA_DIR ?? path.join(projectRoot, 'server-data');
const maxBodyBytes = Number(process.env.QUICK_TRANSLATE_MAX_BODY_BYTES ?? 1_048_576);
const providerApiKey = process.env.TRANSLATE_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const providerBaseUrl = process.env.TRANSLATE_BASE_URL ?? '';
const providerModel = process.env.TRANSLATE_MODEL ?? '';
const providerRequestTimeoutMinutes = process.env.TRANSLATE_TIMEOUT_MINUTES ?? '';

const app = createBackendApp({
  dataDir,
  jwtSecret: process.env.QUICK_TRANSLATE_JWT_SECRET,
  adminUsername: process.env.QUICK_TRANSLATE_ADMIN_USER,
  adminPassword: process.env.QUICK_TRANSLATE_ADMIN_PASSWORD,
  defaultProvider: {
    providerType: process.env.TRANSLATE_PROVIDER ?? (providerApiKey && providerBaseUrl && providerModel ? 'openai-compatible' : 'mock'),
    baseUrl: providerBaseUrl,
    apiKey: providerApiKey,
    model: providerModel,
    requestTimeoutMinutes: providerRequestTimeoutMinutes
  },
  translateText: ({ text, targetLanguage, translationFormat, contextInstruction, provider, timeoutMs }) =>
    translateText({
      text,
      targetLanguage,
      translationFormat,
      contextInstruction,
      timeoutMs,
      provider: {
        type: provider.providerType === 'mock' ? 'mock' : 'openai-compatible',
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model
      }
    })
});

const server = createServer(async (request, response) => {
  let requestBody;
  try {
    requestBody = await readRequestBody(request);
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: status === 413 ? '请求内容过大' : '请求内容读取失败' }));
    return;
  }

  const rawPathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
  const pathname = rawPathname.startsWith('/quick-translate/backend')
    ? rawPathname.slice('/quick-translate/backend'.length) || '/'
    : rawPathname;

  if (pathname === '/' || pathname === '/download' || pathname === '/download/') {
    await serveStaticFile(response, path.join(__dirname, 'public', 'download.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/admin' || pathname === '/admin/') {
    await serveStaticFile(response, path.join(__dirname, 'public', 'admin.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/')) {
    await serveAppAsset(response, pathname);
    return;
  }

  if (pathname.startsWith('/assets/')) {
    await servePublicAsset(response, pathname);
    return;
  }

  const result = await app.handleRequest({
    method: request.method ?? 'GET',
    url: request.url ?? '/',
    headers: request.headers,
    body: requestBody
  });

  response.writeHead(result.status, result.headers);
  response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`快捷翻译后台已启动：http://0.0.0.0:${port}`);
});

async function readRequestBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) {
      throw new RequestBodyTooLargeError();
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

class RequestBodyTooLargeError extends Error {}

async function serveStaticFile(response, filePath, contentType) {
  try {
    response.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-cache'
    });
    response.end(await readFile(filePath));
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('页面不存在');
  }
}

async function servePublicAsset(response, pathname) {
  const assetRoot = path.join(__dirname, 'public', 'assets');
  const requestedPath = decodeURIComponent(pathname.slice('/assets/'.length));
  const filePath = path.resolve(assetRoot, requestedPath);

  if (!filePath.startsWith(`${path.resolve(assetRoot)}${path.sep}`)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('资源不存在');
    return;
  }

  await serveStaticFile(response, filePath, contentTypeForPath(filePath));
}

async function serveAppAsset(response, pathname) {
  const appRoot = path.join(projectRoot, 'dist');
  const normalizedPath = pathname === '/app' || pathname === '/app/' ? 'index.html' : decodeURIComponent(pathname.slice('/app/'.length));
  const requestedPath = normalizedPath || 'index.html';
  const filePath = path.resolve(appRoot, requestedPath);
  const resolvedAppRoot = path.resolve(appRoot);

  if (!filePath.startsWith(`${resolvedAppRoot}${path.sep}`) && filePath !== resolvedAppRoot) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('资源不存在');
    return;
  }

  if (!path.extname(filePath)) {
    await serveStaticFile(response, path.join(appRoot, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  await serveStaticFile(response, filePath, contentTypeForPath(filePath));
}

function contentTypeForPath(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
