// Загрузка наборов из временного API организаторов и проверка формата записей.
import { config } from './env.js';

export async function fetchGroup(groupId) {
  if (!config.orgApiUrl) throw new Error('Не задан ORG_API_URL в .env');
  const url = new URL(config.orgApiUrl);
  url.searchParams.set('group_id', groupId);
  const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`API организаторов вернул не JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!json.isSuccess) throw new Error(`API организаторов: ${json.error || 'isSuccess = false'}`);
  return json.data;
}

const ROLES = new Set(['client', 'operator', 'bot', 'system']);

/** Проверяет запись диалога. Возвращает список ошибок (пустой — запись корректна). */
export function validateRecord(r) {
  const errors = [];
  if (!r || typeof r !== 'object') return ['запись не является объектом'];
  if (!r.conversation_id) errors.push('нет conversation_id');
  if (!Array.isArray(r.transcript) || !r.transcript.length) errors.push('transcript пуст или не массив');
  else
    r.transcript.forEach((t, i) => {
      if (!ROLES.has(t.speaker)) errors.push(`реплика ${i}: неизвестная роль «${t.speaker}»`);
      if (typeof t.text !== 'string') errors.push(`реплика ${i}: нет text`);
    });
  return errors;
}

/** Принимает массив записей, ответ API целиком или одну запись. */
export function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload?.data?.records) return payload.data.records;
  if (payload?.records) return payload.records;
  if (payload?.conversation_id) return [payload];
  return [];
}

// Ссылка на запись звонка ведёт на HTML-страницу с плеером; прямая ссылка на mp3 внутри живёт около часа.
const audioCache = new Map(); // conversationId → { url, exp }

export async function resolveAudio(conversationId, audioUrl) {
  const hit = audioCache.get(conversationId);
  if (hit && hit.exp > Date.now()) return hit.url;
  const res = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
  const body = await res.text();
  const m = body.match(/<source[^>]+src="([^"]+)"/i) || body.match(/<audio[^>]+src="([^"]+)"/i);
  if (!m) throw new Error('На странице записи не найден аудиофайл');
  const url = m[1].replace(/&amp;/g, '&');
  audioCache.set(conversationId, { url, exp: Date.now() + 40 * 60_000 });
  return url;
}
