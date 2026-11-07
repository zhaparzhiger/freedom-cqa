// Общие функции для транскрипта: метки времени чатов (MM:SS) и звонков (ISO 8601).

const ROLE_RU = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
export const roleName = (speaker) => ROLE_RU[speaker] || speaker;

const pad = (n) => String(n).padStart(2, '0');
export function formatSec(sec) {
  if (sec == null || Number.isNaN(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function parseClock(ts) {
  const m = String(ts).match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

/**
 * Возвращает реплики с полями index, offsetSec (от начала разговора) и label (MM:SS).
 * Исходная метка времени сохраняется в поле timestamp без изменений.
 */
export function normalizeTranscript(record) {
  const items = record.transcript || [];
  const iso = items.map((t) => Date.parse(t.timestamp));
  const isIso = items.length && iso.every((v, i) => !Number.isNaN(v) && !/^\d+:\d{2}/.test(items[i].timestamp));
  const start = isIso ? Math.min(...iso) : 0;
  return items.map((t, index) => {
    const offsetSec = isIso ? (iso[index] - start) / 1000 : parseClock(t.timestamp);
    return { ...t, index, offsetSec, label: formatSec(offsetSec) };
  });
}
