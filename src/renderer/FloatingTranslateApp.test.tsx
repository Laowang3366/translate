import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FloatingTranslateApp } from './FloatingTranslateApp';
import { DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY } from './translationFormatPreference';

describe('FloatingTranslateApp', () => {
  afterEach(() => {
    window.quickTranslate = undefined;
    localStorage.clear();
  });

  it('uses the stored desktop target language when translating captured text', async () => {
    let capturedCallback: ((payload: { text: string; targetLanguage?: string; translationFormat?: 'java-camel-case' }) => void) | undefined;
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'en-US',
        defaultTranslationFormat: 'java-camel-case'
      }),
      onFloatingSourceCaptured: vi.fn((callback) => {
        capturedCallback = callback as (payload: { text: string; targetLanguage?: string; translationFormat?: 'java-camel-case' }) => void;
        return vi.fn();
      }),
      onSelectionCaptured: vi.fn(),
      setDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'ja-JP',
        defaultTranslationFormat: 'java-camel-case'
      }),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: '你好',
        translatedText: 'Hello',
        targetLanguage: 'en-US'
      }),
      windowControl: vi.fn().mockResolvedValue(false)
    } as any;

    render(<FloatingTranslateApp />);

    expect(await screen.findByDisplayValue('英语')).toBeInTheDocument();

    act(() => {
      capturedCallback?.({ text: '你好', targetLanguage: 'en-US' });
    });

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: '你好',
        targetLanguage: 'en-US',
        translationFormat: 'java-camel-case'
      });
    });
    expect(await screen.findByText('Hello')).toBeInTheDocument();
  });

  it('renders streaming delta text before the final floating translation resolves', async () => {
    let capturedCallback: ((payload: { text: string; targetLanguage?: string; translationFormat?: 'plain' }) => void) | undefined;
    let resolveTranslation: ((value: {
      provider: 'openai-compatible';
      sourceText: string;
      translatedText: string;
      targetLanguage: string;
    }) => void) | undefined;
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn((callback) => {
        capturedCallback = callback as (payload: { text: string; targetLanguage?: string; translationFormat?: 'plain' }) => void;
        return vi.fn();
      }),
      onSelectionCaptured: vi.fn(),
      translateTextStream: vi.fn((_input, onEvent) => {
        onEvent({ type: 'delta', chunkIndex: 1, chunkCount: 1, text: '你', translatedText: '你' });
        onEvent({ type: 'delta', chunkIndex: 1, chunkCount: 1, text: '好', translatedText: '你好' });
        return new Promise((resolve) => {
          resolveTranslation = resolve as typeof resolveTranslation;
        });
      }),
      translateText: vi.fn(),
      windowControl: vi.fn().mockResolvedValue(false)
    } as any;

    render(<FloatingTranslateApp />);

    act(() => {
      capturedCallback?.({ text: 'hello', targetLanguage: 'zh-CN' });
    });

    expect(await screen.findByText('你好')).toBeInTheDocument();
    expect(screen.getByText('正在输出译文...')).toBeInTheDocument();

    await act(async () => {
      resolveTranslation?.({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('翻译中...')).not.toBeInTheDocument();
    });
    expect(window.quickTranslate?.translateText).not.toHaveBeenCalled();
  });

  it('lets the floating window choose target language without changing the default preference and toggle pin state', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'en-US',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn(() => vi.fn()),
      onSelectionCaptured: vi.fn(),
      setDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'ja-JP',
        defaultTranslationFormat: 'plain'
      }),
      setFloatingSessionPreferences: vi.fn(),
      translateText: vi.fn(),
      windowControl: vi.fn().mockResolvedValueOnce(true)
    } as any;

    render(<FloatingTranslateApp />);

    fireEvent.change(await screen.findByLabelText('悬浮目标语言'), {
      target: { value: 'ja-JP' }
    });

    expect(await screen.findByDisplayValue('日语')).toBeInTheDocument();
    expect(window.quickTranslate?.setDesktopSettings).not.toHaveBeenCalled();
    expect(window.quickTranslate?.setFloatingSessionPreferences).toHaveBeenCalledWith({
      targetLanguage: 'ja-JP',
      translationFormat: 'plain'
    });

    const pinButton = screen.getByRole('button', { name: '置顶悬浮窗' });
    expect(pinButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(pinButton);

    await waitFor(() => {
      expect(window.quickTranslate?.windowControl).toHaveBeenCalledWith('toggle-floating-always-on-top');
    });
    expect(screen.getByRole('button', { name: '取消悬浮窗置顶' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the current floating language when shortcut payload has no language override', async () => {
    let capturedCallback: ((payload: { text: string; targetLanguage?: string; translationFormat?: 'plain' }) => void) | undefined;
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn((callback) => {
        capturedCallback = callback as (payload: { text: string; targetLanguage?: string; translationFormat?: 'plain' }) => void;
        return vi.fn();
      }),
      onSelectionCaptured: vi.fn(),
      setFloatingSessionPreferences: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: 'こんにちは',
        targetLanguage: 'ja-JP'
      }),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    fireEvent.change(await screen.findByLabelText('悬浮目标语言'), {
      target: { value: 'ja-JP' }
    });

    act(() => {
      capturedCallback?.({ text: 'hello' });
    });

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'hello',
        targetLanguage: 'ja-JP',
        translationFormat: 'plain'
      });
    });
  });

  it('minimizes the floating window from the title bar', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn(() => vi.fn()),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn(),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    fireEvent.click(await screen.findByRole('button', { name: '最小化悬浮窗' }));

    expect(window.quickTranslate?.windowControl).toHaveBeenCalledWith('minimize-floating-window');
  });

  it('lets the floating window choose a translation format for English translations', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'en-US',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn(() => vi.fn()),
      onSelectionCaptured: vi.fn(),
      setFloatingSessionPreferences: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'user name',
        translatedText: 'userName',
        targetLanguage: 'en-US'
      }),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    expect(await screen.findByDisplayValue('英语')).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('悬浮翻译格式'), {
      target: { value: 'java-camel-case' }
    });
    fireEvent.change(screen.getByLabelText('悬浮原文'), {
      target: { value: 'user name' }
    });
    fireEvent.click(screen.getByRole('button', { name: '翻译' }));

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'user name',
        targetLanguage: 'en-US',
        translationFormat: 'java-camel-case'
      });
    });
    expect(window.quickTranslate?.setFloatingSessionPreferences).toHaveBeenCalledWith({
      targetLanguage: 'en-US',
      translationFormat: 'java-camel-case'
    });
    expect(localStorage.getItem(DEFAULT_TRANSLATION_FORMAT_STORAGE_KEY)).toBe('java-camel-case');
  });

  it('disables floating translation format selection outside English targets', async () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'java-camel-case'
      }),
      onFloatingSourceCaptured: vi.fn(() => vi.fn()),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn().mockResolvedValue({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      }),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    const formatSelect = await screen.findByLabelText('悬浮翻译格式');
    expect(formatSelect).toBeDisabled();

    fireEvent.change(screen.getByLabelText('悬浮原文'), {
      target: { value: 'hello' }
    });
    fireEvent.click(screen.getByRole('button', { name: '翻译' }));

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalledWith({
        text: 'hello',
        targetLanguage: 'zh-CN',
        translationFormat: 'plain'
      });
    });
  });

  it('limits floating translation input to 30000 characters', () => {
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      onFloatingSourceCaptured: vi.fn(() => vi.fn()),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn(),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    const sourceInput = screen.getByLabelText('悬浮原文') as HTMLTextAreaElement;
    fireEvent.change(sourceInput, {
      target: { value: 'a'.repeat(30005) }
    });

    expect(sourceInput.value).toHaveLength(30000);
    expect(screen.getByText('30000/30000')).toBeInTheDocument();
  });

  it('clears the floating translation result and ignores stale requests when source text is emptied', async () => {
    let resolveTranslation: (value: {
      provider: 'openai-compatible';
      sourceText: string;
      translatedText: string;
      targetLanguage: string;
    }) => void = () => {};
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn(() => vi.fn()),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveTranslation = resolve;
          })
      ),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    fireEvent.change(screen.getByLabelText('悬浮原文'), {
      target: { value: 'hello' }
    });
    fireEvent.click(screen.getByRole('button', { name: '翻译' }));

    await waitFor(() => {
      expect(window.quickTranslate?.translateText).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByLabelText('悬浮原文'), {
      target: { value: '' }
    });

    await waitFor(() => {
      expect(screen.getByText('翻译结果会显示在这里')).toBeInTheDocument();
    });

    await act(async () => {
      resolveTranslation({
        provider: 'openai-compatible',
        sourceText: 'hello',
        translatedText: '你好',
        targetLanguage: 'zh-CN'
      });
    });

    expect(screen.queryByText('你好')).not.toBeInTheDocument();
    expect(screen.getByText('翻译结果会显示在这里')).toBeInTheDocument();
  });

  it('clears the previous floating result while a new shortcut translation is loading', async () => {
    let capturedCallback: ((payload: { text: string; targetLanguage?: string }) => void) | undefined;
    let resolveSecondTranslation: (value: {
      provider: 'openai-compatible';
      sourceText: string;
      translatedText: string;
      targetLanguage: string;
    }) => void = () => {};
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn((callback) => {
        capturedCallback = callback as (payload: { text: string; targetLanguage?: string }) => void;
        return vi.fn();
      }),
      onSelectionCaptured: vi.fn(),
      translateText: vi
        .fn()
        .mockResolvedValueOnce({
          provider: 'openai-compatible',
          sourceText: 'render',
          translatedText: '渲染',
          targetLanguage: 'zh-CN'
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecondTranslation = resolve;
            })
        ),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    act(() => {
      capturedCallback?.({ text: 'render', targetLanguage: 'zh-CN' });
    });

    expect(await screen.findByText('渲染')).toBeInTheDocument();

    act(() => {
      capturedCallback?.({ text: 'renders', targetLanguage: 'zh-CN' });
    });

    expect(screen.queryByText('渲染')).not.toBeInTheDocument();
    expect(screen.getByText('翻译中...')).toBeInTheDocument();

    await act(async () => {
      resolveSecondTranslation({
        provider: 'openai-compatible',
        sourceText: 'renders',
        translatedText: '渲染列表',
        targetLanguage: 'zh-CN'
      });
    });

    expect(await screen.findByText('渲染列表')).toBeInTheDocument();
  });

  it('shows selection capture progress before the copied text is available', async () => {
    let capturedCallback:
      | ((payload: { text: string; targetLanguage?: string; captureState?: 'capturing' | 'failed'; captureError?: string }) => void)
      | undefined;
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn((callback) => {
        capturedCallback = callback as (payload: {
          text: string;
          targetLanguage?: string;
          captureState?: 'capturing' | 'failed';
          captureError?: string;
        }) => void;
        return vi.fn();
      }),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn(),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    act(() => {
      capturedCallback?.({ text: '', targetLanguage: 'zh-CN', captureState: 'capturing' });
    });

    expect(await screen.findByText('正在识别选中文本...')).toBeInTheDocument();
    expect(window.quickTranslate?.translateText).not.toHaveBeenCalled();
  });

  it('shows a clear message when shortcut capture returns no selected text', async () => {
    let capturedCallback:
      | ((payload: { text: string; targetLanguage?: string; captureState?: 'capturing' | 'failed'; captureError?: string }) => void)
      | undefined;
    window.quickTranslate = {
      captureSelectedText: vi.fn(),
      copyText: vi.fn(),
      getDesktopSettings: vi.fn().mockResolvedValue({
        mouseButton4Enabled: true,
        launchAtLogin: false,
        hideToTrayOnClose: true,
        defaultTargetLanguage: 'zh-CN',
        defaultTranslationFormat: 'plain'
      }),
      onFloatingSourceCaptured: vi.fn((callback) => {
        capturedCallback = callback as (payload: {
          text: string;
          targetLanguage?: string;
          captureState?: 'capturing' | 'failed';
          captureError?: string;
        }) => void;
        return vi.fn();
      }),
      onSelectionCaptured: vi.fn(),
      translateText: vi.fn(),
      windowControl: vi.fn()
    } as any;

    render(<FloatingTranslateApp />);

    act(() => {
      capturedCallback?.({ text: '', targetLanguage: 'zh-CN', captureState: 'failed' });
    });

    expect(await screen.findByText('未识别到选中文本，请确认文本已选中')).toBeInTheDocument();
    expect(window.quickTranslate?.translateText).not.toHaveBeenCalled();
  });
});
