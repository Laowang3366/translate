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

function normalizeTimeout(value: number | undefined) {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : defaultTimeoutMs;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}
