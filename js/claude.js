// Клиент Claude для браузера на базе официального SDK (vendor/anthropic-sdk.js).
import Anthropic from '../vendor/anthropic-sdk.js';
import { settings } from './store.js';

let cached = null;

export class NoKeyError extends Error {
  constructor() {
    super('Добавьте API-ключ Claude в настройках, чтобы пользоваться этой функцией.');
    this.code = 'NO_KEY';
  }
}

export const hasKey = () => !!settings.apiKey.trim();

/** Клиент SDK. Ключ хранится только на этом устройстве и уходит напрямую в api.anthropic.com. */
export function getClient() {
  const apiKey = settings.apiKey.trim();
  if (!apiKey) throw new NoKeyError();
  const baseURL = settings.apiBase.trim() || undefined;
  const sig = apiKey + '|' + (baseURL || '');
  if (!cached || cached.sig !== sig) {
    cached = {
      sig,
      client: new Anthropic({ apiKey, baseURL, dangerouslyAllowBrowser: true, maxRetries: 2 }),
    };
  }
  return cached.client;
}

/** Проверка ключа: лёгкий запрос списка моделей. */
export async function testKey() {
  const client = getClient();
  const page = await client.models.list({ limit: 20 });
  return page.data?.map((m) => m.id) || [];
}
