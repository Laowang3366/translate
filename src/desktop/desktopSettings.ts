import { defaultTargetLanguage, normalizeTargetLanguage } from '../shared/languages.js';
import { defaultTranslationFormat, normalizeTranslationFormat, type TranslationFormat } from '../shared/translationFormats.js';

export type FloatingTranslateShortcutPreset =
  | 'mouse-button-4'
  | 'mouse-button-5'
  | 'ctrl-alt-t'
  | 'ctrl-shift-y'
  | 'alt-q'
  | 'f8'
  | 'disabled';

export type FloatingTranslateShortcut = FloatingTranslateShortcutPreset | `custom:${string}`;

export type FloatingTranslateShortcutOption = {
  value: FloatingTranslateShortcutPreset;
  label: string;
  accelerator?: string;
};

export type FloatingWindowPositionMode = 'follow-cursor' | 'first-position' | 'custom-position';

export type FloatingWindowPosition = {
  x: number;
  y: number;
};

export type FloatingWindowPositionOption = {
  value: FloatingWindowPositionMode;
  label: string;
};

export type DesktopSettings = {
  mouseButton4Enabled: boolean;
  floatingTranslateShortcut: FloatingTranslateShortcut;
  floatingWindowPositionMode: FloatingWindowPositionMode;
  customFloatingWindowPosition: FloatingWindowPosition | null;
  launchAtLogin: boolean;
  hideToTrayOnClose: boolean;
  defaultTargetLanguage: string;
  defaultTranslationFormat: TranslationFormat;
  updatePackageDirectory: string;
};

export const floatingTranslateShortcutOptions: FloatingTranslateShortcutOption[] = [
  { value: 'mouse-button-4', label: '鼠标下侧键' },
  { value: 'mouse-button-5', label: '鼠标上侧键' },
  { value: 'ctrl-alt-t', label: 'Ctrl + Alt + T', accelerator: 'CommandOrControl+Alt+T' },
  { value: 'ctrl-shift-y', label: 'Ctrl + Shift + Y', accelerator: 'CommandOrControl+Shift+Y' },
  { value: 'alt-q', label: 'Alt + Q', accelerator: 'Alt+Q' },
  { value: 'f8', label: 'F8', accelerator: 'F8' },
  { value: 'disabled', label: '关闭快捷键' }
];

export const floatingWindowPositionOptions: FloatingWindowPositionOption[] = [
  { value: 'follow-cursor', label: '跟随鼠标' },
  { value: 'first-position', label: '第一次出现的位置' },
  { value: 'custom-position', label: '自定义屏幕位置' }
];

const customShortcutPrefix = 'custom:';
const maxStoredFloatingWindowCoordinate = 1_000_000;
const supportedModifierKeys = new Set(['CommandOrControl', 'Control', 'Command', 'Alt', 'Option', 'AltGr', 'Shift', 'Super']);
const supportedNamedKeys = new Set([
  'Plus',
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Return',
  'Enter',
  'Escape',
  'Esc',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Capslock',
  'Numlock',
  'Scrolllock',
  'PrintScreen',
  'Pause',
  'VolumeUp',
  'VolumeDown',
  'VolumeMute',
  'MediaNextTrack',
  'MediaPreviousTrack',
  'MediaStop',
  'MediaPlayPause'
]);
const supportedPunctuationKeys = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '*']);

export const defaultDesktopSettings: DesktopSettings = {
  mouseButton4Enabled: true,
  floatingTranslateShortcut: 'mouse-button-4',
  floatingWindowPositionMode: 'follow-cursor',
  customFloatingWindowPosition: null,
  launchAtLogin: false,
  hideToTrayOnClose: false,
  defaultTargetLanguage,
  defaultTranslationFormat,
  updatePackageDirectory: ''
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeFloatingWindowPositionMode(value: unknown): FloatingWindowPositionMode {
  return floatingWindowPositionOptions.some((option) => option.value === value)
    ? (value as FloatingWindowPositionMode)
    : defaultDesktopSettings.floatingWindowPositionMode;
}

export function normalizeFloatingWindowPosition(value: unknown): FloatingWindowPosition | null {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number') {
    return null;
  }

  if (!isSafeFloatingWindowCoordinate(value.x) || !isSafeFloatingWindowCoordinate(value.y)) {
    return null;
  }

  return {
    x: Math.round(value.x),
    y: Math.round(value.y)
  };
}

export function normalizeFloatingTranslateShortcut(value: unknown): FloatingTranslateShortcut {
  if (typeof value !== 'string') {
    return defaultDesktopSettings.floatingTranslateShortcut;
  }

  if (floatingTranslateShortcutOptions.some((option) => option.value === value)) {
    return value as FloatingTranslateShortcutPreset;
  }

  if (value.startsWith(customShortcutPrefix)) {
    const accelerator = normalizeCustomShortcutAccelerator(value.slice(customShortcutPrefix.length));
    return accelerator ? createCustomFloatingTranslateShortcut(accelerator) : defaultDesktopSettings.floatingTranslateShortcut;
  }

  return defaultDesktopSettings.floatingTranslateShortcut;
}

export function getFloatingTranslateShortcutLabel(value: unknown) {
  const shortcut = normalizeFloatingTranslateShortcut(value);
  if (isCustomFloatingTranslateShortcut(shortcut)) {
    return `自定义：${formatShortcutAcceleratorLabel(shortcut.slice(customShortcutPrefix.length))}`;
  }

  return floatingTranslateShortcutOptions.find((option) => option.value === shortcut)?.label ?? '鼠标下侧键';
}

export function getFloatingTranslateShortcutAccelerator(value: unknown) {
  const shortcut = normalizeFloatingTranslateShortcut(value);
  if (isCustomFloatingTranslateShortcut(shortcut)) {
    return shortcut.slice(customShortcutPrefix.length);
  }

  return floatingTranslateShortcutOptions.find((option) => option.value === shortcut)?.accelerator;
}

export function createCustomFloatingTranslateShortcut(accelerator: string): FloatingTranslateShortcut {
  const normalizedAccelerator = normalizeCustomShortcutAccelerator(accelerator);
  return normalizedAccelerator ? `${customShortcutPrefix}${normalizedAccelerator}` : defaultDesktopSettings.floatingTranslateShortcut;
}

export function isCustomFloatingTranslateShortcut(value: unknown): value is `custom:${string}` {
  return typeof value === 'string' && value.startsWith(customShortcutPrefix);
}

export function normalizeCustomShortcutAccelerator(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const modifiers: string[] = [];
  let key = '';

  for (const part of parts) {
    const normalizedPart = normalizeShortcutPart(part);
    if (!normalizedPart) {
      return undefined;
    }

    if (supportedModifierKeys.has(normalizedPart)) {
      if (!modifiers.includes(normalizedPart)) {
        modifiers.push(normalizedPart);
      }
      continue;
    }

    if (key) {
      return undefined;
    }
    key = normalizedPart;
  }

  if (!key) {
    return undefined;
  }

  return [...sortShortcutModifiers(modifiers), key].join('+');
}

export function formatShortcutAcceleratorLabel(accelerator: string) {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl') {
        return 'Ctrl';
      }
      if (part === 'Super') {
        return 'Win';
      }
      if (part === 'Return') {
        return 'Enter';
      }
      if (part === 'Escape') {
        return 'Esc';
      }
      return part;
    })
    .join(' + ');
}

function normalizeShortcutPart(value: string) {
  const trimmedValue = value.trim();
  const lowerValue = trimmedValue.toLowerCase();
  const modifierMap: Record<string, string> = {
    ctrl: 'CommandOrControl',
    control: 'CommandOrControl',
    cmdorctrl: 'CommandOrControl',
    commandorcontrol: 'CommandOrControl',
    command: 'Command',
    cmd: 'Command',
    alt: 'Alt',
    option: 'Option',
    altgr: 'AltGr',
    shift: 'Shift',
    super: 'Super',
    meta: 'Super',
    win: 'Super',
    windows: 'Super'
  };
  const keyMap: Record<string, string> = {
    '+': 'Plus',
    plus: 'Plus',
    space: 'Space',
    ' ': 'Space',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    del: 'Delete',
    insert: 'Insert',
    ins: 'Insert',
    return: 'Return',
    enter: 'Return',
    escape: 'Escape',
    esc: 'Escape',
    arrowup: 'Up',
    up: 'Up',
    arrowdown: 'Down',
    down: 'Down',
    arrowleft: 'Left',
    left: 'Left',
    arrowright: 'Right',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown'
  };
  const punctuationMap: Record<string, string> = {
    '`': '`',
    backquote: '`',
    '-': '-',
    minus: '-',
    '=': '=',
    equal: '=',
    '[': '[',
    bracketleft: '[',
    ']': ']',
    bracketright: ']',
    '\\': '\\',
    backslash: '\\',
    ';': ';',
    semicolon: ';',
    "'": "'",
    quote: "'",
    ',': ',',
    comma: ',',
    '.': '.',
    period: '.',
    '/': '/',
    slash: '/',
    '*': '*',
    multiply: '*'
  };

  if (modifierMap[lowerValue]) {
    return modifierMap[lowerValue];
  }
  if (keyMap[lowerValue]) {
    return keyMap[lowerValue];
  }
  if (punctuationMap[lowerValue]) {
    return punctuationMap[lowerValue];
  }
  if (/^f([1-9]|1\d|2[0-4])$/i.test(trimmedValue)) {
    return trimmedValue.toUpperCase();
  }
  if (/^[a-z]$/i.test(trimmedValue)) {
    return trimmedValue.toUpperCase();
  }
  if (/^\d$/.test(trimmedValue)) {
    return trimmedValue;
  }
  if (supportedNamedKeys.has(trimmedValue)) {
    return trimmedValue;
  }
  if (supportedPunctuationKeys.has(trimmedValue)) {
    return trimmedValue;
  }

  return undefined;
}

function sortShortcutModifiers(modifiers: string[]) {
  const sortOrder = ['CommandOrControl', 'Control', 'Command', 'Super', 'Alt', 'Option', 'AltGr', 'Shift'];
  return [...modifiers].sort((left, right) => sortOrder.indexOf(left) - sortOrder.indexOf(right));
}

function isSafeFloatingWindowCoordinate(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= maxStoredFloatingWindowCoordinate;
}

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const record = isRecord(value) ? value : {};
  const hasFloatingShortcut = typeof record.floatingTranslateShortcut === 'string';
  const floatingTranslateShortcut = hasFloatingShortcut
    ? normalizeFloatingTranslateShortcut(record.floatingTranslateShortcut)
    : booleanOrDefault(record.mouseButton4Enabled, defaultDesktopSettings.mouseButton4Enabled)
      ? 'mouse-button-4'
      : 'disabled';

  return {
    mouseButton4Enabled: floatingTranslateShortcut === 'mouse-button-4',
    floatingTranslateShortcut,
    floatingWindowPositionMode: normalizeFloatingWindowPositionMode(record.floatingWindowPositionMode),
    customFloatingWindowPosition: normalizeFloatingWindowPosition(record.customFloatingWindowPosition),
    launchAtLogin: booleanOrDefault(record.launchAtLogin, defaultDesktopSettings.launchAtLogin),
    hideToTrayOnClose: booleanOrDefault(record.hideToTrayOnClose, defaultDesktopSettings.hideToTrayOnClose),
    defaultTargetLanguage: normalizeTargetLanguage(record.defaultTargetLanguage),
    defaultTranslationFormat: normalizeTranslationFormat(record.defaultTranslationFormat),
    updatePackageDirectory: typeof record.updatePackageDirectory === 'string' ? record.updatePackageDirectory.trim() : ''
  };
}

export function parseDesktopSettings(text: string | undefined): DesktopSettings {
  if (!text) {
    return defaultDesktopSettings;
  }

  try {
    return normalizeDesktopSettings(JSON.parse(text));
  } catch {
    return defaultDesktopSettings;
  }
}

export function mergeDesktopSettings(currentSettings: DesktopSettings, patch: Partial<DesktopSettings>): DesktopSettings {
  const nextPatch =
    typeof patch.mouseButton4Enabled === 'boolean' && typeof patch.floatingTranslateShortcut !== 'string'
      ? { ...patch, floatingTranslateShortcut: patch.mouseButton4Enabled ? 'mouse-button-4' : 'disabled' }
      : patch;
  return normalizeDesktopSettings({ ...currentSettings, ...nextPatch });
}

export function serializeDesktopSettings(settings: DesktopSettings): string {
  return `${JSON.stringify(normalizeDesktopSettings(settings), null, 2)}\n`;
}
