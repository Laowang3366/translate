import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultQuickTranslateBackendBaseUrl } from '../shared/cloudEndpoint';
import { resolveDesktopBackendBaseUrl, translateWithBackend } from './backendTranslationClient';

describe('desktop backend translation client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the hosted backend channel by default', () => {
    expect(resolveDesktopBackendBaseUrl({})).toBe(defaultQuickTranslateBackendBaseUrl);
  });

  it('translates through the backend API without exposing provider credentials', async () => {
    const result = await translateWithBackend(
      {
        text: 'hello',
        targetLanguage: 'zh-CN',
        translationFormat: 'plain'
      },
      {
        baseUrl: 'https://backend.example/quick-translate/backend',
        fetcher: async (url, init) => {
          expect(url).toBe('https://backend.example/quick-translate/backend/api/translate');
          expect(init?.headers).toEqual({ 'content-type': 'application/json' });
          expect(JSON.parse(String(init?.body))).toEqual({
            text: 'hello',
            targetLanguage: 'zh-CN',
            translationFormat: 'plain'
          });

          return new Response(
            JSON.stringify({
              provider: 'openai-compatible',
              sourceText: 'hello',
              translatedText: '你好',
              targetLanguage: 'zh-CN'
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
      }
    );

    expect(result.translatedText).toBe('你好');
  });

  it('surfaces backend errors as user-facing messages', async () => {
    await expect(
      translateWithBackend(
        {
          text: 'hello',
          targetLanguage: 'zh-CN'
        },
        {
          fetcher: async () =>
            new Response(JSON.stringify({ error: '服务器翻译通道未启用' }), {
              status: 501,
              headers: { 'content-type': 'application/json' }
            })
        }
      )
    ).rejects.toThrow('服务器翻译通道未启用');
  });

  it('keeps the default request timeout aligned with backend long-text budget', async () => {
    vi.useFakeTimers();
    const pendingRequest = translateWithBackend(
      {
        text: 'long text',
        targetLanguage: 'zh-CN'
      },
      {
        fetcher: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          })
      }
    );

    await vi.advanceTimersByTimeAsync(94_999);
    const stillPending = vi.fn();
    pendingRequest.catch(stillPending);
    await Promise.resolve();
    expect(stillPending).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(pendingRequest).rejects.toThrow('后台翻译通道请求超时，请稍后重试');
  });
});
