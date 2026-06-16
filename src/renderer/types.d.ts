/// <reference types="vite/client" />

import type { DesktopSettings } from '../desktop/desktopSettings';
import type { WindowsUpdateTransactionSnapshot } from '../desktop/autoUpdate';
import type { TranslateTextResult } from '../shared/translator';
import type { TranslationFormat } from '../shared/translationFormats';

export {};

type DesktopUpdateCheckResult = {
  status: 'checking' | 'no-update' | 'update-available' | 'downloaded' | 'error';
  currentVersion: string;
  availableVersion?: string;
  message: string;
};

type DesktopUpdateProgress = {
  status: 'checking' | 'downloading' | 'downloaded' | 'error';
  percent: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message?: string;
};

type QuickTranslateStreamEvent =
  | {
      type: 'start';
      totalChunks: number;
      sourceLength: number;
      mode: string;
    }
  | {
      type: 'delta';
      chunkIndex?: number;
      chunkCount?: number;
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
    };

declare global {
  interface Window {
    __quickTranslateStartupCacheReset?: Promise<void>;
    __quickTranslateDevCacheReset?: Promise<void>;
    quickTranslate?: {
      captureSelectedText(): Promise<string>;
      checkForUpdates?(): Promise<DesktopUpdateCheckResult>;
      chooseUpdatePackageDirectory?(): Promise<DesktopSettings | null>;
      clearUpdatePackages?(): Promise<{ directory: string; deletedCount: number }>;
      copyText(text: string): Promise<void>;
      getDesktopSettings?(): Promise<DesktopSettings>;
      getLatestUpdateTransaction?(): Promise<WindowsUpdateTransactionSnapshot | null>;
      openUpdatePackageDirectory?(): Promise<boolean>;
      openUpdateTransactionLogDirectory?(input?: { transactionId?: string }): Promise<boolean>;
      onDesktopSettingsChanged?(callback: (settings: DesktopSettings) => void): () => void;
      onUpdateProgress?(callback: (progress: DesktopUpdateProgress) => void): () => void;
      onFloatingSourceCaptured?(
        callback: (payload: {
          text: string;
          targetLanguage?: string;
          translationFormat?: TranslationFormat;
          captureState?: 'capturing' | 'failed';
          captureError?: string;
        }) => void
      ): () => void;
      onSelectionCaptured(callback: (text: string) => void): () => void;
      setDesktopSettings?(settings: Partial<DesktopSettings>): Promise<DesktopSettings>;
      setFloatingSessionPreferences?(preferences: { targetLanguage?: string; translationFormat?: TranslationFormat }): Promise<{
        targetLanguage: string;
        translationFormat: TranslationFormat;
      }>;
      retryUpdateTransaction?(input?: { transactionId?: string }): Promise<boolean>;
      saveFloatingWindowPosition?(): Promise<DesktopSettings | null>;
      translateText?(input: { text: string; targetLanguage: string; translationFormat?: TranslationFormat }): Promise<TranslateTextResult>;
      translateTextStream?(
        input: { text: string; targetLanguage: string; translationFormat?: TranslationFormat },
        callback: (event: QuickTranslateStreamEvent) => void
      ): Promise<TranslateTextResult>;
      windowControl?(
        command:
          | 'minimize'
          | 'toggle-maximize'
          | 'close'
          | 'quit-app'
          | 'hide-main-window'
          | 'toggle-always-on-top'
          | 'toggle-floating-always-on-top'
          | 'minimize-floating-window'
          | 'resize-floating-window-compact'
          | 'resize-floating-window-standard'
          | 'resize-floating-window-large'
          | 'show-main-window'
          | 'hide-floating-window'
      ): Promise<boolean | void>;
    };
  }
}
