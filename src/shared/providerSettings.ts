import type { TranslationProvider } from './translator.js';

export type ProviderType = 'mock' | 'openai-compatible';

export type ProviderSettings = {
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export const defaultProviderSettings: ProviderSettings = {
  providerType: 'mock',
  apiKey: '',
  baseUrl: '',
  model: ''
};

export function createProviderFromSettings(settings: ProviderSettings): TranslationProvider {
  const apiKey = settings.apiKey.trim();
  const baseUrl = settings.baseUrl.trim();
  const model = settings.model.trim();

  if (settings.providerType !== 'openai-compatible' || !apiKey || !baseUrl || !model) {
    return { type: 'mock' };
  }

  return {
    type: 'openai-compatible',
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ''),
    model
  };
}
