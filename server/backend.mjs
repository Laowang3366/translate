import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
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
const defaultProviderRequestTimeoutMinutes = 1;
const maxProviderRequestTimeoutMinutes = 30;
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
    latestAt: ''
  },
  downloads: {
    total: 0,
    byPlatform: {},
    byVersion: {},
    byFileName: {},
    latestAt: ''
  }
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
        if (typeof translateText !== 'function') {
          return createJsonResponse(501, { error: '服务器翻译通道未启用' });
        }
        const startedAt = Date.now();
        let result;
        try {
          result = await translateText({
            text: stringOrEmpty(body.text),
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
        await store.recordTranslationEvent();
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

  return { handleRequest, store };
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
    async recordDownloadEvent(event) {
      return files.metrics.update((value) => incrementDownloadMetrics(value, event));
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

function inferTranslationErrorStatus(error) {
  const status = errorStatus(error);
  if (isAbortError(error) || safeTranslationErrorMessage(error).includes('超时')) {
    return 504;
  }
  if (typeof status === 'number' && status >= 400) {
    return 502;
  }

  return 502;
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

function normalizeMetrics(value) {
  const record = isRecord(value) ? value : {};
  const apiCalls = isRecord(record.apiCalls) ? record.apiCalls : {};
  const translations = isRecord(record.translations) ? record.translations : {};
  const downloads = isRecord(record.downloads) ? record.downloads : {};

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
      latestAt: stringOrEmpty(translations.latestAt)
    },
    downloads: {
      total: nonNegativeNumber(downloads.total),
      byPlatform: normalizeCounterRecord(downloads.byPlatform),
      byVersion: normalizeCounterRecord(downloads.byVersion),
      byFileName: normalizeCounterRecord(downloads.byFileName),
      latestAt: stringOrEmpty(downloads.latestAt)
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

  metrics.translations.total += 1;
  incrementCounter(metrics.translations.byDay, day);
  metrics.translations.latestAt = now.toISOString();
  return metrics;
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
