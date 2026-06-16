import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
};

const eventStreamHeaders = {
  ...jsonHeaders,
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no'
};

const defaultUserState = {
  history: [],
  favoriteIds: [],
  settings: {}
};

const defaultDownloadManifest = {
  latestVersion: '',
  releases: []
};
const defaultNotifications = [];
const defaultUpdateFailureReports = [];
const defaultUpdateReportToken = 'quick-translate-update-report-v1';
const beijingOffsetMs = 8 * 60 * 60 * 1000;
const defaultProviderRequestTimeoutMinutes = 5;
const maxProviderRequestTimeoutMinutes = 30;
const maxTranslationSourceChars = 30_000;
const longTranslationChunkChars = 5_000;
const maxTranslationQualityAttempts = 2;
const longTranslationChunkConcurrency = 2;
const maxPublicTranslationResponseMs = 95_000;
const maxSingleTranslationProviderTimeoutMs = 90_000;
const maxChunkTranslationProviderTimeoutMs = 45_000;
const maxTranslationCacheEntries = 1_000;
const maxTranslationMemoryEntries = 5_000;
const translationMetaSymbol = Symbol('quickTranslateTranslationMeta');
const chunkMetaSymbol = Symbol('quickTranslateChunkMeta');
const defaultMetrics = {
  apiCalls: {
    total: 0,
    byEndpoint: {},
    byMethod: {},
    latestAt: ''
  },
  translations: {
    total: 0,
    byDay: {},
    latestAt: '',
    streamTotal: 0,
    longTextTotal: 0,
    providerRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cachedChunks: 0,
    savedProviderRequests: 0,
    totalChunks: 0,
    completedTotal: 0,
    failedTotal: 0,
    durationMsTotal: 0,
    firstChunkMsTotal: 0,
    averageDurationMs: 0,
    averageFirstChunkMs: 0,
    cacheHitRate: 0,
    byError: {}
  },
  downloads: {
    total: 0,
    byPlatform: {},
    byVersion: {},
    byFileName: {},
    latestAt: ''
  },
  visitors: {
    total: 0,
    uniqueTotal: 0,
    byDay: {},
    uniqueByDay: {},
    byPage: {},
    byDevice: {},
    byBrowser: {},
    byOs: {},
    byReferrer: {},
    latestAt: '',
    recent: [],
    knownVisitorHashes: {}
  }
};
const defaultTranslationCache = {
  entries: {}
};
const defaultTranslationMemory = {
  entries: {}
};
const providerModelListTimeoutMs = 15_000;

export function createBackendApp(options = {}) {
  const jwtSecret = options.jwtSecret ?? process.env.QUICK_TRANSLATE_JWT_SECRET ?? 'quick-translate-dev-secret';
  const adminUsername = options.adminUsername ?? process.env.QUICK_TRANSLATE_ADMIN_USER ?? 'admin';
  const adminPassword = options.adminPassword ?? process.env.QUICK_TRANSLATE_ADMIN_PASSWORD ?? 'admin123456';
  const updateReportToken = options.updateReportToken ?? process.env.QUICK_TRANSLATE_UPDATE_REPORT_TOKEN ?? defaultUpdateReportToken;
  const logger = options.logger ?? console;
  const store = createJsonStore({
    dataDir: options.dataDir ?? path.join(process.cwd(), 'data'),
    defaultProvider: options.defaultProvider,
    defaultAdmin: {
      username: adminUsername,
      email: options.adminEmail ?? process.env.QUICK_TRANSLATE_ADMIN_EMAIL ?? '',
      password: adminPassword
    }
  });
  const translateText = options.translateText;

  async function handleRequest(request) {
    const method = request.method.toUpperCase();
    const url = new URL(request.url, 'http://localhost');
    const pathname = normalizeBackendPath(url.pathname);

    if (method === 'OPTIONS') {
      return createResponse(204);
    }

    void store.recordApiCall({ method, pathname }).catch(() => undefined);

    try {
      if (method === 'POST' && pathname === '/api/auth/register') {
        return await register(await readJsonBody(request));
      }

      if (method === 'POST' && pathname === '/api/auth/login') {
        return await login(await readJsonBody(request));
      }

      if (method === 'POST' && pathname === '/api/admin/login') {
        return await adminLogin(await readJsonBody(request));
      }

      if (method === 'GET' && pathname === '/api/sync/state') {
        const auth = requireAuth(request, jwtSecret, 'user');
        return createJsonResponse(200, { state: await store.getUserState(auth.subject) });
      }

      if (method === 'PUT' && pathname === '/api/sync/state') {
        const auth = requireAuth(request, jwtSecret, 'user');
        const state = normalizeUserState(await readJsonBody(request));
        await store.saveUserState(auth.subject, state);
        return createJsonResponse(200, { state });
      }

      if (method === 'GET' && pathname === '/api/admin/profile') {
        requireAuth(request, jwtSecret, 'admin');
        return createJsonResponse(200, { admin: publicAdmin(await store.getAdminProfile()) });
      }

      if (method === 'PUT' && pathname === '/api/admin/profile') {
        requireAuth(request, jwtSecret, 'admin');
        const admin = await store.updateAdminProfile(await readJsonBody(request));
        return createJsonResponse(200, { admin: publicAdmin(admin) });
      }

      if (method === 'GET' && pathname === '/api/admin/provider') {
        requireAuth(request, jwtSecret, 'admin');
        return createJsonResponse(200, { provider: redactProvider(await store.getProvider()) });
      }

      if (method === 'PUT' && pathname === '/api/admin/provider') {
        requireAuth(request, jwtSecret, 'admin');
        const provider = normalizeProvider(await readJsonBody(request), await store.getProvider());
        await store.saveProvider(provider);
        return createJsonResponse(200, { provider: redactProvider(provider) });
      }

      if (method === 'GET' && pathname === '/api/admin/providers') {
        requireAuth(request, jwtSecret, 'admin');
        const providerState = await store.getProviderState();
        return createJsonResponse(200, redactProviderState(providerState));
      }

      if (method === 'POST' && pathname === '/api/admin/providers') {
        requireAuth(request, jwtSecret, 'admin');
        const provider = await store.createProvider(await readJsonBody(request));
        return createJsonResponse(201, { provider: redactProvider(provider) });
      }

      if (method === 'POST' && pathname === '/api/admin/provider-models') {
        requireAuth(request, jwtSecret, 'admin');
        return createJsonResponse(200, { models: await fetchProviderModels(await readJsonBody(request), store) });
      }

      const providerSecretMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)\/secret$/);
      if (providerSecretMatch && method === 'GET') {
        requireAuth(request, jwtSecret, 'admin');
        const provider = await store.getProviderById(providerSecretMatch[1]);
        return createJsonResponse(200, { apiKey: provider.apiKey });
      }

      const providerMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)$/);
      if (providerMatch && method === 'PUT') {
        requireAuth(request, jwtSecret, 'admin');
        const providerState = await store.updateProvider(providerMatch[1], await readJsonBody(request));
        return createJsonResponse(200, redactProviderState(providerState));
      }
      if (providerMatch && method === 'DELETE') {
        requireAuth(request, jwtSecret, 'admin');
        const providerState = await store.deleteProvider(providerMatch[1]);
        return createJsonResponse(200, redactProviderState(providerState));
      }

      if (method === 'GET' && pathname === '/api/admin/users') {
        requireAuth(request, jwtSecret, 'admin');
        const users = await store.listUsersWithStateSummary();
        return createJsonResponse(200, { total: users.length, users });
      }

      if (method === 'GET' && pathname === '/api/admin/stats') {
        requireAuth(request, jwtSecret, 'admin');
        return createJsonResponse(200, { metrics: await store.getMetrics() });
      }

      if (method === 'GET' && pathname === '/api/admin/notifications') {
        requireAuth(request, jwtSecret, 'admin');
        return createJsonResponse(200, { notifications: await store.listNotifications() });
      }

      if (method === 'POST' && pathname === '/api/admin/notifications') {
        requireAuth(request, jwtSecret, 'admin');
        const notification = await store.createNotification(await readJsonBody(request));
        return createJsonResponse(201, { notification });
      }

      const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && method === 'PUT') {
        requireAuth(request, jwtSecret, 'admin');
        const user = await store.updateUser(userMatch[1], await readJsonBody(request));
        return createJsonResponse(200, { user: publicUser(user) });
      }
      if (userMatch && method === 'DELETE') {
        requireAuth(request, jwtSecret, 'admin');
        await store.deleteUser(userMatch[1]);
        return createJsonResponse(200, { deleted: true });
      }

      const notificationMatch = pathname.match(/^\/api\/admin\/notifications\/([^/]+)$/);
      if (notificationMatch && method === 'PUT') {
        requireAuth(request, jwtSecret, 'admin');
        const notification = await store.updateNotification(notificationMatch[1], await readJsonBody(request));
        return createJsonResponse(200, { notification });
      }
      if (notificationMatch && method === 'DELETE') {
        requireAuth(request, jwtSecret, 'admin');
        await store.deleteNotification(notificationMatch[1]);
        return createJsonResponse(200, { deleted: true });
      }

      if (method === 'POST' && pathname === '/api/translate') {
        const body = await readJsonBody(request);
        const provider = await store.getProvider();
        const text = stringOrEmpty(body.text).trim();
        if (typeof translateText !== 'function') {
          return createJsonResponse(501, { error: '服务器翻译通道未启用' });
        }
        if (text.length > maxTranslationSourceChars) {
          throw new HttpError(400, '原文超过 30000 字符限制，请缩短后再翻译');
        }
        const startedAt = Date.now();
        let result;
        try {
          result = await translateTextWithBackendGuards({
            translateText,
            logger,
            store,
            text,
            targetLanguage: stringOrEmpty(body.targetLanguage) || 'zh-CN',
            translationFormat: stringOrEmpty(body.translationFormat) || 'plain',
            provider,
            timeoutMs: provider.requestTimeoutMinutes * 60_000
          });
        } catch (error) {
          logTranslationError(logger, {
            error,
            provider,
            durationMs: Date.now() - startedAt
          });
          throw createTranslationHttpError(error);
        }
        await store.recordTranslationEvent(readTranslationMeta(result));
        return createJsonResponse(200, result);
      }

      if (method === 'GET' && pathname === '/api/downloads') {
        return createJsonResponse(200, await store.getDownloadManifest());
      }

      if (method === 'GET' && pathname === '/api/notifications') {
        return createJsonResponse(200, {
          notifications: await store.listPublicNotifications({
            platform: url.searchParams.get('platform'),
            version: url.searchParams.get('version')
          })
        });
      }

      if (method === 'POST' && pathname === '/api/downloads/track') {
        const metrics = await store.recordDownloadEvent(await readJsonBody(request));
        return createJsonResponse(200, { metrics: metrics.downloads });
      }

      if (method === 'POST' && pathname === '/api/visits/track') {
        const metrics = await store.recordVisitEvent(normalizeVisitEvent(await readJsonBody(request), request));
        return createJsonResponse(200, { metrics: metrics.visitors });
      }

      if (method === 'POST' && pathname === '/api/update-failure-reports') {
        requireStaticBearerToken(request, updateReportToken, '更新失败日志上报未授权');
        const report = await store.recordUpdateFailureReport(await readJsonBody(request));
        return createJsonResponse(201, { reportId: report.id, receivedAt: report.receivedAt });
      }

      return createJsonResponse(404, { error: '接口不存在' });
    } catch (error) {
      if (error instanceof HttpError) {
        return createJsonResponse(error.status, { error: error.message });
      }

      return createJsonResponse(500, { error: '服务器内部错误' });
    }
  }

  async function register(body) {
    const email = normalizeEmail(body.email);
    const password = stringOrEmpty(body.password);
    const displayName = stringOrEmpty(body.displayName) || email.split('@')[0];

    if (!email || password.length < 6) {
      throw new HttpError(400, '邮箱或密码不符合要求');
    }

    const existingUser = await store.findUserByEmail(email);
    if (existingUser) {
      throw new HttpError(409, '该邮箱已注册');
    }

    const user = {
      id: randomId(),
      email,
      displayName,
      passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString()
    };
    await store.saveUser(user);
    await store.saveUserState(user.id, defaultUserState);

    return createJsonResponse(201, {
      user: publicUser(user),
      token: signToken({ role: 'user', subject: user.id }, jwtSecret)
    });
  }

  async function login(body) {
    const email = normalizeEmail(body.email);
    const password = stringOrEmpty(body.password);
    const user = email ? await store.findUserByEmail(email) : null;

    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, '邮箱或密码错误');
    }

    return createJsonResponse(200, {
      user: publicUser(user),
      token: signToken({ role: 'user', subject: user.id }, jwtSecret)
    });
  }

  async function adminLogin(body) {
    const username = stringOrEmpty(body.username);
    const password = stringOrEmpty(body.password);
    const admin = await store.getAdminProfile();

    if (username !== admin.username || !(await verifyAdminPassword(admin, password, adminPassword))) {
      throw new HttpError(401, '管理员账号或密码错误');
    }

    return createJsonResponse(200, {
      admin: publicAdmin(admin),
      token: signToken({ role: 'admin', subject: admin.username }, jwtSecret)
    });
  }

  async function prepareTranslationStream(request) {
    const method = request.method.toUpperCase();
    const url = new URL(request.url, 'http://localhost');
    const pathname = normalizeBackendPath(url.pathname);

    void store.recordApiCall({ method, pathname }).catch(() => undefined);

    try {
      if (method !== 'POST' || pathname !== '/api/translate/stream') {
        return createJsonResponse(404, { error: '接口不存在' });
      }

      const body = await readJsonBody(request);
      const provider = await store.getProvider();
      const text = stringOrEmpty(body.text).trim();
      if (typeof translateText !== 'function') {
        return createJsonResponse(501, { error: '服务器翻译通道未启用' });
      }
      if (text.length > maxTranslationSourceChars) {
        throw new HttpError(400, '原文超过 30000 字符限制，请缩短后再翻译');
      }

      return {
        status: 200,
        headers: eventStreamHeaders,
        stream: async (emit) => {
          const startedAt = Date.now();
          try {
            const result = await translateTextWithBackendGuards({
              translateText,
              logger,
              store,
              stream: true,
              text,
              targetLanguage: stringOrEmpty(body.targetLanguage) || 'zh-CN',
              translationFormat: stringOrEmpty(body.translationFormat) || 'plain',
              provider,
              timeoutMs: provider.requestTimeoutMinutes * 60_000,
              onStart: (event) => emit({ type: 'start', ...event }),
              onTokenTranslated: (event) => emit({ type: 'delta', ...event }),
              onChunkTranslated: (event) => emit({ type: 'chunk', ...event })
            });
            await store.recordTranslationEvent(readTranslationMeta(result));
            await emit({ type: 'done', result });
          } catch (error) {
            logTranslationError(logger, {
              error,
              provider,
              durationMs: Date.now() - startedAt
            });
            const httpError = createTranslationHttpError(error);
            await store.recordTranslationEvent(createTranslationFailureMeta({
              text,
              stream: true,
              startedAt,
              error: httpError
            }));
            await emit({ type: 'error', status: httpError.status, error: httpError.message });
          }
        }
      };
    } catch (error) {
      if (error instanceof HttpError) {
        return createJsonResponse(error.status, { error: error.message });
      }

      return createJsonResponse(500, { error: '服务器内部错误' });
    }
  }

  return { handleRequest, prepareTranslationStream, store };
}

function normalizeBackendPath(pathname) {
  return pathname.startsWith('/quick-translate/backend')
    ? pathname.slice('/quick-translate/backend'.length) || '/'
    : pathname;
}

export function createJsonStore({ dataDir, defaultProvider, defaultAdmin }) {
  const paths = {
    admin: path.join(dataDir, 'admin.json'),
    users: path.join(dataDir, 'users.json'),
    states: path.join(dataDir, 'states.json'),
    provider: path.join(dataDir, 'provider.json'),
    downloads: path.join(dataDir, 'downloads.json'),
    metrics: path.join(dataDir, 'metrics.json'),
    translationCache: path.join(dataDir, 'translation-cache.json'),
    translationMemory: path.join(dataDir, 'translation-memory.json'),
    notifications: path.join(dataDir, 'notifications.json'),
    updateFailureReports: path.join(dataDir, 'update-failure-reports.json'),
    updateFailureReportLog: path.join(dataDir, 'update-failure-reports.log')
  };

  const files = {
    admin: createJsonFile(paths.admin, undefined),
    users: createJsonFile(paths.users, []),
    states: createJsonFile(paths.states, {}),
    provider: createJsonFile(paths.provider, undefined),
    downloads: createJsonFile(paths.downloads, defaultDownloadManifest),
    metrics: createJsonFile(paths.metrics, defaultMetrics),
    translationCache: createJsonFile(paths.translationCache, defaultTranslationCache),
    translationMemory: createJsonFile(paths.translationMemory, defaultTranslationMemory),
    notifications: createJsonFile(paths.notifications, defaultNotifications),
    updateFailureReports: createJsonFile(paths.updateFailureReports, defaultUpdateFailureReports)
  };

  return {
    async getAdminProfile() {
      return normalizeAdminProfile(await files.admin.read(), defaultAdmin);
    },
    async updateAdminProfile(update) {
      let updatedAdmin = null;
      await files.admin.update(async (value) => {
        const currentAdmin = normalizeAdminProfile(value, defaultAdmin);
        const record = isRecord(update) ? update : {};
        const hasEmailUpdate = Object.prototype.hasOwnProperty.call(record, 'email');
        const email = hasEmailUpdate ? normalizeEmail(record.email) : currentAdmin.email;
        const currentPassword = stringOrEmpty(record.currentPassword);
        const newPassword = stringOrEmpty(record.newPassword);

        if (email && !isValidEmail(email)) {
          throw new HttpError(400, '邮箱不符合要求');
        }
        if (newPassword && newPassword.length < 6) {
          throw new HttpError(400, '密码至少需要 6 位');
        }
        if (newPassword && !(await verifyAdminPassword(currentAdmin, currentPassword, defaultAdmin?.password))) {
          throw new HttpError(401, '当前密码错误');
        }

        updatedAdmin = {
          username: currentAdmin.username,
          email,
          passwordHash: newPassword ? await hashPassword(newPassword) : currentAdmin.passwordHash
        };
        return updatedAdmin;
      });

      return updatedAdmin;
    },
    async findUserByEmail(email) {
      const users = normalizeUsers(await files.users.read());
      return users.find((user) => user.email === email) ?? null;
    },
    async saveUser(user) {
      await files.users.update((value) => {
        const users = normalizeUsers(value);
        if (users.some((existingUser) => existingUser.email === user.email)) {
          throw new HttpError(409, '该邮箱已注册');
        }

        return [...users, user];
      });
    },
    async updateUser(userId, update) {
      let updatedUser = null;
      await files.users.update(async (value) => {
        const users = normalizeUsers(value);
        const index = users.findIndex((user) => user.id === userId);
        if (index < 0) {
          throw new HttpError(404, '用户不存在');
        }

        const currentUser = users[index];
        const nextEmail = normalizeEmail(update.email) || currentUser.email;
        const displayName = stringOrEmpty(update.displayName).trim();
        const password = stringOrEmpty(update.password);

        if (!nextEmail) {
          throw new HttpError(400, '邮箱不符合要求');
        }

        if (nextEmail !== currentUser.email && users.some((user) => user.id !== userId && user.email === nextEmail)) {
          throw new HttpError(409, '该邮箱已被其他用户使用');
        }

        if (password && password.length < 6) {
          throw new HttpError(400, '密码至少需要 6 位');
        }

        updatedUser = {
          ...currentUser,
          email: nextEmail,
          displayName: displayName || currentUser.displayName || nextEmail.split('@')[0],
          ...(password ? { passwordHash: await hashPassword(password) } : {})
        };
        users[index] = updatedUser;
        return users;
      });

      return updatedUser;
    },
    async deleteUser(userId) {
      await files.users.update((value) => {
        const users = normalizeUsers(value);
        const index = users.findIndex((user) => user.id === userId);
        if (index < 0) {
          throw new HttpError(404, '用户不存在');
        }

        users.splice(index, 1);
        return users;
      });
      await files.states.update((value) => {
        const states = normalizeStateRecord(value);
        delete states[userId];
        return states;
      });
    },
    async listUsersWithStateSummary() {
      const users = normalizeUsers(await files.users.read());
      const states = normalizeStateRecord(await files.states.read());
      return users
        .map((user) => {
          const state = normalizeUserState(states[user.id]);
          return {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            createdAt: user.createdAt,
            historyCount: state.history.length,
            favoriteCount: state.favoriteIds.length,
            defaultTargetLanguage: stringOrEmpty(state.settings.defaultTargetLanguage),
            defaultTranslationFormat: stringOrEmpty(state.settings.defaultTranslationFormat),
            theme: stringOrEmpty(state.settings.theme)
          };
        })
        .sort((left, right) => stringOrEmpty(right.createdAt).localeCompare(stringOrEmpty(left.createdAt)));
    },
    async getUserState(userId) {
      const states = normalizeStateRecord(await files.states.read());
      return normalizeUserState(states[userId]);
    },
    async saveUserState(userId, state) {
      await files.states.update((value) => {
        const states = normalizeStateRecord(value);
        states[userId] = normalizeUserState(state);
        return states;
      });
    },
    async getProvider() {
      const providerState = normalizeProviderState(await files.provider.read(), defaultProvider);
      return getActiveProvider(providerState);
    },
    async saveProvider(provider) {
      await files.provider.update((value) => {
        const providerState = normalizeProviderState(value, defaultProvider);
        const currentProvider = getActiveProvider(providerState);
        const nextProvider = normalizeProvider({ ...provider, id: currentProvider.id, name: currentProvider.name }, currentProvider);
        return {
          activeProviderId: currentProvider.id,
          providers: providerState.providers.map((item) => (item.id === currentProvider.id ? nextProvider : item))
        };
      });
    },
    async getProviderState() {
      return normalizeProviderState(await files.provider.read(), defaultProvider);
    },
    async getProviderById(providerId) {
      const providerState = normalizeProviderState(await files.provider.read(), defaultProvider);
      const provider = providerState.providers.find((item) => item.id === providerId);
      if (!provider) {
        throw new HttpError(404, '引擎不存在');
      }

      return provider;
    },
    async createProvider(provider) {
      let createdProvider = null;
      await files.provider.update((value) => {
        const providerState = normalizeProviderState(value, defaultProvider);
        createdProvider = normalizeProvider(
          {
            ...provider,
            id: randomId(),
            name: stringOrEmpty(provider.name).trim() || `翻译引擎 ${providerState.providers.length + 1}`
          },
          defaultProvider
        );
        const providers = [...providerState.providers, createdProvider];
        const requestedActiveProviderId = provider.active === true ? createdProvider.id : providerState.activeProviderId;
        return {
          activeProviderId: resolveActiveProviderId(providers, requestedActiveProviderId),
          providers
        };
      });

      return createdProvider;
    },
    async updateProvider(providerId, update) {
      return files.provider.update((value) => {
        const providerState = normalizeProviderState(value, defaultProvider);
        const provider = providerState.providers.find((item) => item.id === providerId);
        if (!provider) {
          throw new HttpError(404, '引擎不存在');
        }

        const nextProvider = normalizeProvider(
          {
            ...provider,
            ...update,
            id: provider.id,
            name: stringOrEmpty(update.name).trim() || provider.name,
            apiKey: stringOrEmpty(update.apiKey) || provider.apiKey
          },
          provider
        );
        const providers = providerState.providers.map((item) => (item.id === providerId ? nextProvider : item));
        const requestedActiveProviderId = update.active === true ? providerId : providerState.activeProviderId;
        return {
          activeProviderId: resolveActiveProviderId(providers, requestedActiveProviderId),
          providers
        };
      });
    },
    async deleteProvider(providerId) {
      return files.provider.update((value) => {
        const providerState = normalizeProviderState(value, defaultProvider);
        const provider = providerState.providers.find((item) => item.id === providerId);
        if (!provider) {
          throw new HttpError(404, '引擎不存在');
        }
        if (providerState.providers.length <= 1) {
          throw new HttpError(400, '至少需要保留一个翻译引擎');
        }

        const providers = providerState.providers.filter((item) => item.id !== providerId);
        return {
          activeProviderId: resolveActiveProviderId(
            providers,
            providerState.activeProviderId === providerId ? '' : providerState.activeProviderId
          ),
          providers
        };
      });
    },
    async getDownloadManifest() {
      return normalizeDownloadManifest(await files.downloads.read());
    },
    async saveDownloadManifest(manifest) {
      await files.downloads.replace(normalizeDownloadManifest(manifest));
    },
    async recordApiCall(event) {
      return files.metrics.update((value) => incrementApiCallMetrics(value, event));
    },
    async recordTranslationEvent(event) {
      return files.metrics.update((value) => incrementTranslationMetrics(value, event));
    },
    async getTranslationCacheEntry(key) {
      const cache = normalizeTranslationCache(await files.translationCache.read());
      const entry = cache.entries[stringOrEmpty(key)];
      return entry ? cloneJson(entry) : null;
    },
    async saveTranslationCacheEntry(entry) {
      await files.translationCache.update((value) => {
        const cache = normalizeTranslationCache(value);
        const normalizedEntry = normalizeTranslationCacheEntry(entry);
        if (!normalizedEntry.key) {
          return cache;
        }

        cache.entries[normalizedEntry.key] = normalizedEntry;
        return trimTranslationCache(cache);
      });
    },
    async touchTranslationCacheEntry(key) {
      let touchedEntry = null;
      await files.translationCache.update((value) => {
        const cache = normalizeTranslationCache(value);
        const normalizedKey = stringOrEmpty(key);
        const entry = cache.entries[normalizedKey];
        if (!entry) {
          return cache;
        }

        touchedEntry = {
          ...entry,
          hitCount: nonNegativeNumber(entry.hitCount) + 1,
          lastUsedAt: new Date().toISOString()
        };
        cache.entries[normalizedKey] = touchedEntry;
        return cache;
      });
      return touchedEntry ? cloneJson(touchedEntry) : null;
    },
    async getTranslationMemoryEntry(key) {
      const memory = normalizeTranslationMemory(await files.translationMemory.read());
      const entry = memory.entries[stringOrEmpty(key)];
      return entry ? cloneJson(entry) : null;
    },
    async saveTranslationMemoryEntry(entry) {
      await files.translationMemory.update((value) => {
        const memory = normalizeTranslationMemory(value);
        const normalizedEntry = normalizeTranslationMemoryEntry(entry);
        if (!normalizedEntry.key) {
          return memory;
        }

        memory.entries[normalizedEntry.key] = normalizedEntry;
        return trimTranslationMemory(memory);
      });
    },
    async touchTranslationMemoryEntry(key) {
      let touchedEntry = null;
      await files.translationMemory.update((value) => {
        const memory = normalizeTranslationMemory(value);
        const normalizedKey = stringOrEmpty(key);
        const entry = memory.entries[normalizedKey];
        if (!entry) {
          return memory;
        }

        touchedEntry = {
          ...entry,
          hitCount: nonNegativeNumber(entry.hitCount) + 1,
          lastUsedAt: new Date().toISOString()
        };
        memory.entries[normalizedKey] = touchedEntry;
        return memory;
      });
      return touchedEntry ? cloneJson(touchedEntry) : null;
    },
    async recordDownloadEvent(event) {
      return files.metrics.update((value) => incrementDownloadMetrics(value, event));
    },
    async recordVisitEvent(event) {
      return files.metrics.update((value) => incrementVisitMetrics(value, event));
    },
    async recordUpdateFailureReport(input) {
      const report = normalizeUpdateFailureReport(input, {
        id: randomId(),
        receivedAt: new Date().toISOString()
      });
      await files.updateFailureReports.update((value) => [...normalizeUpdateFailureReports(value), report].slice(-500));
      await mkdir(path.dirname(paths.updateFailureReportLog), { recursive: true });
      await appendFile(paths.updateFailureReportLog, `${JSON.stringify(report)}\n`, 'utf8');
      return report;
    },
    async getMetrics() {
      return normalizeMetrics(await files.metrics.read());
    },
    async listNotifications() {
      return normalizeNotifications(await files.notifications.read());
    },
    async listPublicNotifications(filter = {}) {
      return normalizeNotifications(await files.notifications.read())
        .filter((notification) => isPublicNotificationVisible(notification, filter))
        .map(publicNotification);
    },
    async createNotification(input) {
      let createdNotification = null;
      await files.notifications.update((value) => {
        const notifications = normalizeNotifications(value);
        createdNotification = normalizeNotification(input, {
          id: randomId(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        return [createdNotification, ...notifications];
      });

      return createdNotification;
    },
    async updateNotification(notificationId, update) {
      let updatedNotification = null;
      await files.notifications.update((value) => {
        const notifications = normalizeNotifications(value);
        const index = notifications.findIndex((notification) => notification.id === notificationId);
        if (index < 0) {
          throw new HttpError(404, '通知不存在');
        }

        updatedNotification = normalizeNotification(
          {
            ...notifications[index],
            ...(isRecord(update) ? update : {}),
            id: notifications[index].id,
            createdAt: notifications[index].createdAt,
            updatedAt: new Date().toISOString()
          },
          notifications[index]
        );
        notifications[index] = updatedNotification;
        return notifications;
      });

      return updatedNotification;
    },
    async deleteNotification(notificationId) {
      await files.notifications.update((value) => {
        const notifications = normalizeNotifications(value);
        const index = notifications.findIndex((notification) => notification.id === notificationId);
        if (index < 0) {
          throw new HttpError(404, '通知不存在');
        }

        notifications.splice(index, 1);
        return notifications;
      });
    },
    async waitForMetrics() {
      await files.metrics.read();
    }
  };
}

function createJsonFile(filePath, fallback) {
  let hasLoaded = false;
  let cachedValue;
  let loadPromise;
  let queue = Promise.resolve();

  async function load() {
    if (hasLoaded) {
      return cachedValue;
    }

    if (!loadPromise) {
      loadPromise = (async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        if (!existsSync(filePath)) {
          cachedValue = cloneJson(fallback);
          hasLoaded = true;
          return cachedValue;
        }

        try {
          cachedValue = JSON.parse(await readFile(filePath, 'utf8'));
        } catch {
          cachedValue = cloneJson(fallback);
        }

        hasLoaded = true;
        return cachedValue;
      })();
    }

    return loadPromise;
  }

  function enqueue(task) {
    const run = queue.catch(() => undefined).then(task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  return {
    async read() {
      await queue;
      return cloneJson(await load());
    },
    update(mutator) {
      return enqueue(async () => {
        const currentValue = await load();
        const nextValue = await mutator(cloneJson(currentValue));
        cachedValue = cloneJson(nextValue);
        await writeJsonAtomic(filePath, cachedValue);
        return cloneJson(cachedValue);
      });
    },
    replace(value) {
      return this.update(() => value);
    }
  };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(request) {
  if (!request.body) {
    return {};
  }

  try {
    const parsed = JSON.parse(request.body);
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new HttpError(400, '请求内容不是有效 JSON');
  }
}

function createResponse(status, body = '', headers = jsonHeaders) {
  return { status, headers, body };
}

function createJsonResponse(status, body) {
  return createResponse(status, body, jsonHeaders);
}

function createTranslationHttpError(error) {
  if (error instanceof HttpError) {
    return error;
  }

  return new HttpError(inferTranslationErrorStatus(error), safeTranslationErrorMessage(error));
}

async function translateTextWithBackendGuards(input) {
  const deadlineAt = Date.now() + maxPublicTranslationResponseMs;
  const repeatedPlan = createRepeatedSemanticTranslationPlan(input.text, input.translationFormat);
  if (repeatedPlan) {
    const stats = createTranslationRuntimeStats({
      text: input.text,
      stream: input.stream,
      totalChunks: repeatedPlan.uniqueUnits.length
    });
    await input.onStart?.({
      totalChunks: repeatedPlan.uniqueUnits.length,
      sourceLength: input.text.length,
      mode: 'repeated'
    });
    const result = await translateRepeatedSemanticUnits({
      ...input,
      deadlineAt,
      stats,
      repeatedPlan
    });
    return attachTranslationMeta(result, stats);
  }

  const chunks = shouldChunkTranslation(input.text, input.translationFormat)
    ? splitTextIntoSemanticChunks(input.text, longTranslationChunkChars)
    : [input.text];
  const stats = createTranslationRuntimeStats({
    text: input.text,
    stream: input.stream,
    totalChunks: chunks.length
  });
  await input.onStart?.({
    totalChunks: chunks.length,
    sourceLength: input.text.length,
    mode: chunks.length > 1 ? 'chunked' : 'single'
  });

  if (chunks.length === 1) {
    const result = await translateChunkWithQualityRetry({
      ...input,
      stats,
      deadlineAt,
      text: chunks[0],
      chunkIndex: 1,
      chunkCount: 1,
      contextInstruction: ''
    });
    await emitTranslatedChunk(input, stats, {
      chunkIndex: 1,
      chunkCount: 1,
      result
    });
    return attachTranslationMeta(result, stats);
  }

  const translatedChunks = new Array(chunks.length);
  const results = new Array(chunks.length);
  let nextChunkIndex = 0;
  const workerCount = Math.min(longTranslationChunkConcurrency, chunks.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextChunkIndex < chunks.length) {
        const index = nextChunkIndex;
        nextChunkIndex += 1;
        const result = await translateChunkWithQualityRetry({
          ...input,
          stats,
          deadlineAt,
          text: chunks[index],
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          contextInstruction: buildChunkContextInstruction(index + 1, chunks.length)
        });
        results[index] = result;
        translatedChunks[index] = result.translatedText;
        await emitTranslatedChunk(input, stats, {
          chunkIndex: index + 1,
          chunkCount: chunks.length,
          result
        });
      }
    })
  );

  const lastResult = results.find(Boolean);
  return attachTranslationMeta({
    provider: lastResult?.provider ?? 'openai-compatible',
    sourceText: input.text,
    targetLanguage: input.targetLanguage,
    translatedText: translatedChunks.join('\n\n')
  }, stats);
}

async function translateRepeatedSemanticUnits(input) {
  const translatedUnits = new Array(input.repeatedPlan.uniqueUnits.length);
  const results = new Array(input.repeatedPlan.uniqueUnits.length);
  let nextUnitIndex = 0;
  const workerCount = Math.min(longTranslationChunkConcurrency, input.repeatedPlan.uniqueUnits.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextUnitIndex < input.repeatedPlan.uniqueUnits.length) {
        const index = nextUnitIndex;
        nextUnitIndex += 1;
        const result = await translateChunkWithQualityRetry({
          ...input,
          text: input.repeatedPlan.uniqueUnits[index],
          chunkIndex: index + 1,
          chunkCount: input.repeatedPlan.uniqueUnits.length,
          contextInstruction: buildRepeatedUnitContextInstruction(index + 1, input.repeatedPlan.uniqueUnits.length)
        });
        results[index] = result;
        translatedUnits[index] = result.translatedText;
      }
    })
  );

  const lastResult = results.find(Boolean);
  const expandedResult = {
    provider: lastResult?.provider ?? 'openai-compatible',
    sourceText: input.text,
    targetLanguage: input.targetLanguage,
    translatedText: input.repeatedPlan.sequence
      .map((unit) => `${translatedUnits[unit.uniqueIndex]}${unit.separator}`)
      .join('')
      .trim()
  };
  await emitTranslatedChunk(input, input.stats, {
    chunkIndex: 1,
    chunkCount: 1,
    result: expandedResult
  });
  return expandedResult;
}

async function translateChunkWithQualityRetry(input) {
  const cacheKey = createTranslationCacheKey(input);
  const memoryKey = createTranslationMemoryKey(input);
  if (input.store) {
    const cachedEntry = cacheKey ? await input.store.getTranslationCacheEntry(cacheKey) : null;
    if (cachedEntry?.translatedText) {
      await input.store.touchTranslationCacheEntry(cacheKey);
      if (memoryKey) {
        await input.store.saveTranslationMemoryEntry({
          key: memoryKey,
          sourceHash: hashString(normalizeTranslationMemorySource(input.text)),
          sourceText: normalizeTranslationMemorySource(input.text),
          provider: cachedEntry.provider || 'openai-compatible',
          targetLanguage: input.targetLanguage,
          translationFormat: stringOrEmpty(input.translationFormat) || 'plain',
          translatedText: cachedEntry.translatedText,
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          hitCount: 0,
          durationMs: nonNegativeNumber(cachedEntry.durationMs)
        });
      }
      input.stats.cacheHits += 1;
      input.stats.cachedChunks += 1;
      const result = {
        provider: cachedEntry.provider || 'openai-compatible',
        sourceText: input.text,
        translatedText: cachedEntry.translatedText,
        targetLanguage: input.targetLanguage
      };
      result[chunkMetaSymbol] = { fromCache: true };
      return result;
    }

    const memoryEntry = memoryKey ? await input.store.getTranslationMemoryEntry(memoryKey) : null;
    if (memoryEntry?.translatedText) {
      await input.store.touchTranslationMemoryEntry(memoryKey);
      input.stats.cacheHits += 1;
      input.stats.cachedChunks += 1;
      const result = {
        provider: memoryEntry.provider || 'openai-compatible',
        sourceText: input.text,
        translatedText: memoryEntry.translatedText,
        targetLanguage: input.targetLanguage
      };
      result[chunkMetaSymbol] = { fromCache: true };
      return result;
    }

    if (cacheKey || memoryKey) {
      input.stats.cacheMisses += 1;
    }
  }

  let lastResult = null;
  for (let attempt = 1; attempt <= maxTranslationQualityAttempts; attempt += 1) {
    const startedAt = Date.now();
    const timeoutMs = effectiveTranslationTimeoutMs(input.timeoutMs, input.chunkCount, input.deadlineAt);
    if (timeoutMs < 1_000) {
      throw new HttpError(408, '翻译接口请求超时，请稍后重试');
    }
    input.stats.providerRequests += 1;
    let streamedTranslatedText = '';
    const result = await input.translateText({
      text: input.text,
      targetLanguage: input.targetLanguage,
      translationFormat: input.translationFormat,
      contextInstruction: input.contextInstruction,
      provider: input.provider,
      timeoutMs,
      maxRetries: 0,
      onToken: typeof input.onTokenTranslated === 'function'
        ? (tokenText) => {
            const normalizedTokenText = stringOrEmpty(tokenText);
            if (!normalizedTokenText) {
              return;
            }

            streamedTranslatedText += normalizedTokenText;
            input.onTokenTranslated({
              chunkIndex: input.chunkIndex,
              chunkCount: input.chunkCount,
              text: normalizedTokenText,
              translatedText: streamedTranslatedText
            });
          }
        : undefined
    });
    lastResult = result;
    const qualityIssue = translationQualityIssue({
      sourceText: input.text,
      translatedText: result.translatedText,
      translationFormat: input.translationFormat
    });

    if (!qualityIssue) {
      result[chunkMetaSymbol] = { fromCache: false };
      if (input.store && cacheKey) {
        await input.store.saveTranslationCacheEntry({
          key: cacheKey,
          sourceHash: hashString(input.text),
          providerHash: hashString(providerCacheIdentity(input.provider)),
          provider: result.provider,
          targetLanguage: input.targetLanguage,
          translationFormat: stringOrEmpty(input.translationFormat) || 'plain',
          translatedText: result.translatedText,
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          hitCount: 0,
          durationMs: Date.now() - startedAt
        });
      }
      if (input.store && memoryKey) {
        await input.store.saveTranslationMemoryEntry({
          key: memoryKey,
          sourceHash: hashString(normalizeTranslationMemorySource(input.text)),
          sourceText: normalizeTranslationMemorySource(input.text),
          provider: result.provider,
          targetLanguage: input.targetLanguage,
          translationFormat: stringOrEmpty(input.translationFormat) || 'plain',
          translatedText: result.translatedText,
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          hitCount: 0,
          durationMs: Date.now() - startedAt
        });
      }
      return result;
    }

    logTranslationQualityWarning(input.logger, {
      provider: input.provider,
      reason: qualityIssue,
      attempt,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunkCount,
      sourceLength: input.text.length,
      translatedLength: stringOrEmpty(result.translatedText).trim().length,
      durationMs: Date.now() - startedAt
    });
  }

  throw new HttpError(422, '翻译结果异常，请稍后重试或缩短文本');
}

function shouldChunkTranslation(text, translationFormat) {
  return (stringOrEmpty(translationFormat) || 'plain') === 'plain' && text.length > longTranslationChunkChars;
}

function buildChunkContextInstruction(chunkIndex, chunkCount) {
  return `长文本分段翻译：这是第 ${chunkIndex} 段，共 ${chunkCount} 段。保持术语、人名、上下文、语气、编号和格式一致；只输出当前段译文，不要总结，不要省略，不要解释。即使内容重复，也必须逐句逐段完整翻译，不要使用“同上”“重复内容”“省略”等概括表达。`;
}

function buildRepeatedUnitContextInstruction(unitIndex, unitCount) {
  return `重复文本优化翻译：这是第 ${unitIndex} 个唯一语义单元，共 ${unitCount} 个。只翻译当前句子，不要解释，不要添加编号。`;
}

function createTranslationRuntimeStats(input) {
  return {
    startedAt: Date.now(),
    sourceLength: stringOrEmpty(input.text).length,
    totalChunks: Math.max(1, nonNegativeNumber(input.totalChunks)),
    stream: input.stream === true,
    longText: stringOrEmpty(input.text).length > longTranslationChunkChars,
    providerRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cachedChunks: 0,
    chunksCompleted: 0,
    firstChunkMs: 0,
    failed: false,
    error: ''
  };
}

async function emitTranslatedChunk(input, stats, event) {
  stats.chunksCompleted += 1;
  if (!stats.firstChunkMs) {
    stats.firstChunkMs = Date.now() - stats.startedAt;
  }

  if (typeof input.onChunkTranslated !== 'function') {
    return;
  }

  await input.onChunkTranslated({
    chunkIndex: event.chunkIndex,
    chunkCount: event.chunkCount,
    progress: Math.round((stats.chunksCompleted / Math.max(1, stats.totalChunks)) * 100),
    translatedText: event.result.translatedText,
    fromCache: readChunkMeta(event.result).fromCache === true
  });
}

function attachTranslationMeta(result, stats) {
  result[translationMetaSymbol] = {
    sourceLength: stats.sourceLength,
    totalChunks: stats.totalChunks,
    stream: stats.stream,
    longText: stats.longText,
    providerRequests: stats.providerRequests,
    cacheHits: stats.cacheHits,
    cacheMisses: stats.cacheMisses,
    cachedChunks: stats.cachedChunks,
    savedProviderRequests: stats.cacheHits,
    firstChunkMs: stats.firstChunkMs || Date.now() - stats.startedAt,
    durationMs: Date.now() - stats.startedAt,
    failed: false
  };
  return result;
}

function readTranslationMeta(result) {
  return isRecord(result?.[translationMetaSymbol]) ? result[translationMetaSymbol] : {};
}

function readChunkMeta(result) {
  return isRecord(result?.[chunkMetaSymbol]) ? result[chunkMetaSymbol] : {};
}

function createTranslationFailureMeta(input) {
  const startedAt = Number.isFinite(input.startedAt) ? input.startedAt : Date.now();
  return {
    sourceLength: stringOrEmpty(input.text).length,
    totalChunks: 0,
    stream: input.stream === true,
    longText: stringOrEmpty(input.text).length > longTranslationChunkChars,
    providerRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cachedChunks: 0,
    savedProviderRequests: 0,
    firstChunkMs: 0,
    durationMs: Date.now() - startedAt,
    failed: true,
    error: safeTranslationErrorMessage(input.error)
  };
}

function createTranslationCacheKey(input) {
  if (!input.store) {
    return '';
  }

  return hashString(
    JSON.stringify({
      text: input.text,
      targetLanguage: input.targetLanguage,
      translationFormat: stringOrEmpty(input.translationFormat) || 'plain',
      provider: providerCacheIdentity(input.provider)
    })
  );
}

function createTranslationMemoryKey(input) {
  if (!input.store) {
    return '';
  }

  const normalizedSource = normalizeTranslationMemorySource(input.text);
  if (!normalizedSource) {
    return '';
  }

  return hashString(
    JSON.stringify({
      text: normalizedSource,
      targetLanguage: input.targetLanguage,
      translationFormat: stringOrEmpty(input.translationFormat) || 'plain'
    })
  );
}

function normalizeTranslationMemorySource(text) {
  return stringOrEmpty(text).trim().replace(/\s+/g, ' ');
}

function providerCacheIdentity(provider) {
  const record = isRecord(provider) ? provider : {};
  return JSON.stringify({
    providerType: stringOrEmpty(record.providerType || record.type),
    baseUrl: stringOrEmpty(record.baseUrl).replace(/\/$/, ''),
    model: stringOrEmpty(record.model)
  });
}

function hashString(value) {
  return createHash('sha256').update(stringOrEmpty(value)).digest('hex');
}

function translationQualityIssue(input) {
  if ((stringOrEmpty(input.translationFormat) || 'plain') !== 'plain') {
    return '';
  }

  const sourceLength = stringOrEmpty(input.sourceText).trim().length;
  const translatedText = stringOrEmpty(input.translatedText).trim();
  if (!translatedText) {
    return 'empty-translated-text';
  }

  if (looksLikeProviderFailureMessage(translatedText)) {
    return 'provider-error-message';
  }

  if (sourceLength >= 1_000) {
    const minimumTranslatedLength = Math.max(80, Math.floor(sourceLength * 0.03));
    if (translatedText.length < minimumTranslatedLength) {
      return 'translated-too-short';
    }
  }

  return '';
}

function looksLikeProviderFailureMessage(value) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('cannot translate') ||
    normalized.includes("can't translate") ||
    normalized.includes('unable to translate') ||
    normalized.includes('无法翻译') ||
    normalized.includes('不能翻译') ||
    normalized.includes('翻译失败')
  );
}

function splitTextIntoSemanticChunks(text, maxChars) {
  const normalizedText = stringOrEmpty(text);
  if (normalizedText.length <= maxChars) {
    return [normalizedText];
  }

  const units = splitIntoSemanticUnits(normalizedText, maxChars);
  const chunks = [];
  let current = '';

  units.forEach((unit) => {
    if (!unit) {
      return;
    }
    if (!current) {
      current = unit;
      return;
    }
    if (current.length + unit.length <= maxChars) {
      current += unit;
      return;
    }

    chunks.push(current.trim());
    current = unit;
  });

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter(Boolean);
}

function createRepeatedSemanticTranslationPlan(text, translationFormat) {
  if ((stringOrEmpty(translationFormat) || 'plain') !== 'plain') {
    return null;
  }

  const sourceText = stringOrEmpty(text).trim();
  if (sourceText.length <= longTranslationChunkChars) {
    return null;
  }

  const units = splitIntoRepeatedSemanticUnits(sourceText);
  if (units.length < 12) {
    return null;
  }

  const uniqueIndexes = new Map();
  const uniqueUnits = [];
  const sequence = [];

  units.forEach((unit) => {
    const key = normalizeRepeatedUnit(unit.text);
    if (!uniqueIndexes.has(key)) {
      uniqueIndexes.set(key, uniqueUnits.length);
      uniqueUnits.push(unit.text);
    }
    sequence.push({
      uniqueIndex: uniqueIndexes.get(key),
      separator: unit.separator
    });
  });

  const uniqueRatio = uniqueUnits.length / units.length;
  const maxUniqueUnits = Math.min(8, Math.max(1, Math.floor(units.length * 0.25)));
  if (uniqueUnits.length > maxUniqueUnits || uniqueRatio > 0.25) {
    return null;
  }

  return { uniqueUnits, sequence };
}

function splitIntoRepeatedSemanticUnits(text) {
  const units = [];
  const sentencePattern = /([^。！？!?；;.\n]+[。！？!?；;.]*)(\s*)/g;
  let cursor = 0;
  let match;

  while ((match = sentencePattern.exec(text)) !== null) {
    const gap = text.slice(cursor, match.index);
    if (gap.trim()) {
      return [];
    }

    const unitText = stringOrEmpty(match[1]).trim();
    if (unitText) {
      units.push({
        text: unitText,
        separator: match[2] || ''
      });
    }
    cursor = match.index + match[0].length;
  }

  if (text.slice(cursor).trim()) {
    return [];
  }

  return units;
}

function normalizeRepeatedUnit(text) {
  return stringOrEmpty(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function splitIntoSemanticUnits(text, maxChars) {
  return text
    .split(/(\n{2,})/)
    .reduce((units, part, index, parts) => {
      if (!part) {
        return units;
      }
      if (/^\n{2,}$/.test(part)) {
        const previous = units.pop() || '';
        units.push(`${previous}${part}`);
        return units;
      }

      if (part.length <= maxChars) {
        units.push(part);
        return units;
      }

      splitLongSemanticUnit(part, maxChars).forEach((unit) => units.push(unit));
      return units;
    }, []);
}

function splitLongSemanticUnit(text, maxChars) {
  const sentenceUnits = text.match(/[^。！？!?；;.\n]+[。！？!?；;.]?\s*/g) || [text];
  return sentenceUnits.flatMap((unit) => (unit.length > maxChars ? hardSplitUnit(unit, maxChars) : [unit]));
}

function hardSplitUnit(text, maxChars) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitIndex = remaining.lastIndexOf(' ', maxChars);
    if (splitIndex < Math.floor(maxChars * 0.6)) {
      splitIndex = maxChars;
    }
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function inferTranslationErrorStatus(error) {
  const status = errorStatus(error);
  if (isAbortError(error) || safeTranslationErrorMessage(error).includes('超时')) {
    return 408;
  }
  if (status === 429) {
    return 429;
  }

  return 422;
}

function effectiveTranslationTimeoutMs(timeoutMs, chunkCount, deadlineAt) {
  const configuredTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : maxSingleTranslationProviderTimeoutMs;
  const cap = chunkCount > 1 ? maxChunkTranslationProviderTimeoutMs : maxSingleTranslationProviderTimeoutMs;
  const remainingBudgetMs = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() - 1_000 : cap;
  return Math.min(configuredTimeoutMs, cap, Math.max(0, remainingBudgetMs));
}

function logTranslationError(logger, input) {
  const log = typeof logger?.error === 'function' ? logger.error.bind(logger) : undefined;
  if (!log) {
    return;
  }

  log('[translate:error]', {
    providerName: stringOrEmpty(input.provider?.name),
    providerType: stringOrEmpty(input.provider?.providerType),
    baseUrl: stringOrEmpty(input.provider?.baseUrl),
    model: stringOrEmpty(input.provider?.model),
    durationMs: input.durationMs,
    upstreamStatus: errorStatus(input.error),
    errorName: errorName(input.error),
    errorMessage: safeTranslationErrorMessage(input.error)
  });
}

function logTranslationQualityWarning(logger, input) {
  const warn = typeof logger?.warn === 'function' ? logger.warn.bind(logger) : undefined;
  if (!warn) {
    return;
  }

  warn('[translate:quality-warning]', {
    providerName: stringOrEmpty(input.provider?.name),
    providerType: stringOrEmpty(input.provider?.providerType),
    baseUrl: stringOrEmpty(input.provider?.baseUrl),
    model: stringOrEmpty(input.provider?.model),
    reason: stringOrEmpty(input.reason),
    attempt: nonNegativeNumber(input.attempt),
    chunkIndex: nonNegativeNumber(input.chunkIndex),
    chunkCount: nonNegativeNumber(input.chunkCount),
    sourceLength: nonNegativeNumber(input.sourceLength),
    translatedLength: nonNegativeNumber(input.translatedLength),
    durationMs: nonNegativeNumber(input.durationMs)
  });
}

function errorStatus(error) {
  return isRecord(error) && Number.isInteger(error.status) ? error.status : undefined;
}

function errorName(error) {
  return error instanceof Error && error.name ? error.name : 'Error';
}

function safeTranslationErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return '翻译接口请求失败，请稍后重试';
}

function requireAuth(request, secret, role) {
  const authorization = request.headers.authorization ?? request.headers.Authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const payload = verifyToken(token, secret);

  if (!payload || payload.role !== role) {
    throw new HttpError(401, role === 'admin' ? '请先登录管理员账号' : '请先登录');
  }

  return payload;
}

function requireStaticBearerToken(request, expectedToken, message) {
  const authorization = request.headers.authorization ?? request.headers.Authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const normalizedExpectedToken = stringOrEmpty(expectedToken);

  if (!normalizedExpectedToken || !token || !safeEqual(token, normalizedExpectedToken)) {
    throw new HttpError(401, message);
  }
}

function signToken(payload, secret) {
  const tokenPayload = {
    ...payload,
    iat: Math.floor(Date.now() / 1000)
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(tokenPayload));
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function verifyToken(token, secret) {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scryptAsync(password, salt, 32)).toString('hex');
  return `${salt}:${key}`;
}

async function verifyPassword(password, storedHash) {
  const [salt, expectedKey] = stringOrEmpty(storedHash).split(':');
  if (!salt || !expectedKey) {
    return false;
  }

  const actualKey = (await scryptAsync(password, salt, 32)).toString('hex');
  return safeEqual(actualKey, expectedKey);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function randomId() {
  return randomBytes(16).toString('hex');
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName
  };
}

function publicAdmin(admin) {
  return {
    username: admin.username,
    email: admin.email
  };
}

function normalizeEmail(value) {
  return stringOrEmpty(value).trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeUsers(value) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function normalizeStateRecord(value) {
  return isRecord(value) ? value : {};
}

function normalizeUserState(value) {
  const record = isRecord(value) ? value : {};
  return {
    history: Array.isArray(record.history) ? record.history.slice(0, 200) : [],
    favoriteIds: Array.isArray(record.favoriteIds) ? record.favoriteIds.filter((id) => typeof id === 'string') : [],
    settings: isRecord(record.settings) ? record.settings : {}
  };
}

function normalizeAdminProfile(value, fallback = {}) {
  const record = isRecord(value) ? value : {};
  return {
    username: stringOrEmpty(record.username) || stringOrEmpty(fallback.username) || 'admin',
    email: stringOrEmpty(record.email).trim().toLowerCase() || stringOrEmpty(fallback.email).trim().toLowerCase(),
    passwordHash: stringOrEmpty(record.passwordHash)
  };
}

async function verifyAdminPassword(admin, password, fallbackPassword) {
  if (admin.passwordHash) {
    return verifyPassword(password, admin.passwordHash);
  }

  return safeEqual(password, stringOrEmpty(fallbackPassword));
}

async function fetchProviderModels(input, store) {
  const body = isRecord(input) ? input : {};
  const providerState = await store.getProviderState();
  const existingProvider =
    providerState.providers.find((provider) => provider.id === stringOrEmpty(body.providerId)) ?? getActiveProvider(providerState);
  const providerType = stringOrEmpty(body.providerType) || existingProvider.providerType;

  if (providerType === 'mock') {
    return ['mock-translator'];
  }

  const baseUrl = stringOrEmpty(body.baseUrl) || existingProvider.baseUrl;
  const apiKey = stringOrEmpty(body.apiKey) || existingProvider.apiKey;
  if (!baseUrl) {
    throw new HttpError(400, '请先填写接口地址');
  }
  if (!apiKey) {
    throw new HttpError(400, '请先输入或更换接口密钥');
  }

  const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), providerModelListTimeoutMs);
  let response;
  try {
    response = await fetch(modelsUrl, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json'
      },
      signal: controller.signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new HttpError(504, '模型列表请求超时，请检查接口地址');
    }

    throw new HttpError(502, '模型列表请求失败，请检查接口地址');
  } finally {
    clearTimeout(timeoutId);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status, errorMessageFromProviderPayload(payload) || `模型列表请求失败，状态码 ${response.status}`);
  }

  const models = Array.isArray(payload.data)
    ? payload.data.map((item) => (isRecord(item) ? stringOrEmpty(item.id) : '')).filter(Boolean)
    : [];
  if (models.length === 0) {
    throw new HttpError(502, '接口未返回可用模型');
  }

  return models;
}

function errorMessageFromProviderPayload(payload) {
  if (!isRecord(payload)) {
    return '';
  }

  if (typeof payload.error === 'string') {
    return payload.error;
  }

  if (isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message;
  }

  return '';
}

function normalizeProvider(value, fallback = {}) {
  const record = isRecord(value) ? value : {};
  return {
    id: stringOrEmpty(record.id) || stringOrEmpty(fallback.id) || randomId(),
    name: stringOrEmpty(record.name) || stringOrEmpty(fallback.name) || '默认翻译引擎',
    providerType: normalizeProviderType(record.providerType) || normalizeProviderType(fallback.providerType) || 'openai-compatible',
    baseUrl: stringOrEmpty(record.baseUrl) || stringOrEmpty(fallback.baseUrl),
    apiKey: stringOrEmpty(record.apiKey) || stringOrEmpty(fallback.apiKey),
    model: stringOrEmpty(record.model) || stringOrEmpty(fallback.model),
    requestTimeoutMinutes: normalizeRequestTimeoutMinutes(record.requestTimeoutMinutes, fallback.requestTimeoutMinutes)
  };
}

function normalizeProviderType(value) {
  const normalized = stringOrEmpty(value).trim();
  if (!normalized) {
    return '';
  }

  return normalized.slice(0, 80);
}

function normalizeRequestTimeoutMinutes(value, fallbackValue) {
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.min(maxProviderRequestTimeoutMinutes, Math.max(1, Math.round(numericValue)));
  }

  const numericFallback = Number(fallbackValue);
  if (Number.isFinite(numericFallback) && numericFallback > 0) {
    return Math.min(maxProviderRequestTimeoutMinutes, Math.max(1, Math.round(numericFallback)));
  }

  return defaultProviderRequestTimeoutMinutes;
}

function isAbortError(error) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function redactProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    providerType: provider.providerType,
    baseUrl: provider.baseUrl,
    apiKey: '',
    maskedApiKey: provider.apiKey ? maskApiKey(provider.apiKey) : '',
    model: provider.model,
    requestTimeoutMinutes: provider.requestTimeoutMinutes,
    hasApiKey: Boolean(provider.apiKey)
  };
}

function maskApiKey(apiKey) {
  const normalized = stringOrEmpty(apiKey);
  if (!normalized) {
    return '';
  }

  return normalized.length > 8 ? `${normalized.slice(0, 3)}••••••••${normalized.slice(-4)}` : '••••••••';
}

function normalizeProviderState(value, defaultProvider = {}) {
  const record = isRecord(value) ? value : {};
  const legacyProvider = record.providerType || record.baseUrl || record.model || record.apiKey;
  const providers = Array.isArray(record.providers)
    ? record.providers.filter(isRecord).map((provider, index) =>
        normalizeProvider(
          {
            ...provider,
            id: stringOrEmpty(provider.id) || `provider-${index + 1}`,
            name: stringOrEmpty(provider.name) || (index === 0 ? '默认翻译引擎' : `翻译引擎 ${index + 1}`)
          },
          defaultProvider
        )
      )
    : legacyProvider
      ? [normalizeProvider({ ...record, id: 'default-provider', name: '默认翻译引擎' }, defaultProvider)]
      : [normalizeProvider({ id: 'default-provider', name: '默认翻译引擎' }, defaultProvider)];
  const activeProviderId = stringOrEmpty(record.activeProviderId);
  const resolvedActiveProviderId = resolveActiveProviderId(providers, activeProviderId);

  return {
    activeProviderId: resolvedActiveProviderId,
    providers
  };
}

function resolveActiveProviderId(providers, requestedActiveProviderId) {
  const requestedProvider = providers.find((provider) => provider.id === requestedActiveProviderId);
  if (requestedProvider && isFullyConfiguredProvider(requestedProvider)) {
    return requestedProvider.id;
  }

  const firstConfiguredProvider = providers.find(isFullyConfiguredProvider);
  if (firstConfiguredProvider) {
    return firstConfiguredProvider.id;
  }

  return requestedProvider?.id || providers[0]?.id || '';
}

function isFullyConfiguredProvider(provider) {
  return (
    provider.providerType !== 'mock' &&
    Boolean(provider.baseUrl) &&
    Boolean(provider.apiKey) &&
    Boolean(provider.model)
  );
}

function getActiveProvider(providerState) {
  return providerState.providers.find((provider) => provider.id === providerState.activeProviderId) ?? providerState.providers[0];
}

function redactProviderState(providerState) {
  return {
    activeProviderId: providerState.activeProviderId,
    providers: providerState.providers.map((provider) => ({
      ...redactProvider(provider),
      active: provider.id === providerState.activeProviderId
    }))
  };
}

function normalizeTranslationCache(value) {
  const record = isRecord(value) ? value : {};
  const rawEntries = isRecord(record.entries) ? record.entries : {};
  const entries = {};
  Object.entries(rawEntries).forEach(([key, entry]) => {
    const normalizedEntry = normalizeTranslationCacheEntry({ ...(isRecord(entry) ? entry : {}), key });
    if (normalizedEntry.key && normalizedEntry.translatedText) {
      entries[normalizedEntry.key] = normalizedEntry;
    }
  });

  return { entries };
}

function normalizeTranslationCacheEntry(value) {
  const record = isRecord(value) ? value : {};
  return {
    key: stringOrEmpty(record.key),
    sourceHash: stringOrEmpty(record.sourceHash),
    providerHash: stringOrEmpty(record.providerHash),
    provider: stringOrEmpty(record.provider) || 'openai-compatible',
    targetLanguage: stringOrEmpty(record.targetLanguage),
    translationFormat: stringOrEmpty(record.translationFormat) || 'plain',
    translatedText: stringOrEmpty(record.translatedText),
    createdAt: stringOrEmpty(record.createdAt) || new Date().toISOString(),
    lastUsedAt: stringOrEmpty(record.lastUsedAt) || stringOrEmpty(record.createdAt) || new Date().toISOString(),
    hitCount: nonNegativeNumber(record.hitCount),
    durationMs: nonNegativeNumber(record.durationMs)
  };
}

function trimTranslationCache(cache) {
  const entries = Object.entries(normalizeTranslationCache(cache).entries)
    .sort((left, right) => stringOrEmpty(right[1].lastUsedAt).localeCompare(stringOrEmpty(left[1].lastUsedAt)))
    .slice(0, maxTranslationCacheEntries);
  return { entries: Object.fromEntries(entries) };
}

function normalizeTranslationMemory(value) {
  const record = isRecord(value) ? value : {};
  const rawEntries = isRecord(record.entries) ? record.entries : {};
  const entries = {};
  Object.entries(rawEntries).forEach(([key, entry]) => {
    const normalizedEntry = normalizeTranslationMemoryEntry({ ...(isRecord(entry) ? entry : {}), key });
    if (normalizedEntry.key && normalizedEntry.translatedText) {
      entries[normalizedEntry.key] = normalizedEntry;
    }
  });

  return { entries };
}

function normalizeTranslationMemoryEntry(value) {
  const record = isRecord(value) ? value : {};
  return {
    key: stringOrEmpty(record.key),
    sourceHash: stringOrEmpty(record.sourceHash),
    sourceText: normalizeTranslationMemorySource(record.sourceText),
    provider: stringOrEmpty(record.provider) || 'openai-compatible',
    targetLanguage: stringOrEmpty(record.targetLanguage),
    translationFormat: stringOrEmpty(record.translationFormat) || 'plain',
    translatedText: stringOrEmpty(record.translatedText),
    createdAt: stringOrEmpty(record.createdAt) || new Date().toISOString(),
    lastUsedAt: stringOrEmpty(record.lastUsedAt) || stringOrEmpty(record.createdAt) || new Date().toISOString(),
    hitCount: nonNegativeNumber(record.hitCount),
    durationMs: nonNegativeNumber(record.durationMs)
  };
}

function trimTranslationMemory(memory) {
  const entries = Object.entries(normalizeTranslationMemory(memory).entries)
    .sort((left, right) => stringOrEmpty(right[1].lastUsedAt).localeCompare(stringOrEmpty(left[1].lastUsedAt)))
    .slice(0, maxTranslationMemoryEntries);
  return { entries: Object.fromEntries(entries) };
}

function normalizeMetrics(value) {
  const record = isRecord(value) ? value : {};
  const apiCalls = isRecord(record.apiCalls) ? record.apiCalls : {};
  const translations = isRecord(record.translations) ? record.translations : {};
  const downloads = isRecord(record.downloads) ? record.downloads : {};
  const visitors = isRecord(record.visitors) ? record.visitors : {};

  return {
    apiCalls: {
      total: nonNegativeNumber(apiCalls.total),
      byEndpoint: normalizeCounterRecord(apiCalls.byEndpoint),
      byMethod: normalizeCounterRecord(apiCalls.byMethod),
      latestAt: stringOrEmpty(apiCalls.latestAt)
    },
    translations: {
      total: nonNegativeNumber(translations.total),
      byDay: normalizeCounterRecord(translations.byDay),
      latestAt: stringOrEmpty(translations.latestAt),
      streamTotal: nonNegativeNumber(translations.streamTotal),
      longTextTotal: nonNegativeNumber(translations.longTextTotal),
      providerRequests: nonNegativeNumber(translations.providerRequests),
      cacheHits: nonNegativeNumber(translations.cacheHits),
      cacheMisses: nonNegativeNumber(translations.cacheMisses),
      cachedChunks: nonNegativeNumber(translations.cachedChunks),
      savedProviderRequests: nonNegativeNumber(translations.savedProviderRequests),
      totalChunks: nonNegativeNumber(translations.totalChunks),
      completedTotal: nonNegativeNumber(translations.completedTotal),
      failedTotal: nonNegativeNumber(translations.failedTotal),
      durationMsTotal: nonNegativeNumber(translations.durationMsTotal),
      firstChunkMsTotal: nonNegativeNumber(translations.firstChunkMsTotal),
      averageDurationMs: nonNegativeNumber(translations.averageDurationMs),
      averageFirstChunkMs: nonNegativeNumber(translations.averageFirstChunkMs),
      cacheHitRate: nonNegativeNumber(translations.cacheHitRate),
      byError: normalizeCounterRecord(translations.byError)
    },
    downloads: {
      total: nonNegativeNumber(downloads.total),
      byPlatform: normalizeCounterRecord(downloads.byPlatform),
      byVersion: normalizeCounterRecord(downloads.byVersion),
      byFileName: normalizeCounterRecord(downloads.byFileName),
      latestAt: stringOrEmpty(downloads.latestAt)
    },
    visitors: {
      total: nonNegativeNumber(visitors.total),
      uniqueTotal: nonNegativeNumber(visitors.uniqueTotal),
      byDay: normalizeCounterRecord(visitors.byDay),
      uniqueByDay: normalizeCounterRecord(visitors.uniqueByDay),
      byPage: normalizeCounterRecord(visitors.byPage),
      byDevice: normalizeCounterRecord(visitors.byDevice),
      byBrowser: normalizeCounterRecord(visitors.byBrowser),
      byOs: normalizeCounterRecord(visitors.byOs),
      byReferrer: normalizeCounterRecord(visitors.byReferrer),
      latestAt: stringOrEmpty(visitors.latestAt),
      recent: normalizeRecentVisits(visitors.recent),
      knownVisitorHashes: normalizeStringRecord(visitors.knownVisitorHashes)
    }
  };
}

function incrementApiCallMetrics(value, event) {
  const metrics = normalizeMetrics(value);
  const method = stringOrEmpty(event?.method).toUpperCase() || 'GET';
  const pathname = stringOrEmpty(event?.pathname) || '/';
  const endpoint = `${method} ${pathname}`;

  metrics.apiCalls.total += 1;
  incrementCounter(metrics.apiCalls.byMethod, method);
  incrementCounter(metrics.apiCalls.byEndpoint, endpoint);
  metrics.apiCalls.latestAt = new Date().toISOString();
  return metrics;
}

function incrementTranslationMetrics(value, event = {}) {
  const metrics = normalizeMetrics(value);
  const now = event.now instanceof Date ? event.now : new Date();
  const day = formatMetricDay(now);
  const failed = event.failed === true;

  metrics.translations.total += 1;
  incrementCounter(metrics.translations.byDay, day);
  metrics.translations.latestAt = now.toISOString();
  if (event.stream === true) {
    metrics.translations.streamTotal += 1;
  }
  if (event.longText === true) {
    metrics.translations.longTextTotal += 1;
  }
  if (failed) {
    metrics.translations.failedTotal += 1;
    incrementCounter(metrics.translations.byError, stringOrEmpty(event.error) || 'unknown');
  } else {
    metrics.translations.completedTotal += 1;
  }
  metrics.translations.providerRequests += nonNegativeNumber(event.providerRequests);
  metrics.translations.cacheHits += nonNegativeNumber(event.cacheHits);
  metrics.translations.cacheMisses += nonNegativeNumber(event.cacheMisses);
  metrics.translations.cachedChunks += nonNegativeNumber(event.cachedChunks);
  metrics.translations.savedProviderRequests += nonNegativeNumber(event.savedProviderRequests);
  metrics.translations.totalChunks += nonNegativeNumber(event.totalChunks);
  metrics.translations.durationMsTotal += nonNegativeNumber(event.durationMs);
  metrics.translations.firstChunkMsTotal += nonNegativeNumber(event.firstChunkMs);
  metrics.translations.averageDurationMs = averageMetric(
    metrics.translations.durationMsTotal,
    Math.max(1, metrics.translations.completedTotal + metrics.translations.failedTotal)
  );
  metrics.translations.averageFirstChunkMs = averageMetric(
    metrics.translations.firstChunkMsTotal,
    Math.max(1, metrics.translations.completedTotal + metrics.translations.failedTotal)
  );
  metrics.translations.cacheHitRate = averageMetric(
    metrics.translations.cacheHits,
    Math.max(1, metrics.translations.cacheHits + metrics.translations.cacheMisses)
  );
  return metrics;
}

function averageMetric(total, count) {
  return Math.round((nonNegativeNumber(total) / Math.max(1, nonNegativeNumber(count))) * 100) / 100;
}

function incrementDownloadMetrics(value, event) {
  const metrics = normalizeMetrics(value);
  const record = isRecord(event) ? event : {};
  const platform = normalizeReleasePlatform(record.platform || record.os || record.fileName);
  const version = stringOrEmpty(record.version) || 'unknown';
  const fileName = stringOrEmpty(record.fileName) || 'unknown';

  metrics.downloads.total += 1;
  incrementCounter(metrics.downloads.byPlatform, platform);
  incrementCounter(metrics.downloads.byVersion, version);
  incrementCounter(metrics.downloads.byFileName, fileName);
  metrics.downloads.latestAt = new Date().toISOString();
  return metrics;
}

function incrementVisitMetrics(value, event) {
  const metrics = normalizeMetrics(value);
  const record = normalizeVisitRecord(event);
  const day = formatMetricDay(record.visitedAt);
  const knownVisitors = metrics.visitors.knownVisitorHashes;
  const isNewVisitor = record.visitorHash && !knownVisitors[record.visitorHash];

  metrics.visitors.total += 1;
  incrementCounter(metrics.visitors.byDay, day);
  incrementCounter(metrics.visitors.byPage, record.page);
  incrementCounter(metrics.visitors.byDevice, record.device);
  incrementCounter(metrics.visitors.byBrowser, record.browser);
  incrementCounter(metrics.visitors.byOs, record.os);
  incrementCounter(metrics.visitors.byReferrer, record.referrer);
  metrics.visitors.latestAt = record.visitedAt;

  if (isNewVisitor) {
    knownVisitors[record.visitorHash] = record.visitedAt;
    metrics.visitors.uniqueTotal = Object.keys(knownVisitors).length;
    incrementCounter(metrics.visitors.uniqueByDay, day);
  } else {
    metrics.visitors.uniqueTotal = Object.keys(knownVisitors).length;
  }

  metrics.visitors.recent = [record, ...metrics.visitors.recent].slice(0, 100);
  return metrics;
}

function normalizeVisitEvent(body, request) {
  const record = isRecord(body) ? body : {};
  const userAgent = stringOrEmpty(record.userAgent) || requestHeader(request, 'user-agent');
  const visitorSource = buildVisitorSource(record, request, userAgent);
  const userAgentInfo = classifyUserAgent(userAgent);

  return normalizeVisitRecord({
    visitorHash: visitorSource ? hashString(visitorSource).slice(0, 24) : hashString(randomId()).slice(0, 24),
    page: record.page || record.pathname,
    title: record.title,
    referrer: record.referrer || requestHeader(request, 'referer'),
    language: record.language || requestHeader(request, 'accept-language'),
    device: record.device || userAgentInfo.device,
    browser: record.browser || userAgentInfo.browser,
    os: record.os || userAgentInfo.os,
    visitedAt: new Date().toISOString()
  });
}

function normalizeVisitRecord(value) {
  const record = isRecord(value) ? value : {};
  const visitedAt = new Date(stringOrEmpty(record.visitedAt));
  return {
    visitorHash: stringOrEmpty(record.visitorHash).slice(0, 64),
    page: normalizeVisitPage(record.page),
    title: stringOrEmpty(record.title).trim().slice(0, 120),
    referrer: normalizeVisitReferrer(record.referrer),
    language: normalizeVisitLanguage(record.language),
    device: normalizeVisitDimension(record.device, 'unknown'),
    browser: normalizeVisitDimension(record.browser, 'Other'),
    os: normalizeVisitDimension(record.os, 'Other'),
    visitedAt: Number.isNaN(visitedAt.getTime()) ? new Date().toISOString() : visitedAt.toISOString()
  };
}

function normalizeRecentVisits(value) {
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .map(normalizeVisitRecord)
        .filter((visit) => visit.visitorHash)
        .slice(0, 100)
    : [];
}

function normalizeStringRecord(value) {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [stringOrEmpty(key), stringOrEmpty(entryValue)])
      .filter(([key, entryValue]) => key && entryValue)
  );
}

function buildVisitorSource(record, request, userAgent) {
  const visitorId = stringOrEmpty(record.visitorId).trim();
  if (visitorId) {
    return `visitor:${visitorId.slice(0, 200)}`;
  }

  const clientIp = firstForwardedIp(requestHeader(request, 'x-forwarded-for')) || requestHeader(request, 'x-real-ip');
  const language = requestHeader(request, 'accept-language');
  const source = [clientIp, userAgent, language].filter(Boolean).join('|');
  return source ? `request:${source}` : '';
}

function requestHeader(request, headerName) {
  const headers = request?.headers || {};
  if (typeof headers.get === 'function') {
    return stringOrEmpty(headers.get(headerName));
  }

  const lowerName = headerName.toLowerCase();
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
  return matchedKey ? stringOrEmpty(headers[matchedKey]) : '';
}

function firstForwardedIp(value) {
  return stringOrEmpty(value).split(',')[0]?.trim() || '';
}

function normalizeVisitPage(value) {
  const normalized = stringOrEmpty(value).trim() || '/';
  if (!normalized.startsWith('/')) {
    return `/${normalized}`.slice(0, 120);
  }
  return normalized.slice(0, 120);
}

function normalizeVisitReferrer(value) {
  const normalized = stringOrEmpty(value).trim();
  if (!normalized) {
    return 'direct';
  }

  try {
    return new URL(normalized).hostname.replace(/^www\./, '').slice(0, 80) || 'direct';
  } catch {
    return normalized.slice(0, 80) || 'direct';
  }
}

function normalizeVisitLanguage(value) {
  return stringOrEmpty(value).split(',')[0]?.trim().slice(0, 24) || 'unknown';
}

function normalizeVisitDimension(value, fallback) {
  return stringOrEmpty(value).trim().slice(0, 40) || fallback;
}

function classifyUserAgent(userAgent) {
  const normalized = stringOrEmpty(userAgent).toLowerCase();
  const browser = normalized.includes('edg/')
    ? 'Edge'
    : normalized.includes('firefox/')
      ? 'Firefox'
      : normalized.includes('chrome/')
        ? 'Chrome'
        : normalized.includes('safari/')
          ? 'Safari'
          : 'Other';
  const os = normalized.includes('windows')
    ? 'Windows'
    : normalized.includes('android')
      ? 'Android'
      : /iphone|ipad|ios/.test(normalized)
        ? 'iOS'
        : normalized.includes('mac os')
          ? 'macOS'
          : normalized.includes('linux')
            ? 'Linux'
            : 'Other';
  const device = /ipad|tablet/.test(normalized)
    ? 'tablet'
    : /mobile|android|iphone/.test(normalized)
      ? 'mobile'
      : normalized
        ? 'desktop'
        : 'unknown';

  return { browser, os, device };
}

function formatMetricDay(date) {
  const normalizedDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(normalizedDate.getTime())) {
    return '';
  }

  return new Date(normalizedDate.getTime() + beijingOffsetMs).toISOString().slice(0, 10);
}

function normalizeCounterRecord(value) {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, count]) => [key, nonNegativeNumber(count)])
      .filter(([key, count]) => key && count > 0)
  );
}

function incrementCounter(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeDownloadManifest(value) {
  const record = isRecord(value) ? value : {};
  const releases = Array.isArray(record.releases)
    ? record.releases
        .filter(isRecord)
        .map((release) => ({
          version: stringOrEmpty(release.version),
          platform: normalizeReleasePlatform(release.platform || release.os || release.fileName),
          fileName: stringOrEmpty(release.fileName),
          url: stringOrEmpty(release.url),
          size: Number.isFinite(release.size) ? release.size : 0,
          sha512: stringOrEmpty(release.sha512),
          releaseDate: stringOrEmpty(release.releaseDate),
          releaseNotes:
            stringOrEmpty(release.releaseNotes) || stringOrEmpty(release.changelog) || stringOrEmpty(release.notes)
        }))
        .filter((release) => release.version && release.fileName && release.url)
    : [];

  return {
    latestVersion: stringOrEmpty(record.latestVersion) || releases[0]?.version || '',
    releases
  };
}

function normalizeNotifications(value) {
  return Array.isArray(value)
    ? value.filter(isRecord).map((notification) => normalizeNotification(notification)).sort(compareNotifications)
    : [];
}

function normalizeNotification(value, fallback = {}) {
  const record = isRecord(value) ? value : {};
  const fallbackRecord = isRecord(fallback) ? fallback : {};
  return {
    id: boundedString(record.id, 120) || boundedString(fallbackRecord.id, 120) || randomId(),
    title: boundedString(record.title, 120) || boundedString(fallbackRecord.title, 120) || '系统通知',
    body: boundedString(record.body, 2000) || boundedString(fallbackRecord.body, 2000),
    severity: normalizeNotificationSeverity(record.severity || fallbackRecord.severity),
    platforms: normalizeNotificationPlatforms(record.platforms ?? fallbackRecord.platforms),
    active: typeof record.active === 'boolean' ? record.active : typeof fallbackRecord.active === 'boolean' ? fallbackRecord.active : true,
    dismissible:
      typeof record.dismissible === 'boolean'
        ? record.dismissible
        : typeof fallbackRecord.dismissible === 'boolean'
          ? fallbackRecord.dismissible
          : true,
    actionLabel: boundedString(record.actionLabel, 40) || boundedString(fallbackRecord.actionLabel, 40),
    actionUrl: boundedString(record.actionUrl, 1000) || boundedString(fallbackRecord.actionUrl, 1000),
    startsAt: boundedString(record.startsAt, 80) || boundedString(fallbackRecord.startsAt, 80),
    endsAt: boundedString(record.endsAt, 80) || boundedString(fallbackRecord.endsAt, 80),
    createdAt: boundedString(record.createdAt, 80) || boundedString(fallbackRecord.createdAt, 80) || new Date().toISOString(),
    updatedAt: boundedString(record.updatedAt, 80) || boundedString(fallbackRecord.updatedAt, 80) || new Date().toISOString()
  };
}

function normalizeNotificationSeverity(value) {
  const normalized = stringOrEmpty(value).toLowerCase();
  return ['info', 'update', 'warning'].includes(normalized) ? normalized : 'info';
}

function normalizeNotificationPlatforms(value) {
  const rawValues = Array.isArray(value)
    ? value
    : stringOrEmpty(value)
      ? stringOrEmpty(value).split(/[,\s]+/)
      : [];
  return [...new Set(rawValues.map(normalizeReleasePlatform).filter(Boolean))];
}

function compareNotifications(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || '');
  const rightTime = Date.parse(right.updatedAt || right.createdAt || '');
  return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
}

function isPublicNotificationVisible(notification, filter = {}) {
  if (!notification.active) {
    return false;
  }

  const platform = normalizeNotificationPlatformFilter(filter.platform);
  if (platform && notification.platforms.length > 0 && !notification.platforms.includes(platform)) {
    return false;
  }

  const now = Date.now();
  const startsAt = Date.parse(notification.startsAt);
  const endsAt = Date.parse(notification.endsAt);
  if (Number.isFinite(startsAt) && startsAt > now) {
    return false;
  }
  if (Number.isFinite(endsAt) && endsAt < now) {
    return false;
  }

  return true;
}

function normalizeNotificationPlatformFilter(value) {
  return stringOrEmpty(value) ? normalizeReleasePlatform(value) : '';
}

function publicNotification(notification) {
  return {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    severity: notification.severity,
    platforms: notification.platforms,
    dismissible: notification.dismissible,
    actionLabel: notification.actionLabel,
    actionUrl: notification.actionUrl,
    startsAt: notification.startsAt,
    endsAt: notification.endsAt,
    updatedAt: notification.updatedAt
  };
}

function normalizeUpdateFailureReports(value) {
  return Array.isArray(value) ? value.filter(isRecord).map((report) => normalizeUpdateFailureReport(report)) : [];
}

function normalizeUpdateFailureReport(value, defaults = {}) {
  const record = isRecord(value) ? value : {};
  return {
    id: boundedString(record.id, 120) || boundedString(defaults.id, 120) || randomId(),
    receivedAt: boundedString(record.receivedAt, 80) || boundedString(defaults.receivedAt, 80) || new Date().toISOString(),
    source: boundedString(record.source, 80) || 'desktop-windows-update',
    appVersion: boundedString(record.appVersion, 80),
    platform: boundedString(record.platform, 80),
    failureReason: boundedString(record.failureReason, 500),
    transaction: normalizeUpdateFailureTransaction(record.transaction),
    logSummary: boundedString(record.logSummary, 12_000),
    error: boundedString(record.error, 1_000)
  };
}

function normalizeUpdateFailureTransaction(value) {
  const record = isRecord(value) ? value : {};
  return {
    id: boundedString(record.id, 120),
    status: boundedString(record.status, 80),
    message: boundedString(record.message, 1_000),
    failureCode: boundedString(record.failureCode, 200),
    installerExitHint: boundedString(record.installerExitHint, 1_000),
    installerPath: boundedString(record.installerPath, 1_000),
    installDirectory: boundedString(record.installDirectory, 1_000),
    coordinatorPath: boundedString(record.coordinatorPath, 1_000),
    currentProcessId: nonNegativeNumber(record.currentProcessId),
    percent: nonNegativeNumber(record.percent),
    updatedAt: boundedString(record.updatedAt, 80),
    failed: Boolean(record.failed),
    stale: Boolean(record.stale),
    recoverable: Boolean(record.recoverable)
  };
}

function boundedString(value, maxLength) {
  return stringOrEmpty(value).slice(0, maxLength);
}

function normalizeReleasePlatform(value) {
  const normalized = stringOrEmpty(value).toLowerCase();
  if (normalized.includes('mac') || normalized.includes('darwin') || normalized.endsWith('.dmg')) {
    return 'macos';
  }
  if (normalized.includes('android') || normalized.endsWith('.apk') || normalized.endsWith('.aab')) {
    return 'android';
  }
  if (normalized.includes('ios') || normalized.endsWith('.ipa')) {
    return 'ios';
  }
  return 'windows';
}
