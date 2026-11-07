// Мелкие помощники интерфейса: форматирование, подписи ответов, значки, уведомления, роль.
import { scaleMax } from './scoring.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmt = (n, digits = 2) =>
  n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits });

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

export const fmtDay = (iso) => {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  } catch {
    return '';
  }
};

export const fmtUsd = (n) => (n == null ? '—' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`);

export const plural = (n, one, few, many) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/** Уведомление внизу экрана. kind: info | ok | error. */
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5200 : 3200);
}

/** Подпись ответа: «Да», «Нет», «N/A», «15 из 20», для флага — «Выявлены»/«Нет». */
export function answerLabel(criterion, answer) {
  if (answer == null) return 'не оценён';
  if (answer === 'na') return 'N/A';
  if (!criterion) return String(answer);
  if (criterion.type === 'flag') return answer === 'yes' ? 'Выявлены' : 'Нет';
  if (criterion.type === 'scale') return `${answer} из ${scaleMax(criterion)}`;
  return answer === 'yes' ? 'Да' : 'Нет';
}

/** Доля выполнения критерия 0…1 (null — N/A или не оценён). Для флага: «выявлены» = 0. */
export function answerNorm(criterion, answer) {
  if (answer == null || answer === 'na' || !criterion) return null;
  if (criterion.type === 'flag') return answer === 'yes' ? 0 : 1;
  if (criterion.type === 'scale') {
    const max = scaleMax(criterion);
    return max > 0 ? Number(answer) / max : 0;
  }
  return answer === 'yes' ? 1 : 0;
}

/** Состояние критерия в терминах макета: v — выполнен, x — потеря баллов, c — грубая ошибка, na — неприменим. */
export function critState(criterion, answer) {
  if (answer == null || answer === 'na') return 'na';
  if (criterion?.type === 'flag') return answer === 'yes' ? 'c' : 'v';
  const n = answerNorm(criterion, answer);
  return n >= 1 ? 'v' : 'x';
}

/** Класс цвета ответа: good / bad / mid / na (тренажёр и старые места). */
export function answerTone(criterion, answer) {
  const s = critState(criterion, answer);
  if (s === 'na') return 'na';
  if (s === 'c') return 'bad';
  if (s === 'v') return 'good';
  return answerNorm(criterion, answer) >= 0.5 ? 'mid' : 'bad';
}
export const stateTag = (s) => (s === 'v' ? 'ok' : s === 'x' ? 'mid' : s === 'c' ? 'bad' : 'na');

export function answerOptions(criterion) {
  const opts = [];
  if (criterion.type === 'scale') for (const s of [...criterion.scale].sort((a, b) => b.value - a.value)) opts.push([String(s.value), `${s.value} — ${s.label}`]);
  else if (criterion.type === 'flag') opts.push(['yes', 'Выявлены'], ['no', 'Нет']);
  else opts.push(['yes', 'Да'], ['no', 'Нет']);
  if (criterion.naAllowed && criterion.type !== 'flag') opts.push(['na', 'N/A — неприменимо']);
  return opts;
}

// Зоны итогового балла — те же, что на шкале под итогом: ниже 60, 60–80, от 80.
export const band = (v) => (v == null ? 'na' : v < 60 ? 'low' : v < 80 ? 'mid' : 'ok');
export const scoreTone = (v) => (v == null ? 'na' : v < 60 ? 'bad' : v < 80 ? 'mid' : 'good');
export const verdict = (v) => (v == null ? 'Итог не рассчитан' : v >= 90 ? 'Сильный разговор' : v >= 75 ? 'Хороший разговор, есть точки роста' : v >= 60 ? 'Средний результат' : 'Требует разбора');

// Режим оценки: мультиагентный конвейер, один вызов или один вызов ×3 с голосованием.
export const MODES = [
  ['agents', 'Мультиагентный конвейер'],
  ['single', 'Один вызов модели'],
  ['single3', 'Один вызов ×3, голосование'],
];
export const modeSelect = (id, current = 'agents') =>
  `<select class="select" id="${id}" name="mode" aria-label="Режим оценки">${MODES.map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
export const readMode = (v) => (v === 'single3' ? { mode: 'single', votes: 3 } : v === 'single' ? { mode: 'single', votes: 1 } : { mode: 'agents', votes: 1 });
export const modeOf = (ev) => (ev?.mode === 'agents' ? 'agents' : ev?.votes > 1 ? 'single3' : 'single');
export const modeLabel = (ev) => (ev.mode === 'agents' ? 'мультиагентный конвейер' : ev.votes > 1 ? `${ev.votes} прогона, голосование` : '1 вызов модели');

export const LANG = { RU: 'Русский', KZ: 'Қазақша', EN: 'English' };
export const CHANNEL = { 'agent chat': 'Чат', 'voice call': 'Звонок' };

export const role = {
  get: () => {
    try {
      return localStorage.getItem('cqa-role') || 'employee';
    } catch {
      return 'employee';
    }
  },
  set: (r) => {
    try {
      localStorage.setItem('cqa-role', r);
    } catch {}
  },
};

export function busy(button, on, text) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${esc(text || 'Подождите…')}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

// ── значки (линейные, 24×24) и знак Freedom ───────────────────────────
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>',
  chat: '<path d="M21 14a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  call: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  alert: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  list: '<path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17M11 6h10M11 12h10M11 18h10"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  spark: '<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M8 16H3v5"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  cap: '<path d="M22 10 12 5 2 10l10 5zM6 12v5c3 2.5 9 2.5 12 0v-5M22 10v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
};
export function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.spark}</svg>`;
}
export const chev = '<svg class="ico chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/** Щит Freedom, перерисованный в SVG (из макета). */
export function logo(cls = '') {
  return `<svg class="fr-logo ${cls}" viewBox="0 0 100 116" aria-label="Freedom" role="img"><defs><clipPath id="frc"><path d="M6 4h88v58c0 26-20 42-44 50C26 104 6 88 6 62z"/></clipPath></defs><g clip-path="url(#frc)"><rect width="100" height="116" fill="var(--logo-bright,#3BB54A)"/><path d="M48 64a6 6 0 0 1 6-6h46v60H48z" fill="var(--logo-dark,#1E5A2F)"/><path d="M58 32h44v28H86V46H58a7 7 0 0 1 0-14z" fill="var(--logo-gap,#0B0F0C)"/><path d="M48 58h38v6H48z" fill="var(--logo-gap,#0B0F0C)"/></g></svg>`;
}

/** Стабильный хеш строки (FNV-1a) — для декоративных полей. */
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
