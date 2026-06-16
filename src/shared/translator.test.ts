import { describe, expect, it, vi } from 'vitest';
import { translateText } from './translator';

describe('translateText', () => {
  it('returns a deterministic mock translation without network access', async () => {
    await expect(
      translateText({
        text: 'Hello world',
        targetLanguage: 'zh-CN',
        provider: { type: 'mock' }
      })
    ).resolves.toEqual({
      provider: 'mock',
      sourceText: 'Hello world',
      translatedText: '你好，世界',
      targetLanguage: 'zh-CN'
    });
  });

  it('translates a single hello into Chinese with the mock provider', async () => {
    await expect(
      translateText({
        text: 'hello',
        targetLanguage: 'zh-CN',
        provider: { type: 'mock' }
      })
    ).resolves.toMatchObject({
      sourceText: 'hello',
      translatedText: '你好',
      targetLanguage: 'zh-CN'
    });
  });

  it('returns a clear mock-provider message when no local demo translation exists', async () => {
    await expect(
      translateText({
        text: 'unlisted phrase',
        targetLanguage: 'zh-CN',
        provider: { type: 'mock' }
      })
    ).resolves.toMatchObject({
      translatedText: '离线示例引擎没有这段文本的示例译文，请配置后台翻译通道。'
    });
  });

  it('formats mock translations as Java lower camel case when requested', async () => {
    await expect(
      translateText({
        text: 'user display name',
        targetLanguage: 'en-US',
        translationFormat: 'java-camel-case',
        provider: { type: 'mock' }
      })
    ).resolves.toMatchObject({
      translatedText: 'userDisplayName'
    });
  });

  it('trims input before sending it to an OpenAI-compatible provider', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Bonjour' } }]
      })
    });

    await translateText({
      text: '  Good morning  ',
      targetLanguage: 'fr-FR',
      provider: {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'gpt-4.1-mini'
      },
      fetcher
    });

    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'system',
          content: 'Translate the user text into 法语 (fr-FR). Return only the translated text.'
        },
        { role: 'user', content: 'Good morning' }
      ]
    });
  });

  it('adds the selected translation format to the OpenAI-compatible system prompt', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'userName' } }]
      })
    });

    await translateText({
      text: '用户名称',
      targetLanguage: 'en-US',
      translationFormat: 'java-camel-case',
      provider: {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'gpt-4.1-mini'
      },
      fetcher
    });

    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(String(init.body)).messages[0].content).toContain('Java-style lowerCamelCase identifier');
  });

  it('adds long-text chunk context to the OpenAI-compatible system prompt without enabling search or reasoning', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '分段译文' } }]
      })
    });

    await translateText({
      text: 'Long chunk',
      targetLanguage: 'zh-CN',
      contextInstruction: '长文本分段翻译：这是第 1 段，共 3 段。保持术语、人名、上下文一致；只输出当前段译文。',
      provider: {
        type: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'secret',
        model: 'gpt-4.1-mini'
      },
      fetcher
    });

    const [, init] = fetcher.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].content).toContain('长文本分段翻译：这是第 1 段，共 3 段');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('enable_search');
    expect(body).not.toHaveProperty('web_search');
  });

  it('rejects empty source text before calling a provider', async () => {
    const fetcher = vi.fn();

    await expect(
      translateText({
        text: '   ',
        targetLanguage: 'zh-CN',
        provider: { type: 'mock' },
        fetcher
      })
    ).rejects.toThrow('原文不能为空');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts OpenAI-compatible requests after the configured timeout', async () => {
    vi.useFakeTimers();

    try {
      const fetcher = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      });

      const translation = translateText({
        text: 'hello',
        targetLanguage: 'zh-CN',
        provider: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'secret',
          model: 'gpt-4.1-mini'
        },
        fetcher,
        timeoutMs: 50,
        maxRetries: 0
      });

      const assertion = expect(translation).rejects.toThrow('翻译接口请求超时，请稍后重试');
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries 5xx OpenAI-compatible responses and succeeds later', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({ message: 'bad gateway' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '你好' } }]
        })
      });

    await expect(
      translateText({
        text: 'hello',
        targetLanguage: 'zh-CN',
        provider: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'secret',
          model: 'gpt-4.1-mini'
        },
        fetcher,
        maxRetries: 1
      })
    ).resolves.toMatchObject({
      translatedText: '你好'
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx OpenAI-compatible errors and includes the API message', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'invalid api key' } })
    });

    await expect(
      translateText({
        text: 'hello',
        targetLanguage: 'zh-CN',
        provider: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'secret',
          model: 'gpt-4.1-mini'
        },
        fetcher,
        maxRetries: 3
      })
    ).rejects.toThrow('翻译接口请求失败，状态码 401：invalid api key');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps translation request error metadata for backend logging', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'rate limit' } })
    });

    await expect(
      translateText({
        text: 'hello',
        targetLanguage: 'zh-CN',
        provider: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'secret',
          model: 'gpt-4.1-mini'
        },
        fetcher,
        maxRetries: 0
      })
    ).rejects.toMatchObject({
      name: 'TranslationRequestError',
      status: 429
    });
  });

  it('rejects empty OpenAI-compatible translation results with a Chinese error', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '   ' } }]
      })
    });

    await expect(
      translateText({
        text: 'hello',
        targetLanguage: 'zh-CN',
        provider: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'secret',
          model: 'gpt-4.1-mini'
        },
        fetcher
      })
    ).rejects.toThrow('翻译接口返回了空结果');
  });
});
