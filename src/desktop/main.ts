import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  type OpenDialogOptions
} from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  checkForUpdates,
  getLatestUpdateTransaction,
  markLatestInstallerStartedTransactionDone,
  openUpdateTransactionLogDirectory,
  retryUpdateTransaction,
  startAutoUpdates
} from './autoUpdate.js';
import { resolveDesktopBackendBaseUrl, translateWithBackend } from './backendTranslationClient.js';
import { captureSelectedText, restoreClipboardIfNeeded, type ClipboardRecoveryStore } from './captureSelection.js';
import {
  defaultDesktopSettings,
  floatingTranslateShortcutOptions,
  getFloatingTranslateShortcutAccelerator,
  getFloatingTranslateShortcutLabel,
  mergeDesktopSettings,
  normalizeFloatingTranslateShortcut,
  parseDesktopSettings,
  serializeDesktopSettings,
  type DesktopSettings,
  type FloatingWindowPosition,
  type FloatingTranslateShortcut
} from './desktopSettings.js';
import { reuseFloatingWindowForShortcut } from './floatingWindowLifecycle.js';
import { createFloatingWindowBounds, type Point } from './floatingWindowBounds.js';
import { bringFloatingWindowToFront, showFloatingWindowWithoutFocus } from './floatingWindowFocus.js';
import {
  readFloatingSessionPreferences,
  readFloatingSessionPreferenceOverrides,
  updateFloatingSessionPreferences,
  type FloatingSessionPreferenceState
} from './floatingSessionPreferences.js';
import { createFloatingShortcutRunner, type FloatingShortcutContext, type FloatingShortcutResultOptions } from './floatingShortcutHandler.js';
import { startMouseButton4Shortcut, type MouseButton4Shortcut } from './mouseButton4Shortcut.js';
import { applyLightweightRuntime } from './runtimeOptimization.js';
import {
  clearUpdatePackageArtifacts,
  getDefaultUpdatePackageDirectory,
  normalizeUpdatePackageDirectoryPath
} from './updatePackageDirectory.js';
import { createFloatingWindowOptions, createMainWindowOptions } from './windowOptions.js';
import { createWindowsCopyShortcutSender } from './windowsCopyShortcut.js';
import { normalizeTranslationFormat, type TranslationFormat } from '../shared/translationFormats.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isSmokeTest = process.argv.includes('--smoke-test');

applyLightweightRuntime(app);

const hasSingleInstanceLock = isSmokeTest || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

if (isSmokeTest) {
  const smokeUserDataPath = path.join(tmpdir(), 'quick-translate-electron-smoke');
  rmSync(smokeUserDataPath, { recursive: true, force: true });
  mkdirSync(smokeUserDataPath, { recursive: true });
  app.setPath('userData', smokeUserDataPath);
}

let mainWindow: BrowserWindow | null = null;
let floatingWindow: BrowserWindow | null = null;
let mouseButton4Shortcut: MouseButton4Shortcut | null = null;
let keyboardFloatingShortcutAccelerator: string | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let desktopSettings: DesktopSettings = defaultDesktopSettings;
let floatingSessionPreferences: FloatingSessionPreferenceState = {};
let clipboardRecoveryStore: ClipboardRecoveryStore | null = null;
let floatingWindowRenderToken = 0;
let floatingWindowFirstPosition: FloatingWindowPosition | null = null;
const windowsCopyShortcutSender = createWindowsCopyShortcutSender({ logger: console, requestTimeoutMs: 900 });
const floatingWindowSizes = {
  compact: { width: 360, height: 300 },
  standard: { width: 420, height: 360 },
  large: { width: 560, height: 460 }
};

async function createWindow() {
  mainWindow = new BrowserWindow(
    createMainWindowOptions({
      iconPath: resolveAssetPath('desktop-icon.ico'),
      preloadPath: path.join(__dirname, 'preload.cjs')
    })
  );
  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (event) => {
    if (mainWindow?.isFocused() && desktopSettings.hideToTrayOnClose && !isQuitting && !isSmokeTest) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.webContents.once('did-finish-load', async () => {
    if (!isSmokeTest) {
      return;
    }

    const smokeResult = await mainWindow?.webContents
      .executeJavaScript(
        `new Promise((resolve) => {
          const startedAt = Date.now();
          const readText = () => document.body.textContent || '';
          const check = () => {
            const text = readText();
            const pinButton = document.querySelector('[aria-label="置顶窗口"]');
            if (pinButton || Date.now() - startedAt > 10000) {
              resolve({
                bodyText: text,
                hasQuickTranslate: Boolean(window.quickTranslate),
                hasTranslateText: typeof window.quickTranslate?.translateText === 'function',
                hasGetDesktopSettings: typeof window.quickTranslate?.getDesktopSettings === 'function',
                hasCheckForUpdates: typeof window.quickTranslate?.checkForUpdates === 'function',
                hasWindowControl: typeof window.quickTranslate?.windowControl === 'function',
                hasFloatingSessionPreferences: typeof window.quickTranslate?.setFloatingSessionPreferences === 'function',
                hasPinButton: Boolean(pinButton),
                pinPressed: pinButton?.getAttribute('aria-pressed')
              });
              return;
            }
            setTimeout(check, 100);
          };
          check();
        })`
      )
      .catch(() => undefined);
    const smokePassed =
      isRecord(smokeResult) &&
      typeof smokeResult.bodyText === 'string' &&
      smokeResult.bodyText.includes('快捷翻译') &&
      smokeResult.hasQuickTranslate === true &&
      smokeResult.hasTranslateText === true &&
      smokeResult.hasGetDesktopSettings === true &&
      smokeResult.hasCheckForUpdates === true &&
      smokeResult.hasWindowControl === true &&
      smokeResult.hasFloatingSessionPreferences === true &&
      smokeResult.hasPinButton === true &&
      smokeResult.pinPressed === 'false' &&
      mainWindow?.isAlwaysOnTop() === false &&
      mainWindow?.isMenuBarVisible() === false;

    if (!smokePassed) {
      console.error(`[桌面冒烟] preload 桥未就绪：${JSON.stringify(smokeResult)}`);
    }

    const floatingSmokePassed = smokePassed ? await runFloatingSmokeCheck() : false;

    app.exit(smokePassed && floatingSmokePassed ? 0 : 1);
  });

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) {
      mainWindow?.show();
    }
  });

  await loadRendererWindow(mainWindow);
}

async function runFloatingSmokeCheck() {
  const window = await createFloatingWindow();
  const smokeResult = await window.webContents
    .executeJavaScript(
      `new Promise((resolve) => {
        const startedAt = Date.now();
        const readAppRegion = (selector) => {
          const node = document.querySelector(selector);
          if (!node) {
            return '';
          }
          const style = getComputedStyle(node);
          return style.getPropertyValue('-webkit-app-region') || style.webkitAppRegion || '';
        };
        const check = async () => {
          const text = document.body.textContent || '';
          if (text.includes('自动检测') || Date.now() - startedAt > 10000) {
            const formatSelect = document.querySelector('[aria-label="悬浮翻译格式"]');
            const shellStyle = getComputedStyle(document.querySelector('.floating-shell'));
            const cardStyle = getComputedStyle(document.querySelector('.floating-card'));
            const sessionPreferenceResult = await window.quickTranslate?.setFloatingSessionPreferences?.({
              targetLanguage: 'en-US',
              translationFormat: 'java-camel-case'
            });
            resolve({
              bodyText: text,
              hasQuickTranslate: Boolean(window.quickTranslate),
              hasFloatingHandler: typeof window.quickTranslate?.onFloatingSourceCaptured === 'function',
              hasTargetLanguage: text.includes('简体中文'),
              hasMinimizeButton: Boolean(document.querySelector('[aria-label="最小化悬浮窗"]')),
              hasFormatSelect: Boolean(formatSelect),
              formatDisabledForChinese: formatSelect?.disabled === true,
              floatingCardDragRegion: readAppRegion('.floating-card'),
              floatingSourceNoDragRegion: readAppRegion('.floating-source-card'),
              floatingActionsNoDragRegion: readAppRegion('.floating-window-actions'),
              floatingShellPadding: shellStyle.padding,
              floatingShellBackground: shellStyle.backgroundColor,
              floatingCardBorderTopWidth: cardStyle.borderTopWidth,
              floatingCardBoxShadow: cardStyle.boxShadow,
              sessionPreferenceResult
            });
            return;
          }
          setTimeout(check, 100);
        };
        check();
      })`
    )
    .catch(() => undefined);
  const smokePassed =
    isRecord(smokeResult) &&
    typeof smokeResult.bodyText === 'string' &&
    smokeResult.bodyText.includes('自动检测') &&
    smokeResult.hasQuickTranslate === true &&
    smokeResult.hasFloatingHandler === true &&
    smokeResult.hasTargetLanguage === true &&
    smokeResult.hasMinimizeButton === true &&
    smokeResult.hasFormatSelect === true &&
    smokeResult.formatDisabledForChinese === true &&
    smokeResult.floatingCardDragRegion === 'drag' &&
    smokeResult.floatingSourceNoDragRegion === 'no-drag' &&
    smokeResult.floatingActionsNoDragRegion === 'no-drag' &&
    smokeResult.floatingShellPadding === '0px' &&
    smokeResult.floatingShellBackground === 'rgb(255, 255, 255)' &&
    smokeResult.floatingCardBorderTopWidth === '0px' &&
    smokeResult.floatingCardBoxShadow === 'none' &&
    window.isAlwaysOnTop() === false &&
    isRecord(smokeResult.sessionPreferenceResult) &&
    smokeResult.sessionPreferenceResult.targetLanguage === 'en-US' &&
    smokeResult.sessionPreferenceResult.translationFormat === 'java-camel-case';

  if (!smokePassed) {
    console.error(`[桌面冒烟] 悬浮窗未就绪：${JSON.stringify(smokeResult)}`);
  }

  return smokePassed;
}

async function loadRendererWindow(window: BrowserWindow, options: { floating?: boolean } = {}) {
  if (app.isPackaged) {
    await window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), options.floating ? { query: { floating: '1' } } : undefined);
    return;
  }

  const rendererUrl = new URL(process.env.QUICK_TRANSLATE_RENDERER_URL || 'http://127.0.0.1:5173/');
  if (options.floating) {
    rendererUrl.searchParams.set('floating', '1');
  }

  await window.loadURL(rendererUrl.toString());
}

async function readSelectedTextFromSystem(options: { showFloatingCaptureProgress?: boolean; cursorPoint?: Point } = {}) {
  return captureSelectedText({
    clipboard,
    sendCopyShortcut: sendWindowsCopyShortcut,
    wait,
    recoveryStore: getClipboardRecoveryStore(),
    copyDelayMs: 420,
    pollIntervalMs: 15,
    copyAttempts: 2,
    retryDelayMs: 70,
    onCopyShortcutSent: options.showFloatingCaptureProgress
      ? async () => {
          await wait(120);
          await showFloatingTranslation('', {
            captureState: 'capturing',
            focus: false,
            cursorPoint: options.cursorPoint,
            keepTopMost: true
          });
        }
      : undefined
  });
}

function getClipboardRecoveryStore(): ClipboardRecoveryStore {
  if (clipboardRecoveryStore) {
    return clipboardRecoveryStore;
  }

  const filePath = path.join(app.getPath('userData'), 'clipboard-capture-recovery.json');
  clipboardRecoveryStore = {
    read() {
      try {
        const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
        if (
          isRecord(value) &&
          typeof value.sentinelText === 'string' &&
          typeof value.clipboardText === 'string' &&
          typeof value.createdAt === 'string'
        ) {
          return {
            sentinelText: value.sentinelText,
            clipboardText: value.clipboardText,
            createdAt: value.createdAt
          };
        }
      } catch {
        return null;
      }
      return null;
    },
    write(record) {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(record), 'utf8');
    },
    remove() {
      rmSync(filePath, { force: true });
    }
  };
  return clipboardRecoveryStore;
}

async function captureFromSelection() {
  const text = await readSelectedTextFromSystem();

  if (!text) {
    mainWindow?.show();
    mainWindow?.focus();
    return '';
  }

  mainWindow?.show();
  mainWindow?.focus();
  mainWindow?.webContents.send('selection-captured', text);
  return text;
}

const handleGlobalFloatingTranslateShortcut = createFloatingShortcutRunner({
  readSelectedText: (context) =>
    readSelectedTextFromSystem({ showFloatingCaptureProgress: true, cursorPoint: context.cursorPoint }),
  showFloatingTranslation: (text, options, context) =>
    showFloatingTranslation(text, {
      ...options,
      cursorPoint: context.cursorPoint,
      keepTopMost: true
    })
});

function createFloatingShortcutContext(): FloatingShortcutContext {
  return {
    cursorPoint: screen.getCursorScreenPoint()
  };
}

async function sendWindowsCopyShortcut(attempt = 0) {
  if (attempt > 0) {
    await sendCopyShortcutWithSendKeys();
    return;
  }

  if (process.platform === 'win32') {
    try {
      await windowsCopyShortcutSender.send();
      return;
    } catch (error) {
      console.warn(`[选区复制] 快捷复制助手失败，改用一次性复制：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await sendCopyShortcutWithSendKeys();
}

async function sendCopyShortcutWithSendKeys() {
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')"
  ]);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getDesktopSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function getCurrentUpdatePackageDirectory(settings: DesktopSettings = desktopSettings) {
  return normalizeUpdatePackageDirectoryPath(settings.updatePackageDirectory, getDefaultUpdatePackageDirectory(app.getPath('downloads')));
}

function loadDesktopSettings(): DesktopSettings {
  const settingsPath = getDesktopSettingsPath();
  const settings = parseDesktopSettings(existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined);
  const hydratedSettings = {
    ...settings,
    updatePackageDirectory: getCurrentUpdatePackageDirectory(settings)
  };
  if (settings.updatePackageDirectory !== hydratedSettings.updatePackageDirectory) {
    saveDesktopSettings(hydratedSettings);
  }

  return hydratedSettings;
}

function saveDesktopSettings(settings: DesktopSettings) {
  writeFileSync(getDesktopSettingsPath(), serializeDesktopSettings(settings), 'utf8');
}

async function translateUsingConfiguredChannel(request: { text: string; targetLanguage: string; translationFormat: TranslationFormat }) {
  return translateWithBackend(request, {
    baseUrl: resolveDesktopBackendBaseUrl(process.env)
  });
}

function setFloatingTranslateShortcut(shortcut: FloatingTranslateShortcut) {
  mouseButton4Shortcut?.stop();
  mouseButton4Shortcut = null;

  if (keyboardFloatingShortcutAccelerator) {
    globalShortcut.unregister(keyboardFloatingShortcutAccelerator);
    keyboardFloatingShortcutAccelerator = null;
  }

  const normalizedShortcut = normalizeFloatingTranslateShortcut(shortcut);
  if (process.platform === 'win32' && normalizedShortcut !== 'disabled') {
    windowsCopyShortcutSender.warmUp();
  }

  if (normalizedShortcut === 'mouse-button-4' || normalizedShortcut === 'mouse-button-5') {
    mouseButton4Shortcut = startMouseButton4Shortcut(() => {
      void handleGlobalFloatingTranslateShortcut(createFloatingShortcutContext());
    }, {
      sideButton: normalizedShortcut
    });
    return;
  }

  const accelerator = getFloatingTranslateShortcutAccelerator(normalizedShortcut);
  if (accelerator) {
    const isRegistered = globalShortcut.register(accelerator, () => {
      void handleGlobalFloatingTranslateShortcut(createFloatingShortcutContext());
    });
    if (isRegistered) {
      keyboardFloatingShortcutAccelerator = accelerator;
    } else {
      console.warn(`[快捷键] 注册失败：${getFloatingTranslateShortcutLabel(normalizedShortcut)}`);
    }
  }
}

async function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    return floatingWindow;
  }

  floatingWindow = new BrowserWindow(createFloatingWindowOptions({ preloadPath: path.join(__dirname, 'preload.cjs') }));
  floatingWindow.setMenu(null);
  floatingWindow.setMenuBarVisibility(false);
  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });
  await loadRendererWindow(floatingWindow, { floating: true });

  return floatingWindow;
}

function getFloatingWindowPositionTarget(cursorPoint: Point) {
  if (desktopSettings.floatingWindowPositionMode === 'custom-position' && desktopSettings.customFloatingWindowPosition) {
    const { workArea } = screen.getDisplayNearestPoint(desktopSettings.customFloatingWindowPosition);
    return {
      workArea,
      boundsOptions: {
        positionMode: 'custom-position' as const,
        customPosition: desktopSettings.customFloatingWindowPosition
      }
    };
  }

  if (desktopSettings.floatingWindowPositionMode === 'first-position' && floatingWindowFirstPosition) {
    const { workArea } = screen.getDisplayNearestPoint(floatingWindowFirstPosition);
    return {
      workArea,
      boundsOptions: {
        positionMode: 'first-position' as const,
        firstPosition: floatingWindowFirstPosition
      }
    };
  }

  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
  return {
    workArea,
    boundsOptions: {
      positionMode: desktopSettings.floatingWindowPositionMode,
      firstPosition: floatingWindowFirstPosition,
      customPosition: desktopSettings.customFloatingWindowPosition
    }
  };
}

async function showFloatingTranslation(
  text: string,
  options: FloatingShortcutResultOptions & { focus?: boolean; cursorPoint?: Point; keepTopMost?: boolean } = {}
) {
  const renderToken = ++floatingWindowRenderToken;
  const canReuseFloatingWindow = Boolean(floatingWindow && !floatingWindow.isDestroyed());
  floatingWindow = reuseFloatingWindowForShortcut(floatingWindow);
  const window = await createFloatingWindow();
  const cursorPoint = options.cursorPoint ?? screen.getCursorScreenPoint();
  const { workArea, boundsOptions } = getFloatingWindowPositionTarget(cursorPoint);
  const bounds = window.getBounds();
  const nextBounds = createFloatingWindowBounds(workArea, cursorPoint, bounds, boundsOptions);

  window.setBounds(nextBounds);
  if (desktopSettings.floatingWindowPositionMode === 'first-position' && !floatingWindowFirstPosition) {
    floatingWindowFirstPosition = { x: nextBounds.x, y: nextBounds.y };
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (options.focus === false) {
    showFloatingWindowWithoutFocus(window, { keepTopMost: options.keepTopMost });
  } else {
    bringFloatingWindowToFront(window, { keepTopMost: options.keepTopMost });
  }
  const dispatchCapturedSource = () => {
    if (renderToken !== floatingWindowRenderToken) {
      return;
    }
    const preferences = readFloatingSessionPreferenceOverrides(floatingSessionPreferences);
    window.webContents.send('floating-source-captured', {
      text,
      captureState: options.captureState,
      captureError: options.captureError,
      ...preferences
    });
  };

  if (canReuseFloatingWindow) {
    dispatchCapturedSource();
    return;
  }

  setTimeout(dispatchCapturedSource, 50);
}

function saveFloatingWindowPosition() {
  if (!floatingWindow || floatingWindow.isDestroyed() || !floatingWindow.isVisible()) {
    return null;
  }

  const bounds = floatingWindow.getBounds();
  return updateDesktopSettings({
    floatingWindowPositionMode: 'custom-position',
    customFloatingWindowPosition: { x: bounds.x, y: bounds.y }
  });
}

function getFloatingSessionPreferences() {
  return readFloatingSessionPreferences(floatingSessionPreferences, {
    targetLanguage: desktopSettings.defaultTargetLanguage,
    translationFormat: desktopSettings.defaultTranslationFormat
  });
}

function updateFloatingSessionPreferenceState(input: unknown) {
  if (!isRecord(input)) {
    return getFloatingSessionPreferences();
  }

  floatingSessionPreferences = updateFloatingSessionPreferences(floatingSessionPreferences, {
    targetLanguage: typeof input.targetLanguage === 'string' ? input.targetLanguage : undefined,
    translationFormat:
      typeof input.translationFormat === 'string' ? normalizeTranslationFormat(input.translationFormat) : undefined
  });

  return getFloatingSessionPreferences();
}

function applyDesktopSettings(settings: DesktopSettings) {
  const previousPositionMode = desktopSettings.floatingWindowPositionMode;
  desktopSettings = settings;
  if (settings.floatingWindowPositionMode !== 'first-position' || settings.floatingWindowPositionMode !== previousPositionMode) {
    floatingWindowFirstPosition = null;
  }
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
  setFloatingTranslateShortcut(settings.floatingTranslateShortcut);
  updateTrayMenu();
  mainWindow?.webContents.send('desktop-settings-changed', settings);
}

function updateDesktopSettings(settingsPatch: Partial<DesktopSettings>) {
  const nextSettings = mergeDesktopSettings(desktopSettings, settingsPatch);
  saveDesktopSettings(nextSettings);
  applyDesktopSettings(nextSettings);
  return nextSettings;
}

async function openUpdatePackageDirectory() {
  const directory = getCurrentUpdatePackageDirectory();
  await mkdir(directory, { recursive: true });
  const errorMessage = await shell.openPath(directory);
  if (errorMessage) {
    throw new Error(errorMessage);
  }

  return true;
}

async function chooseUpdatePackageDirectory() {
  const options: OpenDialogOptions = {
    title: '选择更新包保存路径',
    buttonLabel: '选择目录',
    defaultPath: getCurrentUpdatePackageDirectory(),
    properties: ['openDirectory', 'createDirectory']
  };
  const result =
    mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) {
    return null;
  }

  return updateDesktopSettings({
    updatePackageDirectory: result.filePaths[0]
  });
}

async function clearStoredUpdatePackages() {
  return clearUpdatePackageArtifacts(getCurrentUpdatePackageDirectory());
}

function executeWindowControl(command: unknown) {
  const normalizedCommand = normalizeWindowControlCommand(command);

  switch (normalizedCommand) {
    case 'minimize':
      mainWindow?.minimize();
      break;
    case 'toggle-maximize':
      if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow?.maximize();
      }
      break;
    case 'close':
      mainWindow?.close();
      break;
    case 'quit-app':
      isQuitting = true;
      app.quit();
      break;
    case 'hide-main-window':
      if (desktopSettings.hideToTrayOnClose && !isSmokeTest) {
        mainWindow?.hide();
      } else {
        mainWindow?.close();
      }
      break;
    case 'toggle-always-on-top': {
      if (!mainWindow) {
        return false;
      }

      mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop());
      return mainWindow.isAlwaysOnTop();
    }
    case 'toggle-floating-always-on-top': {
      if (!floatingWindow || floatingWindow.isDestroyed()) {
        return false;
      }

      floatingWindow.setAlwaysOnTop(!floatingWindow.isAlwaysOnTop());
      return floatingWindow.isAlwaysOnTop();
    }
    case 'minimize-floating-window':
      floatingWindow?.minimize();
      break;
    case 'resize-floating-window-compact':
      return resizeFloatingWindow('compact');
    case 'resize-floating-window-standard':
      return resizeFloatingWindow('standard');
    case 'resize-floating-window-large':
      return resizeFloatingWindow('large');
    case 'show-main-window':
      showMainWindow();
      floatingWindow?.hide();
      break;
    case 'hide-floating-window':
      floatingWindow?.hide();
      break;
  }
}

type WindowControlCommand =
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
  | 'hide-floating-window';

function normalizeWindowControlCommand(command: unknown): WindowControlCommand {
  if (
    command === 'minimize' ||
    command === 'toggle-maximize' ||
    command === 'close' ||
    command === 'quit-app' ||
    command === 'hide-main-window' ||
    command === 'toggle-always-on-top' ||
    command === 'toggle-floating-always-on-top' ||
    command === 'minimize-floating-window' ||
    command === 'resize-floating-window-compact' ||
    command === 'resize-floating-window-standard' ||
    command === 'resize-floating-window-large' ||
    command === 'show-main-window' ||
    command === 'hide-floating-window'
  ) {
    return command;
  }

  throw new Error('窗口操作无效');
}

function showMainWindow() {
  if (!mainWindow) {
    void createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function resizeFloatingWindow(size: keyof typeof floatingWindowSizes) {
  if (!floatingWindow || floatingWindow.isDestroyed()) {
    return false;
  }

  const targetSize = floatingWindowSizes[size];
  const currentBounds = floatingWindow.getBounds();
  const { workArea } = screen.getDisplayMatching(currentBounds);
  const maxX = workArea.x + workArea.width - targetSize.width;
  const maxY = workArea.y + workArea.height - targetSize.height;
  floatingWindow.setBounds({
    x: Math.min(Math.max(currentBounds.x, workArea.x), maxX),
    y: Math.min(Math.max(currentBounds.y, workArea.y), maxY),
    ...targetSize
  });
  return targetSize;
}

function createTray() {
  if (tray) {
    return;
  }

  const icon = nativeImage.createFromPath(resolveAssetPath('desktop-icon.ico'));
  tray = new Tray(icon);
  tray.setToolTip('快捷翻译');
  tray.on('click', showMainWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示快捷翻译', click: showMainWindow },
      { type: 'separator' },
      {
        label: `悬浮翻译快捷键：${getFloatingTranslateShortcutLabel(desktopSettings.floatingTranslateShortcut)}`,
        submenu: [
          {
            label: `当前：${getFloatingTranslateShortcutLabel(desktopSettings.floatingTranslateShortcut)}`,
            enabled: false
          },
          { type: 'separator' as const },
          ...floatingTranslateShortcutOptions.map((option) => ({
            label: option.label,
            type: 'radio' as const,
            checked: desktopSettings.floatingTranslateShortcut === option.value,
            click: () => updateDesktopSettings({ floatingTranslateShortcut: option.value })
          }))
        ]
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: desktopSettings.launchAtLogin,
        click: (menuItem) => updateDesktopSettings({ launchAtLogin: menuItem.checked })
      },
      {
        label: '关闭时隐藏到托盘',
        type: 'checkbox',
        checked: desktopSettings.hideToTrayOnClose,
        click: (menuItem) => updateDesktopSettings({ hideToTrayOnClose: menuItem.checked })
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function resolveAssetPath(fileName: string) {
  const appRootPath = app.isPackaged ? app.getAppPath() : process.cwd();
  const candidates = [
    path.join(appRootPath, 'build', 'icons', fileName),
    path.join(appRootPath, 'public', fileName),
    path.join(appRootPath, 'dist', fileName),
    path.join(process.cwd(), 'build', 'icons', fileName),
    path.join(process.cwd(), 'public', fileName),
    path.join(process.cwd(), 'dist', fileName),
    path.join(__dirname, '../../build/icons', fileName),
    path.join(__dirname, '../../dist', fileName),
    path.join(__dirname, '../dist', fileName)
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function normalizeTranslationIpcInput(input: unknown) {
  if (!isRecord(input)) {
    throw new Error('翻译请求无效');
  }

  const text = typeof input.text === 'string' ? input.text : '';
  const targetLanguage = typeof input.targetLanguage === 'string' ? input.targetLanguage : '';
  const translationFormat = normalizeTranslationFormat(
    typeof input.translationFormat === 'string' ? input.translationFormat : desktopSettings.defaultTranslationFormat
  );

  if (!targetLanguage.trim()) {
    throw new Error('目标语言不能为空');
  }

  return { text, targetLanguage, translationFormat };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUpdateTransactionIdInput(input: unknown) {
  if (!isRecord(input)) {
    return undefined;
  }

  return typeof input.transactionId === 'string' ? input.transactionId : undefined;
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    desktopSettings = loadDesktopSettings();
    await restoreClipboardIfNeeded({
      clipboard,
      recoveryStore: getClipboardRecoveryStore()
    }).catch((error) => {
      console.warn(`[剪切板恢复] ${error instanceof Error ? error.message : String(error)}`);
    });
    Menu.setApplicationMenu(null);
    ipcMain.handle('capture-selected-text', () => captureFromSelection());
    ipcMain.handle('copy-text', (_event, text: string) => {
      clipboard.writeText(text);
    });
    ipcMain.handle('get-desktop-settings', () => desktopSettings);
    ipcMain.handle('check-for-updates', () =>
      checkForUpdates(isSmokeTest, (progress) => {
        mainWindow?.webContents.send('desktop-update-progress', progress);
      }, desktopSettings.updatePackageDirectory)
    );
    ipcMain.handle('choose-update-package-directory', () => chooseUpdatePackageDirectory());
    ipcMain.handle('open-update-package-directory', () => openUpdatePackageDirectory());
    ipcMain.handle('clear-update-packages', () => clearStoredUpdatePackages());
    ipcMain.handle('get-latest-update-transaction', () => getLatestUpdateTransaction());
    ipcMain.handle('open-update-transaction-log-directory', (_event, input: unknown) =>
      openUpdateTransactionLogDirectory({
        transactionId: readUpdateTransactionIdInput(input)
      })
    );
    ipcMain.handle('retry-update-transaction', async (_event, input: unknown) => {
      await retryUpdateTransaction({
        transactionId: readUpdateTransactionIdInput(input)
      });
      isQuitting = true;
      app.quit();
      const forceExitTimer = setTimeout(() => {
        app.exit(0);
      }, 800);
      forceExitTimer.unref();
      return true;
    });
    ipcMain.handle('set-desktop-settings', (_event, settings: Partial<DesktopSettings>) => updateDesktopSettings(settings));
    ipcMain.handle('save-floating-window-position', () => saveFloatingWindowPosition());
    ipcMain.handle('set-floating-session-preferences', (_event, preferences: unknown) => updateFloatingSessionPreferenceState(preferences));
    ipcMain.handle('window-control', (_event, command: unknown) => executeWindowControl(command));
    ipcMain.handle('translate-text', (_event, input: unknown) => {
      const request = normalizeTranslationIpcInput(input);
      return translateUsingConfiguredChannel(request);
    });
    await createWindow();
    await markLatestInstallerStartedTransactionDone({
      currentVersion: app.getVersion()
    });
    createTray();
    applyDesktopSettings(desktopSettings);
    startAutoUpdates(isSmokeTest);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  windowsCopyShortcutSender.stop();
  mouseButton4Shortcut?.stop();
  mouseButton4Shortcut = null;
  if (keyboardFloatingShortcutAccelerator) {
    globalShortcut.unregister(keyboardFloatingShortcutAccelerator);
    keyboardFloatingShortcutAccelerator = null;
  }
  floatingWindow?.destroy();
  floatingWindow = null;
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
