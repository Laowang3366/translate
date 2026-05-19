import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ACCOUNT_SESSION_STORAGE_KEY } from './accountSession';
import { defaultCloudBaseUrl } from './cloudClient';
import { DEFAULT_TARGET_LANGUAGE_STORAGE_KEY } from './languagePreference';
import { FAVORITE_IDS_STORAGE_KEY, TRANSLATION_HISTORY_STORAGE_KEY } from './libraryStorage';
import { THEME_STORAGE_KEY } from './themePreference';
import { DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY } from './translationFormatPreference';
import { currentAppVersion } from './updateCenter';

const testUpdateVersion = '99.0.0';
const testWindowsInstallerName = `Quick-Translate-${testUpdateVersion}.exe`;
const testAndroidInstallerName = `Quick-Translate-Android-${testUpdateVersion}.apk`;

describe('App', () => {
  afterEach(() => {
    window.quickTranslate = undefined;
    delete (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor;
    delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function submitTranslation() {
    fireEvent.keyDown(screen.getByLabelText('原文'), {
      key: 'Enter',
      ctrlKey: true
    });
  }

  it('translates typed or pasted text through the mock provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(screen.getByText('你好')).toBeInTheDocument();
    });
  });

  it('uses the cloud translation channel in web and mobile environments without requiring login', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          provider: 'openai-compatible',
          sourceText: 'hello',
          translatedText: '云端译文',
          targetLanguage: 'zh-CN'
        })
    } as Response);

    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(screen.getByText('云端译文')).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith(`${defaultCloudBaseUrl}/api/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'hello',
        targetLanguage: 'zh-CN',
        translationFormat: 'plain'
      })
    });
  });

  it('shows the detected source language from the original text', () => {
    render(<App />);

    expect(screen.getByLabelText('检测到的源语言：自动检测')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: '我会把原生菜单栏去掉' }
    });

    expect(screen.getByLabelText('检测到的源语言：中文')).toBeInTheDocument();
  });

  it('renders a styled world-language target picker', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '目标语言：简体中文' }));

    expect(screen.getByRole('listbox', { name: '目标语言列表' })).toHaveClass('language-menu');
    expect(screen.getByRole('option', { name: '阿拉伯语' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '印地语' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '斯瓦希里语' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('检索目标语言'), {
      target: { value: '斯瓦' }
    });

    expect(screen.getByRole('option', { name: '斯瓦希里语' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '阿拉伯语' })).not.toBeInTheDocument();
  });

  it('closes the target language picker when clicking outside it', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '目标语言：简体中文' }));
    expect(screen.getByRole('listbox', { name: '目标语言列表' })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('listbox', { name: '目标语言列表' })).not.toBeInTheDocument();
  });

  it('uses the locally stored default target language for translation', async () => {
    localStorage.setItem(DEFAULT_TARGET_LANGUAGE_STORAGE_KEY, 'es-ES');
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: 'hola',
        targetLanguage: 'es-ES'
      })
    } as any;

    render(<App />);

    expect(screen.getByRole('button', { name: '目标语言：西班牙语' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'hello',
        targetLanguage: 'es-ES',
        translationFormat: 'plain'
      });
    });
  });

  it('keeps the default target language preference separate from the translate view selection', async () => {
    const setDesktopSettings = vi.fn().mockResolvedValue({
      mouseButton4Enabled: true,
      floatingTranslateShortcut: 'mouse-button-4',
      launchAtLogin: false,
      hideToTrayOnClose: true,
      defaultTargetLanguage: 'es-ES',
      defaultTranslationFormat: 'plain'
    });
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        floatingTranslateShortcut: 'mouse-button-4',
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'es-ES',
        defaultTranslationFormat: 'plain'
      }),
      onDesktopSettingsChanged: vi.fn(),
      onSelectionCaptured: vi.fn(),
      setDesktopSettings
    } as any;

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '目标语言：西班牙语' }));
    fireEvent.click(screen.getByRole('option', { name: '日语' }));
    expect(screen.getByRole('button', { name: '目标语言：日语' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(screen.getByLabelText('默认目标语言')).toHaveValue('es-ES');
    expect(setDesktopSettings).not.toHaveBeenCalled();
  });

  it('uses the locally stored translation format for translation', async () => {
    localStorage.setItem(DEFAULT_TARGET_LANGUAGE_STORAGE_KEY, 'en-US');
    localStorage.setItem(DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY, 'java-camel-case');
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'user name',
        translatedText: 'userName',
        targetLanguage: 'en-US'
      })
    } as any;

    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'user name' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'user name',
        targetLanguage: 'en-US',
        translationFormat: 'java-camel-case'
      });
    });
  });

  it('forces plain format and disables format selection when the target language is not English', async () => {
    localStorage.setItem(DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY, 'java-camel-case');
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    expect(screen.getByRole('combobox', { name: '翻译格式' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'hello',
        targetLanguage: 'zh-CN',
        translationFormat: 'plain'
      });
    });
  });

  it('renders long translations inside a scrollable result body', async () => {
    const longTranslation = Array.from({ length: 30 }, () => 'long translated content').join(' ');
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: longTranslation,
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();

    const translatedText = await screen.findByText(longTranslation);
    expect(translatedText.closest('.result-body')).toBeInTheDocument();
  });

  it('clears the current translation when the source text is manually emptied', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    const sourceInput = screen.getByLabelText('原文');
    fireEvent.change(sourceInput, {
      target: { value: 'hello' }
    });
    submitTranslation();

    expect(await screen.findByText('你好')).toBeInTheDocument();

    fireEvent.change(sourceInput, {
      target: { value: '' }
    });

    expect(screen.queryByText('你好')).not.toBeInTheDocument();
    expect(screen.getByText('翻译结果会显示在这里')).toBeInTheDocument();
  });

  it('keeps the mobile source panel expanded when clearing from the header action', () => {
    render(<App />);

    const sourceInput = screen.getByLabelText('原文');
    fireEvent.focus(sourceInput);
    fireEvent.change(sourceInput, {
      target: { value: 'hello' }
    });

    const clearButton = screen.getByRole('button', { name: '清空原文' });
    const pointerEvent = new Event('pointerdown', { bubbles: true, cancelable: true });
    clearButton.dispatchEvent(pointerEvent);
    fireEvent.click(clearButton);

    expect(pointerEvent.defaultPrevented).toBe(true);
    expect(sourceInput).toHaveValue('');
    expect(sourceInput.closest('.source-panel')).toHaveClass('mobile-source-expanded');
    expect(clearButton.closest('.panel-meta')?.querySelector('.panel-action')?.nextElementSibling).toHaveClass(
      'source-language-chip'
    );
  });

  it('renders history entries in a scrollable list region', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn(async ({ text }) => ({
        provider: 'openai-compatible',
        sourceText: text,
        translatedText: `译文 ${text}`,
        targetLanguage: 'zh-CN'
      }))
    } as any;

    render(<App />);

    const sourceInput = screen.getByLabelText('原文');
    for (const value of ['one', 'two', 'three', 'four']) {
      fireEvent.change(sourceInput, {
        target: { value }
      });
      submitTranslation();
      await screen.findByText(`译文 ${value}`);
    }

    fireEvent.click(screen.getByRole('button', { name: '历史记录' }));

    const historyList = screen.getByRole('list', { name: '历史记录列表' });
    expect(historyList).toHaveClass('entry-list');
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('selects and deletes history entries in bulk', async () => {
    localStorage.setItem(
      TRANSLATION_HISTORY_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'entry-1',
          provider: 'openai-compatible',
          sourceText: 'first',
          translatedText: '第一条',
          targetLanguage: 'zh-CN',
          createdAt: '10:00',
          targetLabel: '简体中文',
          translationFormat: 'plain',
          formatLabel: '普通翻译'
        },
        {
          id: 'entry-2',
          provider: 'openai-compatible',
          sourceText: 'second',
          translatedText: '第二条',
          targetLanguage: 'zh-CN',
          createdAt: '10:01',
          targetLabel: '简体中文',
          translationFormat: 'plain',
          formatLabel: '普通翻译'
        },
        {
          id: 'entry-3',
          provider: 'openai-compatible',
          sourceText: 'third',
          translatedText: '第三条',
          targetLanguage: 'zh-CN',
          createdAt: '10:02',
          targetLabel: '简体中文',
          translationFormat: 'plain',
          formatLabel: '普通翻译'
        }
      ])
    );
    localStorage.setItem(FAVORITE_IDS_STORAGE_KEY, JSON.stringify(['entry-1']));

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '历史记录' }));

    expect(screen.getByText('已选 0 / 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByText('已选 3 / 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消选择' }));
    expect(screen.getByText('已选 0 / 3')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('选择历史记录 first'));
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }));
    expect(screen.queryByText('第一条')).not.toBeInTheDocument();
    expect(screen.getByText('已选 0 / 2')).toBeInTheDocument();
    expect(localStorage.getItem(FAVORITE_IDS_STORAGE_KEY)).not.toContain('entry-1');

    fireEvent.click(screen.getByRole('button', { name: '全部删除' }));
    expect(screen.getByText('还没有翻译历史')).toBeInTheDocument();
  });

  it('limits translation input to 30000 characters', () => {
    render(<App />);

    const sourceInput = screen.getByLabelText('原文') as HTMLTextAreaElement;
    fireEvent.change(sourceInput, {
      target: { value: 'a'.repeat(30005) }
    });

    expect(sourceInput.value).toHaveLength(30000);
    expect(screen.getByText('30000 / 30000')).toBeInTheDocument();
  });

  it('shows the lower mouse side button as the shortcut entry point', () => {
    render(<App />);

    expect(screen.getAllByText('鼠标下侧键').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '翻译剪贴板' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '翻译格式' })).toBeInTheDocument();
  });

  it('places language chips and translation format controls in panel headers', () => {
    render(<App />);

    const formatSelect = screen.getByRole('combobox', { name: '翻译格式' });

    expect(formatSelect.closest('.result-format-control')).toBeInTheDocument();
    expect(formatSelect.closest('.result-header-actions')).toBeInTheDocument();
    expect(screen.getByLabelText('检测到的源语言：自动检测').closest('.panel-meta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '目标语言：简体中文' }).closest('.result-header-actions')).toBeInTheDocument();
    expect(screen.queryByLabelText('翻译操作')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '翻译' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开历史记录' })).not.toBeInTheDocument();
  });

  it('switches modules by horizontal screen swipes', () => {
    render(<App />);

    const content = screen.getByLabelText('功能内容');
    fireEvent.touchStart(content, {
      touches: [{ clientX: 340, clientY: 220 }]
    });
    fireEvent.touchEnd(content, {
      changedTouches: [{ clientX: 210, clientY: 230 }]
    });

    expect(screen.getByRole('heading', { name: '历史记录' })).toBeInTheDocument();

    fireEvent.touchStart(content, {
      touches: [{ clientX: 210, clientY: 220 }]
    });
    fireEvent.touchEnd(content, {
      changedTouches: [{ clientX: 340, clientY: 230 }]
    });

    expect(screen.getByLabelText('原文')).toBeInTheDocument();
  });

  it('does not render the decorative walking mascot at the bottom of the desktop app', () => {
    const { container } = render(<App />);

    expect(container.querySelector('.walking-mascot-track')).not.toBeInTheDocument();
    expect(container.querySelector('.walking-mascot-figure')).not.toBeInTheDocument();
  });

  it('automatically translates shortly after the user types in the source box', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'hello',
        targetLanguage: 'zh-CN',
        translationFormat: 'plain'
      });
    });
    expect(await screen.findByText('你好')).toBeInTheDocument();
  });

  it('uses the selected translation format from the translate toolbar', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'user name',
        translatedText: 'userName',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '目标语言：简体中文' }));
    fireEvent.click(screen.getByRole('option', { name: '英语' }));
    fireEvent.change(screen.getByRole('combobox', { name: '翻译格式' }), {
      target: { value: 'java-camel-case' }
    });
    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'user name' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'user name',
        targetLanguage: 'en-US',
        translationFormat: 'java-camel-case'
      });
    });
    expect(localStorage.getItem(DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY)).toBe('java-camel-case');
  });

  it('shows whether copying the current translation succeeded', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn().mockResolvedValue(undefined),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();
    expect(await screen.findByText('你好')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制译文' }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已复制译文');
    });
  });

  it('shows a failure notice when copying the current translation fails', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn().mockRejectedValue(new Error('copy failed')),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();
    expect(await screen.findByText('你好')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制译文' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('复制失败');
    });
  });

  it('renders user-facing controls in Chinese', () => {
    document.title = '';

    render(<App />);

    expect(document.title).toBe('快捷翻译');
    expect(screen.getByRole('heading', { name: '快捷翻译' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '翻译格式' })).toBeInTheDocument();
    expect(screen.getByLabelText('检测到的源语言：自动检测')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '目标语言：简体中文' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '翻译视图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '历史记录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收藏列表' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '账号' })).toBeInTheDocument();
    expect(screen.queryByText('Quick Translate')).not.toBeInTheDocument();
    expect(screen.queryByText('Source Language')).not.toBeInTheDocument();
    expect(screen.queryByText('Target Language')).not.toBeInTheDocument();
    expect(screen.queryByText('文件')).not.toBeInTheDocument();
    expect(screen.queryByText('编辑')).not.toBeInTheDocument();
    expect(screen.queryByText('视图')).not.toBeInTheDocument();
    expect(screen.queryByText('窗口')).not.toBeInTheDocument();
    expect(screen.queryByText('帮助')).not.toBeInTheDocument();
    expect(screen.queryByText('Speak')).not.toBeInTheDocument();
    expect(screen.queryByText('朗读')).not.toBeInTheDocument();
    expect(screen.queryByText('Mock')).not.toBeInTheDocument();
    expect(screen.queryByText('OpenAI Compatible')).not.toBeInTheDocument();
    expect(screen.queryByText('English')).not.toBeInTheDocument();
  });

  it('adds login and registration entry points for cloud backup', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号' }));

    expect(screen.getByRole('heading', { name: '账号登录' })).toBeInTheDocument();
    expect(screen.getByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
    expect(screen.getByLabelText('记住密码')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '忘记密码' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '注册' }));

    expect(screen.getByRole('heading', { name: '账号注册' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '注册并登录' })).toBeInTheDocument();
    expect(screen.getByText('登录后会同步翻译历史、收藏和本地设置。')).toBeInTheDocument();
  });

  it('logs in and stores the account session locally', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          token: 'token-1',
          user: { id: 'u1', email: 'user@example.com', displayName: '用户' }
        })
    } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(screen.getByText('用户')).toBeInTheDocument();
    });
    expect(localStorage.getItem(ACCOUNT_SESSION_STORAGE_KEY)).toContain('token-1');
  });

  it('remembers the local account password when requested', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ releases: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ notifications: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            token: 'token-1',
            user: { id: 'u1', email: 'user@example.com', displayName: '用户' }
          })
      } as Response)
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ state: { history: [], favoriteIds: [], settings: {} } })
      } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByLabelText('记住密码'));
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(localStorage.getItem('quick-translate-remembered-account')).toContain('secret123');
    });
  });

  it('syncs history and preferences to the cloud after login', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ releases: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ notifications: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            token: 'token-1',
            user: { id: 'u1', email: 'user@example.com', displayName: '用户' }
          })
      } as Response)
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ state: { history: [], favoriteIds: [], settings: {} } })
      } as Response);

    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await screen.findByText('用户');

    fireEvent.click(screen.getByRole('button', { name: '翻译视图' }));
    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(`${defaultCloudBaseUrl}/api/sync/state`, expect.objectContaining({ method: 'PUT' }));
    });
  });

  it('manually backs up local history, favorites, and settings from the account center', async () => {
    localStorage.setItem(
      TRANSLATION_HISTORY_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'entry-1',
          provider: 'openai-compatible',
          sourceText: 'hello',
          translatedText: '你好',
          targetLanguage: 'zh-CN',
          createdAt: '10:00',
          targetLabel: '简体中文',
          translationFormat: 'plain',
          formatLabel: '普通翻译'
        }
      ])
    );
    localStorage.setItem(FAVORITE_IDS_STORAGE_KEY, JSON.stringify(['entry-1']));
    localStorage.setItem(DEFAULT_TARGET_LANGUAGE_STORAGE_KEY, 'en-US');
    localStorage.setItem(DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY, 'java-camel-case');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ releases: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ notifications: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            token: 'token-1',
            user: { id: 'u1', email: 'user@example.com', displayName: '用户' }
          })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ state: { history: [], favoriteIds: [], settings: {} } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ state: { history: [], favoriteIds: [], settings: {} } })
      } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await screen.findByText('用户');

    fireEvent.click(screen.getByRole('button', { name: '手动备份' }));

    await waitFor(() => {
      expect(screen.getByText('手动备份已完成')).toBeInTheDocument();
    });
    const putCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(putCall).toBeTruthy();
    const backupBody = JSON.parse((putCall?.[1] as RequestInit).body as string);
    expect(backupBody.history[0]).toMatchObject({ id: 'entry-1', sourceText: 'hello', translatedText: '你好' });
    expect(backupBody.favoriteIds).toEqual(['entry-1']);
    expect(backupBody.settings).toMatchObject({
      defaultTargetLanguage: 'en-US',
      defaultTranslationFormat: 'java-camel-case',
      theme: 'dark'
    });
  });

  it('manually restores cloud history, favorites, and settings from the account center', async () => {
    localStorage.setItem(
      TRANSLATION_HISTORY_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'local-entry',
          provider: 'openai-compatible',
          sourceText: 'local',
          translatedText: '本地',
          targetLanguage: 'zh-CN',
          createdAt: '09:00',
          targetLabel: '简体中文',
          translationFormat: 'plain',
          formatLabel: '普通翻译'
        }
      ])
    );
    localStorage.setItem(FAVORITE_IDS_STORAGE_KEY, JSON.stringify(['local-entry']));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ releases: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ notifications: [] })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            token: 'token-1',
            user: { id: 'u1', email: 'user@example.com', displayName: '用户' }
          })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ state: { history: [], favoriteIds: [], settings: {} } })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            state: {
              history: [
                {
                  id: 'cloud-entry',
                  provider: 'openai-compatible',
                  sourceText: 'cloud',
                  translatedText: '云端',
                  targetLanguage: 'en-US',
                  createdAt: '10:00',
                  targetLabel: '英语',
                  translationFormat: 'java-camel-case',
                  formatLabel: 'Java 驼峰命名'
                }
              ],
              favoriteIds: ['cloud-entry'],
              settings: {
                defaultTargetLanguage: 'en-US',
                defaultTranslationFormat: 'java-camel-case',
                theme: 'dark'
              }
            }
          })
      } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '账号' }));
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await screen.findByText('用户');

    fireEvent.click(screen.getByRole('button', { name: '云端恢复' }));

    await waitFor(() => {
      expect(screen.getByText('云端数据已恢复')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(`${defaultCloudBaseUrl}/api/sync/state`, expect.objectContaining({ method: 'GET' }));
    fireEvent.click(screen.getByRole('button', { name: '历史记录' }));
    expect(screen.getByText('云端')).toBeInTheDocument();
    expect(screen.queryByText('本地')).not.toBeInTheDocument();
    expect(localStorage.getItem(FAVORITE_IDS_STORAGE_KEY)).toContain('cloud-entry');
    expect(localStorage.getItem(DEFAULT_TARGET_LANGUAGE_STORAGE_KEY)).toBe('en-US');
    expect(localStorage.getItem(DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY)).toBe('java-camel-case');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('switches the app theme from settings and stores the preference', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '深色主题' }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: '深色主题' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '浅色主题' }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('routes internal window controls through the desktop bridge', () => {
    const windowControl = vi.fn().mockResolvedValue(undefined);
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      windowControl
    } as any;

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '最大化或还原窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));

    expect(windowControl).toHaveBeenNthCalledWith(1, 'minimize');
    expect(windowControl).toHaveBeenNthCalledWith(2, 'toggle-maximize');
    expect(windowControl).toHaveBeenNthCalledWith(3, 'quit-app');
  });

  it('toggles always-on-top from the title bar and defaults to not pinned', async () => {
    const windowControl = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      windowControl
    } as any;

    render(<App />);

    const pinButton = screen.getByRole('button', { name: '置顶窗口' });
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pinButton);

    await waitFor(() => {
      expect(windowControl).toHaveBeenCalledWith('toggle-always-on-top');
    });
    expect(screen.getByRole('button', { name: '取消置顶' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: '取消置顶' }));

    await waitFor(() => {
      expect(windowControl).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole('button', { name: '置顶窗口' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides engine and API configuration from the user interface', () => {
    render(<App />);

    expect(screen.queryByLabelText('引擎')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('接口密钥')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('接口地址')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('模型名称')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '离线示例' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '兼容接口' })).not.toBeInTheDocument();
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();
    expect(screen.queryByText('Base URL')).not.toBeInTheDocument();
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });

  it('uses the hidden Electron translation channel when it is available', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '后台通道译文',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.change(screen.getByLabelText('原文'), {
      target: { value: 'hello' }
    });
    submitTranslation();

    await waitFor(() => {
      expect(screen.getByText('后台通道译文')).toBeInTheDocument();
    });
    expect(window.quickTranslate.translateText).toHaveBeenCalledWith({
      text: 'hello',
      targetLanguage: 'zh-CN',
      translationFormat: 'plain'
    });
  });

  it('renders and updates desktop settings when running in Electron', async () => {
    let currentDesktopSettings = {
      mouseButton4Enabled: true,
      floatingTranslateShortcut: 'mouse-button-4',
      floatingWindowPositionMode: 'follow-cursor',
      customFloatingWindowPosition: null,
      launchAtLogin: false,
      hideToTrayOnClose: true,
      defaultTargetLanguage: 'es-ES',
      defaultTranslationFormat: 'plain',
      updatePackageDirectory: 'D:\\QuickTranslate\\packages'
    };
    const clearUpdatePackages = vi.fn().mockResolvedValue({
      directory: 'D:\\QuickTranslate\\packages',
      deletedCount: 2
    });
    const openUpdatePackageDirectory = vi.fn().mockResolvedValue(true);
    const chooseUpdatePackageDirectory = vi.fn().mockImplementation(() => {
      currentDesktopSettings = {
        ...currentDesktopSettings,
        updatePackageDirectory: 'F:\\QuickTranslate\\selected'
      };
      return Promise.resolve(currentDesktopSettings);
    });
    const saveFloatingWindowPosition = vi.fn().mockImplementation(() => {
      currentDesktopSettings = {
        ...currentDesktopSettings,
        floatingWindowPositionMode: 'custom-position',
        customFloatingWindowPosition: { x: 246, y: 132 }
      };
      return Promise.resolve(currentDesktopSettings);
    });
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      chooseUpdatePackageDirectory,
      clearUpdatePackages,
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue(currentDesktopSettings),
      openUpdatePackageDirectory,
      saveFloatingWindowPosition,
      setDesktopSettings: vi.fn().mockImplementation((patch) => {
        currentDesktopSettings = {
          ...currentDesktopSettings,
          ...patch,
          mouseButton4Enabled: patch.floatingTranslateShortcut
            ? patch.floatingTranslateShortcut === 'mouse-button-4'
            : currentDesktopSettings.mouseButton4Enabled
        };
        return Promise.resolve(currentDesktopSettings);
      })
    };

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(await screen.findByRole('heading', { name: '界面外观' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '窗口操作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新加载界面' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开开发者工具' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '退出应用' })).not.toBeInTheDocument();

    expect(screen.getByLabelText('悬浮翻译快捷键')).toHaveValue('mouse-button-4');
    const floatingWindowPositionSelect = screen.getByLabelText('悬浮窗出现位置') as HTMLSelectElement;
    expect(floatingWindowPositionSelect).toHaveValue('follow-cursor');
    expect(Array.from(floatingWindowPositionSelect.options).map((option) => option.textContent)).toEqual([
      '跟随鼠标',
      '第一次出现的位置',
      '自定义屏幕位置'
    ]);
    expect(screen.getByLabelText('更新包保存路径')).toHaveValue('D:\\QuickTranslate\\packages');
    const launchAtLogin = await screen.findByLabelText('开机自启');
    expect(launchAtLogin).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('悬浮翻译快捷键'), {
      target: { value: 'ctrl-alt-t' }
    });

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        floatingTranslateShortcut: 'ctrl-alt-t'
      });
    });

    fireEvent.change(floatingWindowPositionSelect, {
      target: { value: 'first-position' }
    });

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        floatingWindowPositionMode: 'first-position'
      });
    });

    fireEvent.change(floatingWindowPositionSelect, {
      target: { value: 'custom-position' }
    });

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        floatingWindowPositionMode: 'custom-position'
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '保存当前悬浮窗位置' }));
    await waitFor(() => {
      expect(saveFloatingWindowPosition).toHaveBeenCalledOnce();
    });
    expect(screen.getByText('悬浮窗位置已保存')).toBeInTheDocument();
    expect(screen.getByText('已保存：246, 132')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('悬浮翻译快捷键'), {
      target: { value: 'custom' }
    });
    fireEvent.keyDown(screen.getByRole('button', { name: '录入悬浮翻译快捷键' }), {
      key: 'k',
      code: 'KeyK',
      ctrlKey: true,
      altKey: true
    });

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        floatingTranslateShortcut: 'custom:CommandOrControl+Alt+K'
      });
    });
    expect(screen.getByLabelText('悬浮翻译快捷键')).toHaveValue('custom');
    expect(screen.getByText('Ctrl + Alt + K')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '录入悬浮翻译快捷键' }));
    fireEvent.keyDown(screen.getByRole('button', { name: '录入悬浮翻译快捷键' }), {
      key: ';',
      code: 'Semicolon'
    });

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        floatingTranslateShortcut: 'custom:;'
      });
    });
    expect(screen.getByText(';')).toBeInTheDocument();

    fireEvent.click(launchAtLogin);

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        launchAtLogin: true
      });
    });
    expect(launchAtLogin).toBeChecked();
    expect(screen.getByLabelText('悬浮翻译快捷键')).toHaveValue('custom');
    expect(screen.getByLabelText('关闭时隐藏到托盘')).toBeChecked();

    fireEvent.change(screen.getByLabelText('默认目标语言'), {
      target: { value: 'ja-JP' }
    });

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        defaultTargetLanguage: 'ja-JP'
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '翻译视图' }));
    expect(screen.getByRole('button', { name: '目标语言：日语' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    fireEvent.change(screen.getByLabelText('翻译格式'), {
      target: { value: 'java-camel-case' }
    });

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        defaultTranslationFormat: 'java-camel-case'
      });
    });

    fireEvent.change(screen.getByLabelText('更新包保存路径'), {
      target: { value: 'E:\\QuickTranslate\\updates' }
    });
    fireEvent.click(screen.getByRole('button', { name: '保存更新包保存路径' }));

    await waitFor(() => {
      expect(window.quickTranslate?.setDesktopSettings).toHaveBeenCalledWith({
        updatePackageDirectory: 'E:\\QuickTranslate\\updates'
      });
    });

    fireEvent.click(screen.getByRole('button', { name: '选择更新包目录' }));
    await waitFor(() => {
      expect(chooseUpdatePackageDirectory).toHaveBeenCalledOnce();
    });
    expect(screen.getByLabelText('更新包保存路径')).toHaveValue('F:\\QuickTranslate\\selected');
    expect(screen.getByText('更新包保存路径已选择')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开更新包目录' }));
    await waitFor(() => {
      expect(openUpdatePackageDirectory).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole('button', { name: '清理更新安装包' }));
    await waitFor(() => {
      expect(clearUpdatePackages).toHaveBeenCalledOnce();
    });
    expect(screen.getByText('已清理 2 个更新安装包')).toBeInTheDocument();
  });

  it('prompts before saving a custom floating window position when the floating window is closed', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        floatingTranslateShortcut: 'mouse-button-4',
        floatingWindowPositionMode: 'follow-cursor',
        customFloatingWindowPosition: null,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain',
        updatePackageDirectory: 'D:\\QuickTranslate\\packages'
      }),
      onSelectionCaptured: vi.fn(),
      saveFloatingWindowPosition: vi.fn().mockResolvedValue(null),
      setDesktopSettings: vi.fn().mockImplementation((patch) =>
        Promise.resolve({
          mouseButton4Enabled: true,
          floatingTranslateShortcut: 'mouse-button-4',
          floatingWindowPositionMode: 'custom-position',
          customFloatingWindowPosition: null,
          launchAtLogin: false,
          hideToTrayOnClose: true,
          defaultTargetLanguage: 'zh-CN',
          defaultTranslationFormat: 'plain',
          updatePackageDirectory: 'D:\\QuickTranslate\\packages',
          ...patch
        })
      )
    } as any;

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(await screen.findByLabelText('悬浮窗出现位置'), {
      target: { value: 'custom-position' }
    });
    fireEvent.click(await screen.findByRole('button', { name: '保存当前悬浮窗位置' }));

    await waitFor(() => {
      expect(window.quickTranslate?.saveFloatingWindowPosition).toHaveBeenCalledOnce();
    });
    expect(screen.getByText('请先打开悬浮窗并拖到目标位置')).toBeInTheDocument();
  });

  it('does not show settings hints below the translate input panels', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onDesktopSettingsChanged: vi.fn(),
      onSelectionCaptured: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        floatingTranslateShortcut: 'ctrl-alt-t',
        launchAtLogin: true,
        hideToTrayOnClose: false,
        defaultTargetLanguage: 'en-US',
        defaultTranslationFormat: 'java-camel-case'
      })
    } as any;

    render(<App />);

    await waitFor(() => {
      expect(window.quickTranslate?.getDesktopSettings).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText('当前设置信息')).not.toBeInTheDocument();
    expect(screen.queryByText('悬浮翻译')).not.toBeInTheDocument();
    expect(screen.queryByText('开机自启')).not.toBeInTheDocument();
    expect(screen.queryByText('默认翻译格式')).not.toBeInTheDocument();
  });

  it('keeps the mobile source input compact until the user edits it', () => {
    render(<App />);

    const sourcePanel = screen.getByLabelText('原文面板');
    const sourceInput = screen.getByLabelText('原文');

    expect(sourcePanel).toHaveClass('mobile-source-collapsed');
    expect(sourcePanel).not.toHaveClass('mobile-source-expanded');

    fireEvent.focus(sourceInput);
    expect(sourcePanel).toHaveClass('mobile-source-expanded');
    expect(sourcePanel).not.toHaveClass('mobile-source-collapsed');

    fireEvent.change(sourceInput, {
      target: { value: 'hello' }
    });
    fireEvent.blur(sourceInput);

    expect(sourcePanel).toHaveClass('mobile-source-collapsed');
    expect(sourceInput).toHaveValue('hello');
  });

  it('shows a mobile paste action when clipboard text is available', async () => {
    const readText = vi.fn().mockResolvedValue('clipboard text');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText }
    });
    render(<App />);

    const pasteButton = await screen.findByRole('button', { name: '粘贴剪切板内容' });
    fireEvent.click(pasteButton);

    await waitFor(() => {
      expect(screen.getByLabelText('原文')).toHaveValue('clipboard text');
    });
  });

  it('hides the mobile paste action when the clipboard has no text', async () => {
    const readText = vi.fn().mockResolvedValue('   ');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText }
    });
    render(<App />);

    await waitFor(() => {
      expect(readText).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: '粘贴剪切板内容' })).not.toBeInTheDocument();
  });

  it('renders Android floating ball controls and opens the clipboard panel', async () => {
    const getState = vi.fn().mockResolvedValue({
      available: true,
      platform: 'android',
      canDrawOverlays: false,
      canListenKeyEvents: false,
      enabled: false,
      targetLanguage: 'zh-CN',
      translationFormat: 'plain',
      shortcutKeyCode: 0,
      shortcutLabel: '',
      hasPendingSharedText: false
    });
    const configure = vi.fn().mockImplementation((input: { enabled?: boolean }) => Promise.resolve({
      available: true,
      platform: 'android',
      canDrawOverlays: false,
      canListenKeyEvents: false,
      enabled: input.enabled ?? false,
      targetLanguage: 'zh-CN',
      translationFormat: 'plain',
      shortcutKeyCode: 0,
      shortcutLabel: '',
      hasPendingSharedText: false
    }));
    const requestOverlayPermission = vi.fn().mockResolvedValue({
      available: true,
      platform: 'android',
      canDrawOverlays: false,
      canListenKeyEvents: false,
      enabled: true,
      targetLanguage: 'zh-CN',
      translationFormat: 'plain',
      shortcutKeyCode: 0,
      shortcutLabel: '',
      hasPendingSharedText: false
    });
    const showFloatingTranslateFromClipboard = vi.fn().mockResolvedValue({
      available: true,
      platform: 'android',
      canDrawOverlays: true,
      canListenKeyEvents: false,
      enabled: true,
      targetLanguage: 'zh-CN',
      translationFormat: 'plain',
      shortcutKeyCode: 0,
      shortcutLabel: '',
      hasPendingSharedText: false
    });
    (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        MobileFloatingTranslate: {
          addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
          configure,
          consumePendingSharedText: vi.fn().mockResolvedValue({ text: '' }),
          getState,
          requestOverlayPermission,
          showFloatingTranslate: vi.fn(),
          showFloatingTranslateFromClipboard
        }
      }
    };

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(await screen.findByRole('heading', { name: '手机悬浮翻译' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('启用手机悬浮翻译'));

    await waitFor(() => {
      expect(configure.mock.calls).toContainEqual([{
        enabled: true,
        targetLanguage: 'zh-CN',
        translationFormat: 'plain'
      }]);
    });

    fireEvent.click(screen.getByRole('button', { name: '打开权限设置' }));
    await waitFor(() => {
      expect(requestOverlayPermission).toHaveBeenCalledOnce();
    });

    expect(screen.queryByText('按键监听服务')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '录入按键' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '模拟悬浮球点击' }));
    await waitFor(() => {
      expect(showFloatingTranslateFromClipboard).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('已打开悬浮翻译窗，剪切板为空时可手动输入')).toBeInTheDocument();
  });

  it('hides the Android floating window when the translate view is active', async () => {
    const state = {
      available: true,
      platform: 'android',
      canDrawOverlays: true,
      canListenKeyEvents: false,
      enabled: true,
      targetLanguage: 'zh-CN',
      translationFormat: 'plain',
      shortcutKeyCode: 0,
      shortcutLabel: '',
      hasPendingSharedText: false
    };
    const hideFloatingTranslate = vi.fn().mockResolvedValue(state);
    (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        MobileFloatingTranslate: {
          addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
          configure: vi.fn().mockResolvedValue(state),
          consumePendingSharedText: vi.fn().mockResolvedValue({ text: '' }),
          getState: vi.fn().mockResolvedValue(state),
          hideFloatingTranslate,
          requestOverlayPermission: vi.fn(),
          showFloatingTranslate: vi.fn(),
          showFloatingTranslateFromClipboard: vi.fn()
        }
      }
    };

    render(<App />);

    await waitFor(() => {
      expect(hideFloatingTranslate).toHaveBeenCalledOnce();
    });

    fireEvent.click(screen.getByRole('button', { name: '翻译视图' }));
    await waitFor(() => {
      expect(hideFloatingTranslate).toHaveBeenCalledTimes(2);
    });
  });

  it('opens the Android floating window for shared text when enabled', async () => {
    let sharedTextListener: ((payload: { text?: string }) => void) | null = null;
    const state = {
      available: true,
      platform: 'android',
      canDrawOverlays: true,
      canListenKeyEvents: true,
      enabled: true,
      targetLanguage: 'zh-CN',
      translationFormat: 'plain',
      shortcutKeyCode: 25,
      shortcutLabel: '音量下键',
      hasPendingSharedText: false
    };
    const showFloatingTranslate = vi.fn().mockResolvedValue(state);
    (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        MobileFloatingTranslate: {
          addListener: vi.fn().mockImplementation((_eventName, callback) => {
            sharedTextListener = callback;
            return Promise.resolve({ remove: vi.fn() });
          }),
          configure: vi.fn().mockResolvedValue(state),
          consumePendingSharedText: vi.fn().mockResolvedValue({ text: '' }),
          getState: vi.fn().mockResolvedValue(state),
          requestOverlayPermission: vi.fn(),
          showFloatingTranslate
        }
      }
    };

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '手机悬浮翻译' })).toBeInTheDocument();

    await waitFor(() => expect(sharedTextListener).toEqual(expect.any(Function)));

    await act(async () => {
      sharedTextListener?.({ text: 'shared hello' });
    });

    await waitFor(() => {
      expect(showFloatingTranslate).toHaveBeenCalledWith({
        text: 'shared hello',
        targetLanguage: 'zh-CN',
        translationFormat: 'plain'
      });
    });
  });

  it('does not handle floating translation shortcuts inside the main window', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn().mockResolvedValue('Hello world'),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'Hello world',
        translatedText: '你好，世界',
        targetLanguage: 'zh-CN'
      })
    } as any;

    render(<App />);

    fireEvent.mouseUp(window, { button: 3 });

    expect(window.quickTranslate.captureSelectedText).not.toHaveBeenCalled();
    expect(window.quickTranslate.translateText).not.toHaveBeenCalled();
    expect(screen.queryByText('你好，世界')).not.toBeInTheDocument();
  });

  it('shows a new desktop version in the settings update card', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          latestVersion: testUpdateVersion,
          releases: [
            {
              version: testUpdateVersion,
              platform: 'windows',
              fileName: testWindowsInstallerName,
              url: 'https://example.com/quick-translate.exe'
            }
          ]
        })
    } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(await screen.findByText('发现新版本')).toBeInTheDocument();
    expect(screen.getByText(`版本 ${testUpdateVersion}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeEnabled();
  });

  it('shows an in-app update dialog with release notes when a client update is available', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          releases: [
            {
              version: testUpdateVersion,
              platform: 'windows',
              fileName: testWindowsInstallerName,
              url: 'https://example.com/quick-translate.exe',
              releaseNotes: '修复移动端输入框交互\n增加更新弹窗'
            }
          ]
        })
    } as Response);

    render(<App />);

    expect(await screen.findByRole('dialog', { name: '发现新版本' })).toBeInTheDocument();
    expect(screen.getByText('更新日志')).toBeInTheDocument();
    expect(screen.getByText('修复移动端输入框交互')).toBeInTheDocument();
    expect(screen.getByText('增加更新弹窗')).toBeInTheDocument();
  });

  it('shows public client notifications as a dismissible popup and titlebar entry', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (url.includes('/api/notifications')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              notifications: [
                {
                  id: 'notice-1',
                  title: '更新公告',
                  body: '请前往官网下载最新版本安装更新。',
                  severity: 'update',
                  platforms: ['windows', 'android'],
                  dismissible: true,
                  actionLabel: '前往官网',
                  actionUrl: 'https://sg.lwvpscc.top'
                }
              ]
            })
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ releases: [] })
      } as Response);
    });

    render(<App />);

    expect(await screen.findByRole('dialog', { name: '更新公告' })).toBeInTheDocument();
    expect(screen.getByText('请前往官网下载最新版本安装更新。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前往官网' }));

    expect(open).toHaveBeenCalledWith('https://sg.lwvpscc.top', '_blank', 'noopener,noreferrer');
    expect(localStorage.getItem('quick-translate-dismissed-notifications')).toContain('notice-1');
    expect(screen.getByRole('button', { name: '通知' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '通知' }));
    expect(await screen.findByRole('dialog', { name: '通知中心' })).toBeInTheDocument();
    expect(screen.getAllByText('更新公告').length).toBeGreaterThan(0);
  });

  it('keeps an ignored update version in local storage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          releases: [
            {
              version: testUpdateVersion,
              platform: 'windows',
              fileName: testWindowsInstallerName,
              url: 'https://example.com/quick-translate.exe'
            }
          ]
        })
    } as Response);

    const { unmount } = render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByText('发现新版本')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '忽略本版本' }));

    expect(screen.getByText('已忽略本版本')).toBeInTheDocument();

    unmount();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(await screen.findByText('已忽略本版本')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载并安装' })).toBeDisabled();
  });

  it('does not open the desktop installer URL when the packaged updater is unavailable', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const checkForUpdates = vi.fn().mockResolvedValue({
      status: 'error',
      currentVersion: '0.1.23',
      message: "ENOENT: no such file or directory, open 'app-update.yml'"
    });
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      checkForUpdates
    } as any;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          releases: [
            {
              version: testUpdateVersion,
              platform: 'windows',
              fileName: testWindowsInstallerName,
              url: 'https://example.com/quick-translate.exe'
            }
          ]
        })
    } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByText(`版本 ${testUpdateVersion}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下载并安装' }));

    await waitFor(() => {
      expect(checkForUpdates).toHaveBeenCalledOnce();
    });
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent("ENOENT: no such file or directory, open 'app-update.yml'");
  });

  it('shows desktop update download progress from the desktop bridge', async () => {
    let progressCallback: ((progress: {
      status: 'downloading';
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
      message: string;
    }) => void) | undefined;
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onSelectionCaptured: vi.fn(),
      onUpdateProgress: vi.fn((callback) => {
        progressCallback = callback as typeof progressCallback;
        return vi.fn();
      })
    } as any;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          releases: [
            {
              version: testUpdateVersion,
              platform: 'windows',
              fileName: testWindowsInstallerName,
              url: 'https://example.com/quick-translate.exe'
            }
          ]
        })
    } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByText(`版本 ${testUpdateVersion}`)).toBeInTheDocument();

    act(() => {
      progressCallback?.({
        status: 'downloading',
        percent: 48,
        transferred: 48_000,
        total: 100_000,
        bytesPerSecond: 12_000,
        message: '正在下载更新'
      });
    });

    expect(screen.getByText('正在下载更新 48%')).toBeInTheDocument();
    expect(screen.getByText('46.9 KB / 97.7 KB · 11.7 KB/s')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '更新进度' })).toHaveAttribute('aria-valuenow', '48');
  });

  it('shows the latest desktop update transaction and recovery actions', async () => {
    const getLatestUpdateTransaction = vi.fn().mockResolvedValue({
      id: 'tx-1',
      installerPath: 'D:\\QuickTranslate\\Quick-Translate-99.0.0.exe',
      installDirectory: 'C:\\Program Files\\快捷翻译',
      currentProcessId: 1234,
      status: 'waiting-app-exit',
      percent: 35,
      message: '正在等待旧版本退出',
      updatedAt: '2026-05-12T08:00:00.000Z',
      logPath: 'C:\\Temp\\QuickTranslateUpdateLauncher-1234.log',
      recoverable: true,
      stale: false,
      ageMs: 120_000
    });
    const retryUpdateTransaction = vi.fn().mockResolvedValue(true);
    const openUpdateTransactionLogDirectory = vi.fn().mockResolvedValue(true);
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getLatestUpdateTransaction,
      onSelectionCaptured: vi.fn(),
      openUpdateTransactionLogDirectory,
      retryUpdateTransaction
    } as any;

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(await screen.findByLabelText('最近更新事务')).toBeInTheDocument();
    expect(screen.getByText('等待旧版本退出')).toBeInTheDocument();
    expect(screen.getByText('最近一次更新事务')).toBeInTheDocument();
    expect(screen.getByText(/正在等待旧版本退出/)).toBeInTheDocument();
    expect(screen.getByText(/安装目录：C:\\Program Files\\快捷翻译/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '更新事务进度' })).toHaveAttribute('aria-valuenow', '35');

    fireEvent.click(screen.getByRole('button', { name: '重试安装' }));
    await waitFor(() => {
      expect(retryUpdateTransaction).toHaveBeenCalledWith({ transactionId: 'tx-1' });
    });

    fireEvent.click(screen.getByRole('button', { name: '打开日志' }));
    await waitFor(() => {
      expect(openUpdateTransactionLogDirectory).toHaveBeenCalledWith({ transactionId: 'tx-1' });
    });
  });

  it('shows failed or stale update transactions as recoverable', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getLatestUpdateTransaction: vi.fn().mockResolvedValue({
        id: 'tx-failed',
        installerPath: 'D:\\QuickTranslate\\Quick-Translate-99.0.0.exe',
        status: 'failed',
        percent: 72,
        message: '安装器启动后未完成',
        updatedAt: '2026-05-12T08:05:00.000Z',
        recoverable: false,
        stale: true
      }),
      onSelectionCaptured: vi.fn(),
      openUpdateTransactionLogDirectory: vi.fn().mockResolvedValue(true),
      retryUpdateTransaction: vi.fn().mockResolvedValue(true)
    } as any;

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));

    expect(await screen.findByText('更新失败')).toBeInTheDocument();
    expect(screen.getByText('安装器启动后未完成')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试安装' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '打开日志' })).toBeEnabled();
  });

  it('installs Android APK updates through the Capacitor plugin', async () => {
    let progressListener: ((progress: unknown) => void) | undefined;
    let resolveInstall: (() => void) | undefined;
    const removeListener = vi.fn();
    const addListener = vi.fn((eventName: string, listener: (progress: unknown) => void) => {
      progressListener = listener;
      return Promise.resolve({ remove: removeListener });
    });
    const installUpdateApk = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInstall = resolve;
        })
    );
    (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        UpdateInstaller: {
          addListener,
          installUpdateApk
        }
      }
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          releases: [
            {
              version: testUpdateVersion,
              platform: 'android',
              fileName: testAndroidInstallerName,
              url: 'https://example.com/quick-translate.apk',
              sha512: 'sha512-value'
            }
          ]
        })
    } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByText(`版本 ${testUpdateVersion}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));

    await waitFor(() => {
      expect(installUpdateApk).toHaveBeenCalledWith({
        url: 'https://example.com/quick-translate.apk',
        sha512: 'sha512-value'
      });
    });
    expect(addListener).toHaveBeenCalledWith('downloadProgress', expect.any(Function));

    act(() => {
      progressListener?.({
        status: 'downloading',
        percent: 42,
        transferred: 42_000,
        total: 100_000,
        message: '正在下载更新'
      });
    });

    expect(screen.getByText('正在下载更新 42%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '更新进度' })).toHaveAttribute('aria-valuenow', '42');

    act(() => {
      resolveInstall?.();
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('已打开系统安装确认页');
    });
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('opens the APK download URL when the Android install plugin is unavailable', async () => {
    (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {}
    };
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          releases: [
            {
              version: testUpdateVersion,
              platform: 'android',
              fileName: testAndroidInstallerName,
              url: 'https://example.com/quick-translate.apk'
            }
          ]
        })
    } as Response);

    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByText(`版本 ${testUpdateVersion}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }));

    expect(open).toHaveBeenCalledWith('https://example.com/quick-translate.apk', '_blank', 'noopener,noreferrer');
  });
});
