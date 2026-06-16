import { getLanguageLabel } from './languages.js';
import {
  defaultTranslationFormat,
  getTranslationFormatOption,
  normalizeTranslationFormat,
  type TranslationFormat
} from './translationFormats.js';

export type MockProvider = {
  type: 'mock';
};

export type OpenAICompatibleProvider = {
  type: 'openai-compatible';
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type TranslationProvider = MockProvider | OpenAICompatibleProvider;

export type TranslateTextInput = {
  text: string;
  targetLanguage: string;
  translationFormat?: TranslationFormat;
  contextInstruction?: string;
  provider: TranslationProvider;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
};

export type TranslateTextResult = {
  provider: TranslationProvider['type'];
  sourceText: string;
  translatedText: string;
  targetLanguage: string;
};

type OpenAICompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type OpenAICompatibleErrorResponse = {
  error?: {
    message?: string;
  };
  message?: string;
};

const defaultTimeoutMs = 30_000;
const defaultMaxRetries = 1;

class TranslationRequestError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number
  ) {
    super(message);
    this.name = 'TranslationRequestError';
  }
}

const mockDictionary = new Map<string, string>([
  ['hello::zh-CN', '你好'],
  ['hi::zh-CN', '你好'],
  ['hello world::zh-CN', '你好，世界'],
  ['good morning::fr-FR', 'Bonjour'],
  ['quick translate::zh-CN', '快速翻译']
]);

export async function translateText(input: TranslateTextInput): Promise<TranslateTextResult> {
  const sourceText = input.text.trim();

  if (!sourceText) {
    throw new Error('原文不能为空');
  }

  if (input.provider.type === 'mock') {
    return {
      provider: 'mock',
      sourceText,
      translatedText: translateWithMock(sourceText, input.targetLanguage, input.translationFormat),
      targetLanguage: input.targetLanguage
    };
  }

  const fetcher = input.fetcher ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error('当前运行环境不支持网络请求');
  }

  const translatedText = await translateWithOpenAICompatibleProvider({
    sourceText,
    targetLanguage: input.targetLanguage,
    translationFormat: input.translationFormat,
    contextInstruction: input.contextInstruction,
    provider: input.provider,
    fetcher,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries
  });

  return {
    provider: 'openai-compatible',
    sourceText,
    translatedText,
    targetLanguage: input.targetLanguage
  };
}

function translateWithMock(sourceText: string, targetLanguage: string, translationFormat = defaultTranslationFormat): string {
  const formattedText = formatMockTranslation(sourceText, translationFormat);
  if (formattedText) {
    return formattedText;
  }

  const dictionaryKey = `${sourceText.toLowerCase()}::${targetLanguage}`;
  return (
    mockDictionary.get(dictionaryKey) ??
    '离线示例引擎没有这段文本的示例译文，请配置后台翻译通道。'
  );
}

async function translateWithOpenAICompatibleProvider(input: {
  sourceText: string;
  targetLanguage: string;
  translationFormat?: TranslationFormat;
  contextInstruction?: string;
  provider: OpenAICompatibleProvider;
  fetcher: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}): Promise<string> {
  const maxRetries = normalizeNonNegativeInteger(input.maxRetries, defaultMaxRetries);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await requestOpenAICompatibleTranslation(input);
    } catch (error) {
      const normalizedError = normalizeTranslationError(error);
      lastError = normalizedError;

      if (!shouldRetryTranslationError(normalizedError, attempt, maxRetries)) {
        throw normalizedError;
      }
    }
  }

  throw lastError ?? new Error('翻译接口请求失败，请稍后重试');
}

async function requestOpenAICompatibleTranslation(input: {
  sourceText: string;
  targetLanguage: string;
  translationFormat?: TranslationFormat;
  contextInstruction?: string;
  provider: OpenAICompatibleProvider;
  fetcher: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = normalizePositiveInteger(input.timeoutMs, defaultTimeoutMs);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const targetLanguageName = getLanguageLabel(input.targetLanguage);
    const translationFormat = getTranslationFormatOption(
      normalizeTranslationFormat(input.translationFormat)
    ) ?? getTranslationFormatOption(defaultTranslationFormat)!;
    const systemPrompt =
      translationFormat.value === 'plain'
        ? `Translate the user text into ${targetLanguageName} (${input.targetLanguage}). ${translationFormat.instruction}`
        : `Convert the user text into a code-friendly English name. Output format: ${translationFormat.label}. ${translationFormat.instruction}`;
    const contextInstruction = input.contextInstruction?.trim();
    const prompt = contextInstruction ? `${systemPrompt}\n${contextInstruction}` : systemPrompt;
    const response = await input.fetcher(`${input.provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.provider.apiKey}`
      },
      body: JSON.stringify({
        model: input.provider.model,
        messages: [
          {
            role: 'system',
            content: prompt
          },
          { role: 'user', content: input.sourceText }
        ],
        temperature: 0.1
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw await createHttpError(response);
    }

    return parseTranslationResponse((await parseResponseJson(response)) as OpenAICompatibleResponse);
  } catch (error) {
    throw normalizeTranslationError(error);
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatMockTranslation(sourceText: string, translationFormat: string): string | undefined {
  const words = sourceText
    .trim()
    .replace(/['"]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  if (normalizeTranslationFormat(translationFormat) === 'plain' || words.length === 0) {
    return undefined;
  }

  switch (normalizeTranslationFormat(translationFormat)) {
    case 'java-camel-case':
      return [words[0], ...words.slice(1).map(capitalizeAsciiWord)].join('');
    case 'pascal-case':
      return words.map(capitalizeAsciiWord).join('');
    case 'snake-case':
      return words.join('_');
    case 'upper-snake-case':
      return words.join('_').toUpperCase();
    case 'kebab-case':
      return words.join('-');
    case 'plain':
      return undefined;
  }
}

function capitalizeAsciiWord(word: string) {
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

function parseTranslationResponse(payload: OpenAICompatibleResponse): string {
  const translatedText = payload.choices?.[0]?.message?.content?.trim();

  if (!translatedText) {
    throw new Error('翻译接口返回了空结果');
  }

  return translatedText;
}

async function parseResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('翻译接口返回内容无法解析，请稍后重试');
  }
}

async function createHttpError(response: Response): Promise<TranslationRequestError> {
  const apiMessage = extractApiErrorMessage(await readErrorPayload(response));
  const retryable = response.status >= 500;
  const message = apiMessage
    ? `翻译接口请求失败，状态码 ${response.status}：${apiMessage}`
    : `翻译接口请求失败，状态码 ${response.status}`;

  return new TranslationRequestError(message, retryable, response.status);
}

async function readErrorPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function extractApiErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const errorPayload = payload as OpenAICompatibleErrorResponse;
  const message = errorPayload.error?.message ?? errorPayload.message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

function normalizeTranslationError(error: unknown): TranslationRequestError {
  if (error instanceof TranslationRequestError) {
    return error;
  }

  if (isAbortError(error)) {
    return new TranslationRequestError('翻译接口请求超时，请稍后重试', true);
  }

  if (error instanceof Error) {
    if (error.message.startsWith('翻译接口')) {
      return new TranslationRequestError(error.message);
    }

    return new TranslationRequestError('翻译接口网络请求失败，请检查网络或接口配置', true);
  }

  return new TranslationRequestError('翻译接口请求失败，请稍后重试', true);
}

function shouldRetryTranslationError(error: TranslationRequestError, attempt: number, maxRetries: number): boolean {
  return error.retryable && attempt < maxRetries;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}
