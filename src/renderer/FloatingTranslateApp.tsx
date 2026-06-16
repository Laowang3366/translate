import { ChevronDown, Code2, Copy, ExternalLink, Maximize2, Minus, Pin, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DesktopSettings } from '../desktop/desktopSettings';
import { getLanguageBadge, languageOptions, normalizeTargetLanguage } from '../shared/languages';
import { canUseTranslationFormat, resolveTranslationFormat } from '../shared/translationFormatRules';
import { limitTranslationText, maxTranslationTextLength } from '../shared/textLimits';
import {
  getTranslationFormatLabel,
  normalizeTranslationFormat,
  translationFormatOptions,
  type TranslationFormat
} from '../shared/translationFormats';
import { translateText, translateTextStream, type TranslateTextResult } from '../shared/translator';
import { loadDefaultTargetLanguage, saveDefaultTargetLanguage } from './languagePreference';
import { createProviderFromSettings } from './providerConfig';
import { loadProviderSettings } from './providerSettingsStorage';
import { loadDefaultTranslationFormat, saveDefaultTranslationFormat } from './translationFormatPreference';
import './styles.css';

type FloatingStatus = 'idle' | 'loading' | 'success' | 'error';
type FloatingSize = 'compact' | 'standard' | 'large';
type FloatingNotice = {
  message: string;
  tone: 'success' | 'error';
};
type FloatingPayload = {
  text: string;
  targetLanguage?: string;
  translationFormat?: TranslationFormat;
  captureState?: 'capturing' | 'failed';
  captureError?: string;
};
type FloatingStreamEvent = {
  type: 'delta' | 'chunk';
  chunkIndex?: number;
  chunkCount?: number;
  translatedText: string;
};

export function FloatingTranslateApp() {
  const [sourceText, setSourceText] = useState('');
  const [targetLanguage, setTargetLanguage] = useState(loadDefaultTargetLanguage);
  const [translationFormat, setTranslationFormat] = useState<TranslationFormat>(loadDefaultTranslationFormat);
  const [status, setStatus] = useState<FloatingStatus>('idle');
  const [error, setError] = useState('');
  const [loadingMessage, setLoadingMessage] = useState('翻译中...');
  const [result, setResult] = useState<TranslateTextResult | null>(null);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [floatingSize, setFloatingSize] = useState<FloatingSize>('standard');
  const [notice, setNotice] = useState<FloatingNotice | null>(null);
  const [providerSettings] = useState(loadProviderSettings);
  const targetLanguageRef = useRef(targetLanguage);
  const translationFormatRef = useRef(translationFormat);
  const translationRequestId = useRef(0);

  useEffect(() => {
    targetLanguageRef.current = targetLanguage;
  }, [targetLanguage]);

  useEffect(() => {
    translationFormatRef.current = translationFormat;
  }, [translationFormat]);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let isMounted = true;

    void window.quickTranslate?.getDesktopSettings?.().then((settings: DesktopSettings) => {
      if (!isMounted) {
        return;
      }

      const normalizedLanguage = saveDefaultTargetLanguage(settings.defaultTargetLanguage);
      const normalizedFormat = saveDefaultTranslationFormat(settings.defaultTranslationFormat);
      setTargetLanguage(normalizedLanguage);
      setTranslationFormat(normalizedFormat);
      targetLanguageRef.current = normalizedLanguage;
      translationFormatRef.current = normalizedFormat;
    });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    return window.quickTranslate?.onFloatingSourceCaptured?.((payload) => {
      const nextLanguage = normalizeTargetLanguage(payload.targetLanguage ?? targetLanguageRef.current);
      const nextFormat = normalizeTranslationFormat(payload.translationFormat ?? translationFormatRef.current);
      setTargetLanguage(nextLanguage);
      setTranslationFormat(nextFormat);
      targetLanguageRef.current = nextLanguage;
      translationFormatRef.current = nextFormat;
      const limitedText = limitTranslationText(payload.text);
      setSourceText(limitedText);

      if (payload.captureState === 'capturing') {
        translationRequestId.current += 1;
        setResult(null);
        setError('');
        setLoadingMessage('正在识别选中文本...');
        setStatus('loading');
        return;
      }

      if (!limitedText.trim() && payload.captureState === 'failed') {
        translationRequestId.current += 1;
        setResult(null);
        setLoadingMessage('翻译中...');
        setStatus('error');
        setError(payload.captureError || '未识别到选中文本，请确认文本已选中');
        return;
      }

      void runTranslation(limitedText, nextLanguage, nextFormat);
    });
  }, [providerSettings]);

  async function runTranslation(text = sourceText, language = targetLanguageRef.current, format = translationFormatRef.current) {
    const normalizedText = limitTranslationText(text).trim();
    const effectiveFormat = resolveTranslationFormat(language, format);

    if (!normalizedText) {
      clearCurrentTranslation();
      return;
    }

    const requestId = translationRequestId.current + 1;
    translationRequestId.current = requestId;
    setResult(null);
    setStatus('loading');
    setLoadingMessage('翻译中...');
    setError('');

    try {
      const streamedChunks = new Map<number, string>();
      const handleStreamEvent = (event: FloatingStreamEvent) => {
        if (requestId !== translationRequestId.current) {
          return;
        }
        if (event.type !== 'delta' && event.type !== 'chunk') {
          return;
        }

        const chunkIndex = event.chunkIndex ?? 1;
        const chunkCount = event.chunkCount ?? 1;
        streamedChunks.set(chunkIndex, event.translatedText);
        const translatedText = Array.from({ length: chunkCount }, (_item, index) => streamedChunks.get(index + 1) || '')
          .filter(Boolean)
          .join('\n\n');
        setResult({
          provider: 'openai-compatible',
          sourceText: normalizedText,
          translatedText,
          targetLanguage: language
        });
        setLoadingMessage(chunkCount > 1 ? `正在输出第 ${chunkIndex}/${chunkCount} 段` : '正在输出译文...');
      };

      const translation = window.quickTranslate?.translateTextStream
        ? await window.quickTranslate.translateTextStream(
            { text: normalizedText, targetLanguage: language, translationFormat: effectiveFormat },
            (event) => {
              if (event.type === 'delta' || event.type === 'chunk') {
                handleStreamEvent(event);
              }
            }
          )
        : window.quickTranslate?.translateText
          ? await window.quickTranslate.translateText({ text: normalizedText, targetLanguage: language, translationFormat: effectiveFormat })
          : await translateTextStream(
              {
                text: normalizedText,
                targetLanguage: language,
                translationFormat: effectiveFormat,
                provider: createProviderFromSettings(providerSettings)
              },
              (event) => handleStreamEvent({ type: event.type, translatedText: event.translatedText })
            );

      if (requestId !== translationRequestId.current) {
        return;
      }

      setResult(translation);
      setStatus('success');
    } catch (translationError) {
      if (requestId !== translationRequestId.current) {
        return;
      }

      setResult(null);
      setStatus('error');
      setError(translationError instanceof Error ? translationError.message : '翻译失败');
    }
  }

  function clearCurrentTranslation() {
    translationRequestId.current += 1;
    setResult(null);
    setStatus('idle');
    setLoadingMessage('翻译中...');
    setError('');
  }

  function changeSourceText(value: string) {
    const limitedText = limitTranslationText(value);
    setSourceText(limitedText);

    if (!limitedText.trim()) {
      clearCurrentTranslation();
    }
  }

  async function changeTargetLanguage(language: string) {
    const normalizedLanguage = normalizeTargetLanguage(language);
    const nextFormat = resolveTranslationFormat(normalizedLanguage, translationFormatRef.current);
    setTargetLanguage(normalizedLanguage);
    targetLanguageRef.current = normalizedLanguage;
    void window.quickTranslate?.setFloatingSessionPreferences?.({
      targetLanguage: normalizedLanguage,
      translationFormat: nextFormat
    });

    if (sourceText.trim()) {
      await runTranslation(sourceText, normalizedLanguage, nextFormat);
    }
  }

  async function changeTranslationFormat(format: string) {
    if (!canUseTranslationFormat(targetLanguageRef.current)) {
      return;
    }

    const normalizedFormat = saveDefaultTranslationFormat(format);
    setTranslationFormat(normalizedFormat);
    translationFormatRef.current = normalizedFormat;
    void window.quickTranslate?.setFloatingSessionPreferences?.({
      targetLanguage: targetLanguageRef.current,
      translationFormat: normalizedFormat
    });

    if (sourceText.trim()) {
      await runTranslation(sourceText, targetLanguageRef.current, normalizedFormat);
    }
  }

  async function toggleAlwaysOnTop() {
    const nextState = await window.quickTranslate?.windowControl?.('toggle-floating-always-on-top');
    if (typeof nextState === 'boolean') {
      setIsAlwaysOnTop(nextState);
      return;
    }

    setIsAlwaysOnTop((currentState) => !currentState);
  }

  async function copyResult() {
    if (!result?.translatedText) {
      return;
    }

    try {
      if (window.quickTranslate?.copyText) {
        await window.quickTranslate.copyText(result.translatedText);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.translatedText);
      } else {
        throw new Error('Clipboard API is unavailable');
      }
      setNotice({ tone: 'success', message: '已复制译文' });
    } catch {
      setNotice({ tone: 'error', message: '复制失败' });
    }
  }

  async function cycleFloatingSize() {
    const nextSize: FloatingSize = floatingSize === 'compact' ? 'standard' : floatingSize === 'standard' ? 'large' : 'compact';
    setFloatingSize(nextSize);
    await window.quickTranslate?.windowControl?.(`resize-floating-window-${nextSize}`);
  }

  const canSelectTranslationFormat = canUseTranslationFormat(targetLanguage);
  const activeTranslationFormat = resolveTranslationFormat(targetLanguage, translationFormat);
  const selectedTranslationFormat = getTranslationFormatLabel(activeTranslationFormat);

  return (
    <main className="floating-shell">
      <section className="floating-card" aria-label="悬浮翻译">
        <header className="floating-titlebar">
          <strong>自动检测</strong>
          <span>→</span>
          <label className="floating-language-select" aria-label="悬浮目标语言选择">
            <span aria-hidden="true">{getLanguageBadge(targetLanguage)}</span>
            <select value={targetLanguage} aria-label="悬浮目标语言" onChange={(event) => void changeTargetLanguage(event.target.value)}>
              {languageOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <div className="floating-window-actions">
            <button type="button" aria-label="调整悬浮窗大小" onClick={cycleFloatingSize}>
              <Maximize2 size={16} />
            </button>
            <button
              className={isAlwaysOnTop ? 'active' : ''}
              type="button"
              aria-label={isAlwaysOnTop ? '取消悬浮窗置顶' : '置顶悬浮窗'}
              aria-pressed={isAlwaysOnTop}
              onClick={toggleAlwaysOnTop}
            >
              <Pin size={16} />
            </button>
            <button type="button" aria-label="最小化悬浮窗" onClick={() => window.quickTranslate?.windowControl?.('minimize-floating-window')}>
              <Minus size={17} />
            </button>
            <button type="button" aria-label="打开主窗口" onClick={() => window.quickTranslate?.windowControl?.('show-main-window')}>
              <ExternalLink size={17} />
            </button>
            <button type="button" aria-label="关闭悬浮窗" onClick={() => window.quickTranslate?.windowControl?.('hide-floating-window')}>
              <X size={18} />
            </button>
          </div>
        </header>

        <section className="floating-source-card" aria-label="悬浮原文区域">
          <textarea
            value={sourceText}
            aria-label="悬浮原文"
            placeholder="输入或粘贴需要翻译的文本"
            maxLength={maxTranslationTextLength}
            onChange={(event) => changeSourceText(event.target.value)}
          />
          <div className="floating-card-footer">
            <span>{sourceText.length}/{maxTranslationTextLength}</span>
            <label className={`floating-format-select${canSelectTranslationFormat ? '' : ' disabled'}`} aria-disabled={!canSelectTranslationFormat}>
              <Code2 size={16} aria-hidden="true" />
              <strong>{selectedTranslationFormat}</strong>
              <select
                value={activeTranslationFormat}
                aria-label="悬浮翻译格式"
                disabled={!canSelectTranslationFormat}
                onChange={(event) => void changeTranslationFormat(event.target.value)}
              >
                {translationFormatOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} aria-hidden="true" />
            </label>
            <button type="button" onClick={() => runTranslation()} disabled={!sourceText.trim() || status === 'loading'}>
              {status === 'loading' ? '翻译中' : '翻译'}
            </button>
          </div>
        </section>

        <section className="floating-result-card" aria-live="polite" aria-label="悬浮译文">
          {status === 'error' ? <p className="error-message">{error}</p> : null}
          {status === 'loading' ? <p className="empty-state loading-state">{loadingMessage}</p> : null}
          {result ? <p className="translated-text">{result.translatedText}</p> : null}
          {!result && status !== 'error' && status !== 'loading' ? <p className="empty-state">翻译结果会显示在这里</p> : null}
          <button type="button" aria-label="复制悬浮译文" disabled={!result?.translatedText} onClick={copyResult}>
            <Copy size={19} />
          </button>
        </section>
        {notice ? (
          <div className={`floating-toast ${notice.tone}`} role={notice.tone === 'success' ? 'status' : 'alert'}>
            {notice.message}
          </div>
        ) : null}
      </section>
    </main>
  );
}
