// Вызов Gemini без SDK: Vertex AI по сервисному аккаунту (JWT → OAuth-токен) или ключ Google AI Studio.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './env.js';

let tokenCache = null; // { token, exp, project }
let tokenPromise = null;

async function vertexToken() {
  if (tokenCache && tokenCache.exp - Date.now() > 120_000) return tokenCache;
  if (tokenPromise) return tokenPromise;
  tokenPromise = (async () => {
    const sa = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8'));
    const iat = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud,
      iat,
      exp: iat + 3600,
    })}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
    const res = await fetch(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Google OAuth: ${res.status} ${await res.text()}`);
    const json = await res.json();
    tokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000, project: sa.project_id };
    return tokenCache;
  })().finally(() => {
    tokenPromise = null;
  });
  return tokenPromise;
}

export function backendName() {
  if (config.credentialsFile) return `Vertex AI (${config.vertexLocation})`;
  if (config.apiKey) return 'Google AI Studio';
  return 'не настроен';
}

async function endpoint(model) {
  if (config.credentialsFile) {
    const { token, project } = await vertexToken();
    const loc = config.vertexLocation;
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
    return {
      url: `https://${host}/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  if (config.apiKey) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'x-goog-api-key': config.apiKey },
    };
  }
  throw new Error('Модель не настроена: укажите GOOGLE_APPLICATION_CREDENTIALS или GEMINI_API_KEY в .env');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Общий лимит одновременных запросов к модели: агентный конвейер делает до 12 вызовов на диалог,
// а пакетная оценка идёт по нескольким диалогам сразу.
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= config.maxParallel) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Один вызов generateContent. Возвращает { text, usage, model, ms }.
 * Повторяет запрос при 429/5xx с экспоненциальной паузой.
 */
export function generate(opts) {
  return withSlot(async () => {
    const t = Date.now();
    const res = await generateOnce(opts);
    return { ...res, ms: Date.now() - t };
  });
}

async function generateOnce({ system, user, schema, model = config.model, temperature = 0, seed }) {
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
      ...(seed !== undefined ? { seed } : {}),
    },
  };
  const { json, model: used } = await postModel(body, model);
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text) throw new Error(`Пустой ответ модели (finishReason: ${cand?.finishReason || 'нет'})`);
  const u = json.usageMetadata || {};
  return {
    text,
    model: json.modelVersion || used,
    usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
  };
}

/** Произвольный запрос generateContent (например, с инструментами) через те же лимиты, повторы и запасные модели. */
export function generateRaw(body, model = config.model) {
  return withSlot(() => postModel(body, model));
}

async function postModel(body, model) {
  let lastError;
  // 429 на Vertex — перегружен общий пул модели. Сначала переключаемся на запасную модель (у каждой модели
  // своя квота), и только когда перегружены все — ждём с разбросом, чтобы параллельные запросы не совпадали.
  const backoff = (attempt) => Math.min(20_000, 2000 * 2 ** attempt) + Math.random() * 3000;
  const pool = [model, ...config.fallbackModels.filter((m) => m !== model)];
  let pick = 0;
  for (let attempt = 0; attempt < 9; attempt++) {
    model = pool[pick % pool.length];
    let target;
    try {
      target = await endpoint(model);
    } catch (e) {
      // сетевой сбой при получении токена — повторяем; ошибка настройки — сразу наверх
      if (!/fetch failed|timeout|ECONN|ENOTFOUND/i.test(String(e.message) + String(e.cause?.code || ''))) throw e;
      lastError = e;
      await sleep(backoff(attempt));
      continue;
    }
    const { url, headers } = target;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) {
      let json;
      try {
        json = await res.json();
      } catch (e) {
        // обрыв соединения при чтении ответа — повторяем как сетевую ошибку
        lastError = new Error(`Gemini: ответ оборвался (${e.message})`);
        await sleep(backoff(attempt));
        continue;
      }
      return { json, model };
    }
    const errText = await res.text();
    lastError = new Error(`Gemini ${res.status}: ${errText.slice(0, 400)}`);
    if (![0, 429, 500, 502, 503, 504].includes(res.status)) break;
    pick++;
    // все модели пула уже пробовали — пауза перед следующим кругом
    if (res.status !== 429 || pick % pool.length === 0) await sleep(backoff(attempt));
  }
  throw lastError;
}

export function costUsd(usage) {
  return (usage.input * config.priceInputPerM + usage.output * config.priceOutputPerM) / 1e6;
}
