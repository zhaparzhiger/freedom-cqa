// Слой данных поверх REST API: кэш сводок и карточек диалогов и модель оценки для экранов.
// Баллы не пересчитываются здесь заново — берутся из result.finalScore (его считает scoring.js на сервере),
// а превью решений по апелляциям считается тем же scoring.js в браузере.
import { api } from './api.js';
import { normalizeTranscript } from './transcript.js';
import { computeScore } from './scoring.js';
import { critState, answerNorm } from './ui.js';

const details = new Map(); // conversation_id → { key, data }
// ключ кэша меняется вместе с оценкой и решениями по апелляциям
const keyOf = (summary) => {
  const e = summary?.evaluation;
  return e ? `${e.id}:${e.total}:${e.appeals}:${e.openAppeals}` : 'none';
};
const keyOfDetail = (data) => {
  const c = data.current;
  return c ? `${c.id}:${c.result.finalScore.total}:${c.result.appeals.length}:${c.result.openAppeals}` : 'none';
};

export const cache = {
  convs: null, // последний ответ GET /api/conversations
};

export async function loadConversations() {
  cache.convs = await api.conversations();
  return cache.convs;
}

/** Карточка диалога из кэша, если она соответствует текущей оценке. */
export function cachedDetail(summary) {
  const d = details.get(summary.conversation_id);
  return d && d.key === keyOf(summary) ? d.data : null;
}

export async function loadDetail(id) {
  const data = await api.conversation(id);
  details.set(id, { key: keyOfDetail(data), data });
  return data;
}

export const forgetDetail = (id) => details.delete(id);

/** Догружает карточки для списка (отпечатки диалогов, поиск по фразе, тепловая карта). */
export function prefetch(summaries, onEach, concurrency = 6) {
  const queue = summaries.filter((s) => !cachedDetail(s));
  let stopped = false;
  const worker = async () => {
    while (queue.length && !stopped) {
      const s = queue.shift();
      try {
        const data = await loadDetail(s.conversation_id);
        if (!stopped) onEach?.(s.conversation_id, data);
      } catch {
        /* одна неудачная карточка не мешает остальным */
      }
    }
  };
  const done = Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { done, stop: () => (stopped = true) };
}

/** Модель оценки для экранов: по каждому критерию — ответ ИИ, финальный ответ, баллы, состояние. */
export function evalModel(ev) {
  if (!ev) return null;
  const r = ev.result;
  const cl = ev.checklist;
  const rows = cl.criteria.map((c, i) => {
    const item = ev.items.find((x) => x.criterionId === c.id) || null;
    const score = r.finalScore.rows.find((x) => x.criterionId === c.id) || null;
    const finalAnswer = r.finalAnswers[c.id];
    const appeals = r.appeals.filter((a) => a.criterionId === c.id);
    return {
      c,
      code: `C${i + 1}`,
      item,
      score,
      aiAnswer: item?.answer,
      finalAnswer,
      changed: item ? finalAnswer !== item.answer : false,
      state: critState(c, finalAnswer),
      norm: answerNorm(c, finalAnswer),
      appeals,
      openAppeal: appeals.find((a) => a.status === 'open') || null,
      pip: pipIndex(item),
    };
  });
  const flags = rows.filter((x) => x.c.type === 'flag' && x.finalAnswer === 'yes');
  return { ev, cl, rows, final: r.finalScore, original: r.originalScore, changed: r.changed.length > 0, flags, openAppeals: r.openAppeals };
}

/** Реплика, к которой привязан критерий: первое доказательство или конец проверенного участка. */
export function pipIndex(item) {
  if (!item || item.answer === 'na') return null;
  if (item.evidence?.length) return item.evidence[0];
  if (item.checkedRange) return item.checkedRange[1];
  return null;
}

/** Превью решения по апелляции: тот же подсчёт, что и на сервере. */
export function previewDecision(ev, criterionId, action, answer) {
  const answers = { ...ev.result.finalAnswers };
  if (action === 'change' && answer != null) answers[criterionId] = answer;
  return { before: ev.result.finalScore.total, after: computeScore(ev.checklist, answers).total, score: computeScore(ev.checklist, answers) };
}

/** Тема разговора: первый запрос клиента из карты диалога (агент контекста) или первая содержательная реплика клиента. */
export function topicOf(conv, ev) {
  const req = ev?.pipeline?.dialogMap?.client_requests?.[0]?.request;
  let t = req || (conv?.transcript || []).find((m) => m.speaker === 'client' && m.text.trim().length > 12)?.text || '';
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return conv?.conversation_id || '';
  t = t[0].toUpperCase() + t.slice(1);
  return t.length > 90 ? `${t.slice(0, 88).replace(/\s+\S*$/, '')}…` : t;
}

/** Реплики с отметками времени и смещением от начала (для отпечатка и плеера). */
export function messages(conv) {
  const msgs = normalizeTranscript(conv);
  // если время не разобралось — равномерная шкала
  msgs.forEach((m, i) => {
    if (m.offsetSec == null || Number.isNaN(m.offsetSec)) m.offsetSec = i * 10;
  });
  return msgs;
}
export const durationOf = (msgs) => Math.max(1, msgs.length ? msgs[msgs.length - 1].offsetSec : 1);
