import type { StoredTranslationEntry } from './libraryStorage';
import type { ThemePreference } from './themePreference';
import { defaultQuickTranslateBackendBaseUrl, normalizeBackendBaseUrl } from '../shared/cloudEndpoint';
import type { TranslateTextResult } from '../shared/translator';
import type { TranslationFormat } from '../shared/translationFormats';

export const defaultCloudBaseUrl =
  import.meta.env.VITE_QUICK_TRANSLATE_API_URL || defaultQuickTranslateBackendBaseUrl;

export type CloudUser = {
  id: string;
  email: string;
  displayName: string;
};

export type CloudAuthResult = {
  user: CloudUser;
  token: string;
};

export type CloudSyncedSettings = {
  defaultTargetLanguage?: string;
  defaultTranslationFormat?: TranslationFormat;
  theme?: ThemePreference;
};

export type CloudSyncedState = {
  history: StoredTranslationEntry[];
  favoriteIds: string[];
  settings: CloudSyncedSettings;
};

type CloudClientOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
};

export type TranslationStreamEvent =
  | {
      type: 'start';
      totalChunks: number;
      sourceLength: number;
      mode: string;
    }
  | {
      type: 'chunk';
      chunkIndex: number;
      chunkCount: number;
      progress: number;
      translatedText: string;
      fromCache: boolean;
    }
  | {
      type: 'done';
      result: TranslateTextResult;
    }
  | {
      type: 'error';
      status: number;
      error: string;
    };

export function createCloudClient(options: CloudClientOptions = {}) {
  const baseUrl = normalizeBackendBaseUrl(options.baseUrl ?? defaultCloudBaseUrl);
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await fetcher(`${baseUrl}${pathname}`, init);
    const payload = (await response.json().catch(() => ({}))) as { error?: string };

    if (!response.ok) {
      throw new Error(payload.error || `云端请求失败，状态码 ${response.status}`);
    }

    return payload as T;
  }

  return {
    register(input: { email: string; password: string; displayName: string }) {
      return request<CloudAuthResult>('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      });
    },
    login(input: { email: string; password: string }) {
      return request<CloudAuthResult>('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      });
    },
    async loadState(token: string) {
      const payload = await request<{ state: CloudSyncedState }>('/api/sync/state', {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` }
      });
      return payload.state;
    },
    async saveState(token: string, state: CloudSyncedState) {
      const payload = await request<{ state: CloudSyncedState }>('/api/sync/state', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(state)
      });
      return payload.state;
    },
    translate(input: {
      text: string;
      targetLanguage: string;
      translationFormat?: TranslationFormat;
    }): Promise<TranslateTextResult> {
      return request<TranslateTextResult>('/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      });
    },
    async translateStream(
      input: {
        text: string;
        targetLanguage: string;
        translationFormat?: TranslationFormat;
      },
      onEvent: (event: TranslationStreamEvent) => void
    ): Promise<TranslateTextResult> {
      const response = await fetcher(`${baseUrl}/api/translate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `云端请求失败，状态码 ${response.status}`);
      }
      if (!response.body) {
        throw new Error('当前环境不支持流式翻译');
      }

      let finalResult: TranslateTextResult | null = null;
      for await (const event of readServerSentEvents(response.body)) {
        onEvent(event);
        if (event.type === 'error') {
          throw new Error(event.error || '流式翻译失败');
        }
        if (event.type === 'done') {
          finalResult = event.result;
        }
      }

      if (!finalResult?.translatedText) {
        throw new Error('流式翻译未返回译文');
      }

      return finalResult;
    }
  };
}

export type CloudClient = ReturnType<typeof createCloudClient>;

async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TranslationStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n/);
      buffer = events.pop() || '';
      for (const event of events) {
        const parsedEvent = parseServerSentEvent(event);
        if (parsedEvent) {
          yield parsedEvent;
        }
      }
    }

    buffer += decoder.decode();
    const parsedEvent = parseServerSentEvent(buffer);
    if (parsedEvent) {
      yield parsedEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseServerSentEvent(rawEvent: string): TranslationStreamEvent | null {
  const dataLine = rawEvent
    .split(/\r?\n/)
    .find((line) => line.startsWith('data:'));
  const rawData = dataLine?.slice('data:'.length).trim();
  if (!rawData) {
    return null;
  }

  return JSON.parse(rawData) as TranslationStreamEvent;
}
