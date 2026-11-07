// Выгрузка результатов для сдачи организаторам — «Приложение к гайду: Как сдать результаты», формат JSON 1.0.
//   results/dev/results.json  — DEV (65 диалогов)
//   results/prod/results.json — контрольный набор (ровно 10 записей, включая ошибки)
// В выгрузку идут ответы ИИ (исходная оценка системы), а не решения проверяющего: сдаётся точность ИИ-оценки.
import { getDb } from './store.js';
import { latestEvaluation } from './results.js';
import { computeScore } from '../public/js/scoring.js';

export const TEAM_NAME = 'zhalpakov';

// Коды критериев из приложения к гайду. Если в чек-листе у критерия задано поле code — берётся оно.
export const DEFAULT_CODES = {
  c01: 'contact',
  c02: 'discovery',
  c03: 'identification',
  c04: 'consultation',
  c05: 'empathy',
  c06: 'dialogue',
  c07: 'closure',
  c08: 'critical',
};
export const REQUIRED_CODES = Object.values(DEFAULT_CODES);

const codeOf = (c) => (c.code && String(c.code).trim()) || DEFAULT_CODES[c.id] || c.id;

/** Значение по правилам приложения: true / false / null (N/A) или ступень шкалы до учёта веса. */
function valueOf(c, answer) {
  if (answer === 'na' || answer == null) return null;
  if (c.type === 'scale') return Number(answer);
  return answer === 'yes';
}

/** Номера реплик с 1 по исходному массиву транскрипта (у нас внутри — с 0). */
function turnsOf(item, total) {
  let idx = item.evidence?.length ? item.evidence : item.checkedRange ? [item.checkedRange[0], item.checkedRange[1]] : [];
  idx = [...new Set(idx)].filter((i) => Number.isInteger(i) && i >= 0 && i < total).sort((a, b) => a - b);
  return idx.map((i) => i + 1);
}

// Внутри системы реплики нумеруются с 0, а в сдаче — с 1. Ссылки вида [9], [0, 4], [3–11] в тексте объяснения
// сдвигаем на единицу, чтобы текст совпадал с evidence_turns.
const shiftRefs = (text) =>
  String(text || '').replace(/\[(\d+(?:\s*[,–—-]\s*\d+)*)\]/g, (_, inner) => `[${inner.replace(/\d+/g, (n) => String(Number(n) + 1))}]`);

function modelsUsed(evs) {
  const names = new Set();
  for (const ev of evs) for (const m of String(ev.model || '').split('+')) if (m.trim()) names.add(m.trim());
  return [...names];
}

const errorRow = (id, error) => ({ conversation_id: id, status: 'error', criteria: [], score: null, error });

/** Собирает объект results.json для набора диалогов. */
export function buildResults({ group, ids } = {}) {
  const db = getDb();
  let convs = Object.values(db.conversations);
  if (group) convs = convs.filter((c) => c.group === group);
  if (ids?.length) convs = ids.map((id) => db.conversations[id] || { conversation_id: id, missing: true });
  convs.sort((a, b) => String(a.conversation_id).localeCompare(String(b.conversation_id), 'ru', { numeric: true }));

  const used = [];
  const results = convs.map((conv) => {
    if (conv.missing) return errorRow(conv.conversation_id, 'Диалог не загружен в систему');
    const ev = latestEvaluation(conv.conversation_id);
    if (!ev) return errorRow(conv.conversation_id, conv.lastError || 'Диалог не оценён');
    used.push(ev);
    const cl = ev.checklist;
    const answers = Object.fromEntries(ev.items.map((i) => [i.criterionId, i.answer]));
    const criteria = [];
    for (const c of cl.criteria) {
      const item = ev.items.find((i) => i.criterionId === c.id);
      if (!item) continue;
      criteria.push({
        criterion_id: codeOf(c),
        value: valueOf(c, item.answer),
        rationale: shiftRefs(item.explanation),
        evidence_turns: turnsOf(item, conv.transcript.length),
      });
    }
    const missing = REQUIRED_CODES.filter((code) => !criteria.some((x) => x.criterion_id === code));
    if (missing.length) return errorRow(conv.conversation_id, `Оценка без критериев: ${missing.join(', ')}`);
    const score = computeScore(cl, answers);
    const critical = criteria.find((x) => x.criterion_id === 'critical');
    return {
      conversation_id: conv.conversation_id,
      status: 'ok',
      criteria: criteria.filter((x) => REQUIRED_CODES.includes(x.criterion_id)),
      score: { final_score: score.total, critical_flag: critical ? critical.value === true : score.grossError },
    };
  });

  const names = modelsUsed(used);
  return {
    schema_version: '1.0',
    team_name: TEAM_NAME,
    model: { mode: 'external_api', name: names.length ? names.join(', ') : 'gemini-3.5-flash-lite' },
    results,
  };
}

/** Проверка по правилам приложения. Возвращает список проблем (пустой — файл готов к сдаче). */
export function validateResults(doc, { expectedCount } = {}) {
  const problems = [];
  if (doc.schema_version !== '1.0') problems.push('schema_version должен быть "1.0"');
  if (!doc.team_name) problems.push('нет team_name');
  if (!doc.model?.name || !['local', 'external_api', 'hybrid'].includes(doc.model?.mode)) problems.push('model: нужны mode (local / external_api / hybrid) и name');
  if (!Array.isArray(doc.results)) return [...problems, 'results должен быть массивом'];
  if (expectedCount != null && doc.results.length !== expectedCount) problems.push(`записей ${doc.results.length}, ожидается ${expectedCount}`);
  const seen = new Set();
  const scaleSteps = { consultation: [0, 5, 10, 15, 20], dialogue: [0, 4, 7, 10] };
  const nullable = new Set(['discovery', 'identification', 'consultation', 'closure']);
  for (const r of doc.results) {
    const id = r.conversation_id;
    if (!id) problems.push('запись без conversation_id');
    if (seen.has(id)) problems.push(`${id}: повторяющийся ID`);
    seen.add(id);
    if (r.status === 'error') {
      if (r.criteria?.length || r.score !== null || !r.error) problems.push(`${id}: у ошибки должны быть criteria = [], score = null и error`);
      continue;
    }
    if (r.status !== 'ok') problems.push(`${id}: status должен быть ok или error`);
    const codes = (r.criteria || []).map((c) => c.criterion_id);
    for (const code of REQUIRED_CODES) {
      const n = codes.filter((x) => x === code).length;
      if (n !== 1) problems.push(`${id}: критерий ${code} встречается ${n} раз`);
    }
    for (const c of r.criteria || []) {
      const v = c.value;
      if (scaleSteps[c.criterion_id]) {
        if (!(scaleSteps[c.criterion_id].includes(v) || (v === null && nullable.has(c.criterion_id)))) problems.push(`${id}: ${c.criterion_id} = ${v} — недопустимое значение`);
      } else if (!(typeof v === 'boolean' || (v === null && nullable.has(c.criterion_id)))) problems.push(`${id}: ${c.criterion_id} = ${v} — нужно true/false${nullable.has(c.criterion_id) ? '/null' : ''}`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((t) => !Number.isInteger(t) || t < 1)) problems.push(`${id}: ${c.criterion_id} — evidence_turns должны быть целыми с 1`);
      if (typeof c.rationale !== 'string') problems.push(`${id}: ${c.criterion_id} — нет rationale`);
    }
    const fs = r.score?.final_score;
    if (!(fs === null || (typeof fs === 'number' && fs >= 0 && fs <= 100 && Math.round(fs * 100) / 100 === fs))) problems.push(`${id}: final_score ${fs} — нужно число 0–100 с двумя знаками`);
    const crit = (r.criteria || []).find((c) => c.criterion_id === 'critical');
    if (crit && r.score?.critical_flag !== crit.value) problems.push(`${id}: critical_flag не совпадает с критерием critical`);
  }
  return problems;
}

