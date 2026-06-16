import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProviderSettingsPath, loadBackendProviderSettings, packagedProviderSettings } from './providerSettings';

describe('backend provider settings', () => {
  it('does not package provider credentials when no direct backend channel is configured', () => {
    expect(packagedProviderSettings).toEqual({
      providerType: 'mock',
      apiKey: '',
      baseUrl: '',
      model: ''
    });
    expect(loadBackendProviderSettings({ env: {} })).toEqual(packagedProviderSettings);
  });

  it('enables an OpenAI-compatible backend channel from environment variables', () => {
    expect(
      loadBackendProviderSettings({
        env: {
          TRANSLATE_API_KEY: 'env-secret',
          TRANSLATE_BASE_URL: 'https://api.env.example/v1',
          TRANSLATE_MODEL: 'env-model'
        }
      })
    ).toEqual({
      providerType: 'openai-compatible',
      apiKey: 'env-secret',
      baseUrl: 'https://api.env.example/v1',
      model: 'env-model'
    });
  });

  it('loads an OpenAI-compatible backend channel from the user data settings file', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'quick-translate-provider-'));
    const settingsPath = getProviderSettingsPath(userDataPath);

    writeFileSync(
      settingsPath,
      JSON.stringify({
        providerType: 'openai-compatible',
        apiKey: 'file-secret',
        baseUrl: 'https://api.file.example/v1',
        model: 'file-model'
      }),
      'utf8'
    );

    expect(loadBackendProviderSettings({ settingsPath, env: {} })).toEqual({
      providerType: 'openai-compatible',
      apiKey: 'file-secret',
      baseUrl: 'https://api.file.example/v1',
      model: 'file-model'
    });
  });

  it('lets process environment override the user data settings file', () => {
    const userDataPath = mkdtempSync(path.join(tmpdir(), 'quick-translate-provider-'));
    const settingsPath = getProviderSettingsPath(userDataPath);

    writeFileSync(
      settingsPath,
      JSON.stringify({
        providerType: 'openai-compatible',
        apiKey: 'file-secret',
        baseUrl: 'https://api.file.example/v1',
        model: 'file-model'
      }),
      'utf8'
    );

    expect(
      loadBackendProviderSettings({
        settingsPath,
        env: {
          OPENAI_API_KEY: 'env-secret',
          TRANSLATE_MODEL: 'env-model'
        }
      })
    ).toEqual({
      providerType: 'openai-compatible',
      apiKey: 'env-secret',
      baseUrl: 'https://api.file.example/v1',
      model: 'env-model'
    });
  });
});
