import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type ProviderSettings, type ProviderType } from '../shared/providerSettings.js';

type LoadBackendProviderSettingsOptions = {
  settingsPath?: string;
  env?: Record<string, string | undefined>;
};

const providerTypes = new Set<ProviderType>(['mock', 'openai-compatible']);

export const packagedProviderSettings: ProviderSettings = {
  providerType: 'mock',
  apiKey: '',
  baseUrl: '',
  model: ''
};

export function getProviderSettingsPath(userDataPath: string) {
  return path.join(userDataPath, 'provider-settings.json');
}

export function loadBackendProviderSettings(options: LoadBackendProviderSettingsOptions = {}): ProviderSettings {
  const fileSettings = loadProviderSettingsFile(options.settingsPath);
  return mergeEnvironmentSettings(fileSettings, options.env ?? process.env);
}

function loadProviderSettingsFile(settingsPath: string | undefined): ProviderSettings {
  if (!settingsPath || !existsSync(settingsPath)) {
    return packagedProviderSettings;
  }

  try {
    return normalizeProviderSettings(JSON.parse(readFileSync(settingsPath, 'utf8')), packagedProviderSettings);
  } catch {
    return packagedProviderSettings;
  }
}

function mergeEnvironmentSettings(fileSettings: ProviderSettings, env: Record<string, string | undefined>) {
  const apiKey = firstNonEmptyString(env.TRANSLATE_API_KEY, env.OPENAI_API_KEY, fileSettings.apiKey);
  const baseUrl = firstNonEmptyString(env.TRANSLATE_BASE_URL, fileSettings.baseUrl);
  const model = firstNonEmptyString(env.TRANSLATE_MODEL, fileSettings.model);
  const explicitProviderType = normalizeProviderType(env.TRANSLATE_PROVIDER);
  const providerType = explicitProviderType ?? (apiKey ? 'openai-compatible' : fileSettings.providerType);

  return {
    providerType,
    apiKey,
    baseUrl,
    model
  };
}

function normalizeProviderSettings(value: unknown, fallback: ProviderSettings): ProviderSettings {
  if (!isRecord(value)) {
    return fallback;
  }

  const apiKey = stringOrFallback(value.apiKey, fallback.apiKey);

  return {
    providerType: normalizeProviderType(value.providerType) ?? (apiKey ? 'openai-compatible' : fallback.providerType),
    apiKey,
    baseUrl: stringOrFallback(value.baseUrl, fallback.baseUrl),
    model: stringOrFallback(value.model, fallback.model)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProviderType(value: unknown): ProviderType | undefined {
  return typeof value === 'string' && providerTypes.has(value as ProviderType) ? (value as ProviderType) : undefined;
}

function stringOrFallback(value: unknown, fallback: string) {
  return typeof value === 'string' ? value : fallback;
}

function firstNonEmptyString(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
}
