import { describe, expect, it } from 'vitest';
import {
  defaultDesktopSettings,
  createCustomFloatingTranslateShortcut,
  formatShortcutAcceleratorLabel,
  floatingWindowPositionOptions,
  getFloatingTranslateShortcutAccelerator,
  getFloatingTranslateShortcutLabel,
  mergeDesktopSettings,
  normalizeCustomShortcutAccelerator,
  normalizeDesktopSettings,
  normalizeFloatingWindowPosition,
  normalizeFloatingWindowPositionMode,
  parseDesktopSettings
} from './desktopSettings';

describe('desktop settings', () => {
  it('uses safe defaults when stored settings are missing or damaged', () => {
    expect(defaultDesktopSettings.hideToTrayOnClose).toBe(false);
    expect(parseDesktopSettings(undefined)).toEqual(defaultDesktopSettings);
    expect(parseDesktopSettings('{bad json')).toEqual(defaultDesktopSettings);
  });

  it('merges partial stored settings with defaults', () => {
    expect(
      parseDesktopSettings(
        JSON.stringify({
          launchAtLogin: true,
          defaultTargetLanguage: 'es-ES',
          defaultTranslationFormat: 'java-camel-case',
          updatePackageDirectory: 'D:\\Downloads\\QuickTranslate'
        })
      )
    ).toEqual({
      ...defaultDesktopSettings,
      defaultTargetLanguage: 'es-ES',
      defaultTranslationFormat: 'java-camel-case',
      launchAtLogin: true,
      updatePackageDirectory: 'D:\\Downloads\\QuickTranslate'
    });
  });

  it('adds safe defaults for floating window position preferences', () => {
    expect(defaultDesktopSettings.floatingWindowPositionMode).toBe('follow-cursor');
    expect(defaultDesktopSettings.customFloatingWindowPosition).toBeNull();
    expect(floatingWindowPositionOptions.map((option) => option.label)).toEqual([
      '跟随鼠标',
      '第一次出现的位置',
      '自定义屏幕位置'
    ]);
    expect(parseDesktopSettings(JSON.stringify({ launchAtLogin: true }))).toEqual({
      ...defaultDesktopSettings,
      launchAtLogin: true
    });
  });

  it('normalizes stored floating window position preferences', () => {
    expect(normalizeFloatingWindowPositionMode('first-position')).toBe('first-position');
    expect(normalizeFloatingWindowPositionMode('custom-position')).toBe('custom-position');
    expect(normalizeFloatingWindowPositionMode('bad-mode')).toBe('follow-cursor');
    expect(normalizeFloatingWindowPosition({ x: -320.4, y: 156.6 })).toEqual({ x: -320, y: 157 });
    expect(normalizeFloatingWindowPosition({ x: Number.POSITIVE_INFINITY, y: 120 })).toBeNull();
    expect(normalizeFloatingWindowPosition({ x: 2_000_000, y: 120 })).toBeNull();

    expect(
      parseDesktopSettings(
        JSON.stringify({
          floatingWindowPositionMode: 'custom-position',
          customFloatingWindowPosition: { x: 240.2, y: -32.7 }
        })
      )
    ).toEqual({
      ...defaultDesktopSettings,
      floatingWindowPositionMode: 'custom-position',
      customFloatingWindowPosition: { x: 240, y: -33 }
    });

    expect(
      parseDesktopSettings(
        JSON.stringify({
          floatingWindowPositionMode: 'unknown',
          customFloatingWindowPosition: { x: 'left', y: 90 }
        })
      )
    ).toEqual(defaultDesktopSettings);
  });

  it('migrates the legacy mouse button toggle into the floating shortcut setting', () => {
    expect(parseDesktopSettings(JSON.stringify({ mouseButton4Enabled: false }))).toEqual({
      ...defaultDesktopSettings,
      mouseButton4Enabled: false,
      floatingTranslateShortcut: 'disabled'
    });
  });

  it('ignores non-boolean setting values', () => {
    expect(
      normalizeDesktopSettings({
        mouseButton4Enabled: 'yes',
        floatingTranslateShortcut: 'bad-shortcut',
        launchAtLogin: true,
        hideToTrayOnClose: 1,
        defaultTargetLanguage: 'bad-language',
        defaultTranslationFormat: 'bad-format'
      })
    ).toEqual({
      ...defaultDesktopSettings,
      launchAtLogin: true
    });
  });

  it('merges setting patches onto the current settings', () => {
    expect(mergeDesktopSettings(defaultDesktopSettings, { mouseButton4Enabled: false })).toEqual({
      ...defaultDesktopSettings,
      mouseButton4Enabled: false,
      floatingTranslateShortcut: 'disabled'
    });
    expect(mergeDesktopSettings(defaultDesktopSettings, { floatingTranslateShortcut: 'ctrl-alt-t' })).toEqual({
      ...defaultDesktopSettings,
      mouseButton4Enabled: false,
      floatingTranslateShortcut: 'ctrl-alt-t'
    });
  });

  it('provides display labels and accelerators for floating shortcuts', () => {
    expect(getFloatingTranslateShortcutLabel('mouse-button-4')).toBe('鼠标下侧键');
    expect(getFloatingTranslateShortcutAccelerator('ctrl-alt-t')).toBe('CommandOrControl+Alt+T');
    expect(getFloatingTranslateShortcutAccelerator('mouse-button-4')).toBeUndefined();
  });

  it('normalizes custom keyboard shortcuts for the floating translator', () => {
    expect(normalizeCustomShortcutAccelerator('k')).toBe('K');
    expect(normalizeCustomShortcutAccelerator('shift+k')).toBe('Shift+K');
    expect(normalizeCustomShortcutAccelerator('ctrl + alt + k')).toBe('CommandOrControl+Alt+K');
    expect(normalizeCustomShortcutAccelerator('ctrl + semicolon')).toBe('CommandOrControl+;');
    expect(createCustomFloatingTranslateShortcut('Ctrl+Shift+ArrowUp')).toBe('custom:CommandOrControl+Shift+Up');
    expect(createCustomFloatingTranslateShortcut('K')).toBe('custom:K');
    expect(getFloatingTranslateShortcutAccelerator('custom:CommandOrControl+Alt+K')).toBe('CommandOrControl+Alt+K');
    expect(getFloatingTranslateShortcutAccelerator('custom:K')).toBe('K');
    expect(getFloatingTranslateShortcutLabel('custom:CommandOrControl+Alt+K')).toBe('自定义：Ctrl + Alt + K');
    expect(formatShortcutAcceleratorLabel('CommandOrControl+Super+Return')).toBe('Ctrl + Win + Enter');
  });

  it('rejects unsafe custom keyboard shortcuts', () => {
    expect(normalizeCustomShortcutAccelerator('shift')).toBeUndefined();
    expect(normalizeCustomShortcutAccelerator('ctrl+alt')).toBeUndefined();
    expect(parseDesktopSettings(JSON.stringify({ floatingTranslateShortcut: 'custom:K' }))).toEqual({
      ...defaultDesktopSettings,
      mouseButton4Enabled: false,
      floatingTranslateShortcut: 'custom:K'
    });
  });
});
