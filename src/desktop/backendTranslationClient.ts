import { defaultQuickTranslateBackendBaseUrl, normalizeBackendBaseUrl } from '../shared/cloudEndpoint.js';
import type { TranslateTextResult } from '../shared/translator.js';
import type { TranslationFormat } from '../shared/translationFormats.js';

type BackendTranslationInput = {
  text: string;
  targetLanguage: string;
  translationFormat?: TranslationFormat;
};

type BackendTranslationClientOptions = {
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

type BackendErrorPayload = {
  error?: string;
};

const defaultTimeoutMs = 95_000;

export type BackendTranslationStreamEvent =
  | {
      type: 'start';
      totalChunks: number;
      sourceLength: number;
      mode: string;
    }
  | {
      type: 'delta';
      chunkIndex: number;
      chunkCount: number;
      text: string;
      translatedText: string;
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

export function resolveDesktopBackendBaseUrl(env: Record<string, string | undefined> = process.env) {
  return normalizeBackendBaseUrl(
    env.QUICK_TRANSLATE_BACKEND_URL ?? env.VITE_QUICK_TRANSLATE_API_URL ?? defaultQuickTranslateBackendBaseUrl
  );
}

export async function translateWithBackend(
  input: BackendTranslationInput,
  options: BackendTranslationClientOptions = {}
): Promise<TranslateTextResult> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), normalizeTimeout(options.timeoutMs));

  try {
    const response = await fetcher(`${normalizeBackendBaseUrl(options.baseUrl ?? defaultQuickTranslateBackendBaseUrl)}/api/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal
    });
    const payload = (await response.json().catch(() => ({}))) as BackendErrorPayload & Partial<TranslateTextResult>;

    if (!response.ok) {
      throw new Error(payload.error || `后台翻译通道请求失败，状态码 ${response.status}`);
    }

    if (!payload.translatedText || !payload.sourceText || !payload.targetLanguage || !payload.provider) {
      throw new Error('后台翻译通道返回内容不完整');
    }

    return payload as TranslateTextResult;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('后台翻译通道请求超时，请稍后重试');
    }

    throw error instanceof Error ? error : new Error('后台翻译通道请求失败');
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function translateWithBackendStream(
  input: BackendTranslationInput,
  onEvent: (event: BackendTranslationStreamEvent) => void,
  options: BackendTranslationClientOptions = {}
): Promise<TranslateTextResult> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), normalizeTimeout(options.timeoutMs));

  try {
    const response = await fetcher(`${normalizeBackendBaseUrl(options.baseUrl ?? defaultQuickTranslateBackendBaseUrl)}/api/translate/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as BackendErrorPayload;
      throw new Error(payload.error || `后台翻译通道请求失败，状态码 ${response.status}`);
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
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error('后台翻译通道请求超时，请稍后重试');
    }

    throw error instanceof Error ? error : new Error('后台翻译通道请求失败');
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeTimeout(value: number | undefined) {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : defaultTimeoutMs;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<BackendTranslationStreamEvent> {
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

function parseServerSentEvent(rawEvent: string): BackendTranslationStreamEvent | null {
  const dataLine = rawEvent
    .split(/\r?\n/)
    .find((line) => line.startsWith('data:'));
  const rawData = dataLine?.slice('data:'.length).trim();
  if (!rawData) {
    return null;
  }

  return JSON.parse(rawData) as BackendTranslationStreamEvent;
}
