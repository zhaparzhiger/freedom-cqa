// Мелкие помощники интерфейса.
import { scaleMax } from './scoring.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmt = (n, digits = 2) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits });

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

export const fmtUsd = (n) => (n == null ? '—' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`);

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

/** Подпись ответа: «Да», «Нет», «N/A», «15 из 20», для флага — «Выявлены»/«Нет». */
export function answerLabel(criterion, answer) {
  if (answer == null) return 'не оценён';
  if (answer === 'na') return 'N/A';
  if (criterion.type === 'flag') return answer === 'yes' ? 'Выявлены' : 'Нет';
  if (criterion.type === 'scale') return `${answer} из ${scaleMax(criterion)}`;
  return answer === 'yes' ? 'Да' : 'Нет';
}

/** Класс цвета ответа: good / bad / mid / na. */
export function answerTone(criterion, answer) {
  if (answer == null) return 'na';
  if (answer === 'na') return 'na';
  if (criterion.type === 'flag') return answer === 'yes' ? 'bad' : 'good';
  if (criterion.type === 'scale') {
    const r = Number(answer) / scaleMax(criterion);
    return r >= 1 ? 'good' : r >= 0.5 ? 'mid' : 'bad';
  }
  return answer === 'yes' ? 'good' : 'bad';
}

export function answerOptions(criterion) {
  const opts = [];
  if (criterion.type === 'scale') for (const s of [...criterion.scale].sort((a, b) => b.value - a.value)) opts.push([String(s.value), `${s.value} — ${s.label}`]);
  else if (criterion.type === 'flag') opts.push(['yes', 'Выявлены'], ['no', 'Нет']);
  else opts.push(['yes', 'Да'], ['no', 'Нет']);
  if (criterion.naAllowed && criterion.type !== 'flag') opts.push(['na', 'N/A — неприменимо']);
  return opts;
}

// Режим оценки: мультиагентный конвейер, один вызов или один вызов ×3 с голосованием.
export const MODES = [
  ['agents', 'Мультиагентный конвейер'],
  ['single', 'Один вызов модели'],
  ['single3', 'Один вызов ×3, голосование'],
];
export const modeSelect = (id, current = 'agents') =>
  `<select id="${id}" name="mode" aria-label="Режим оценки">${MODES.map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
export const readMode = (v) => (v === 'single3' ? { mode: 'single', votes: 3 } : v === 'single' ? { mode: 'single', votes: 1 } : { mode: 'agents', votes: 1 });
export const modeLabel = (ev) => (ev.mode === 'agents' ? 'мультиагентный конвейер' : ev.votes > 1 ? `${ev.votes} прогона, голосование` : '1 вызов модели');

export const scoreTone =(total) => (total == null ? 'na' : total >= 85 ? 'good' : total >= 60 ? 'mid' : 'bad');

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
