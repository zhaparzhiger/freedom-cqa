// HTTP-сервер CQA: статика интерфейса + REST API. Без внешних зависимостей (Node ≥ 20).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './env.js';
import { load, getDb, save, flush, newId, now } from './store.js';
import { evaluateConversation } from './evaluate.js';
import { finalResult, latestEvaluation } from './results.js';
import { fetchGroup, validateRecord, extractRecords, resolveAudio } from './dataset.js';
import { backendName } from './gemini.js';
import { validateChecklist, nextCriterionId } from './checklists.js';
import { allowedAnswers } from '../public/js/scoring.js';
import { createTraining, findTraining, trainingsFor, publicView, startAttempt, operatorMessage, finishAttempt, getAttempt } from './training.js';
import { attachLive } from './live.js';
import { startImpact, getImpactJob, publicImpact, fingerprint, evaluateSmart } from './incremental.js';
import { learningCurve } from './precedents.js';
import { startParity, parityState } from './parity.js';
import { assistantTurn } from './assistant.js';
import { buildResults, validateResults } from './submission.js';
import { criterionAgent, formatMap } from './pipeline.js';
import { formatTranscript } from './prompt.js';

load();
const PUBLIC = path.join(ROOT, 'public');

// ── утилиты ──────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg = 'Не найдено') => new HttpError(404, msg);

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 25 * 1024 * 1024) throw bad('Слишком большой запрос (больше 25 МБ)');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('Тело запроса — не JSON');
  }
}

const db = () => getDb();
const findChecklist = (id) => db().checklists.find((c) => c.id === (id || db().activeChecklistId));

function conversationSummary(conv) {
  const ev = latestEvaluation(conv.conversation_id);
  let evaluation = null;
  if (ev) {
    const fr = finalResult(ev);
    evaluation = {
      id: ev.id,
      createdAt: ev.createdAt,
      checklistId: ev.checklistId,
      checklistName: ev.checklist.name,
      checklistVersion: ev.checklistVersion,
      originalTotal: ev.score.total,
      total: fr.finalScore.total,
      grossError: fr.finalScore.grossError,
      needsReview: ev.items.filter((i) => i.needsReview).length,
      openAppeals: fr.openAppeals,
      appeals: fr.appeals.length,
      changed: fr.changed.length,
    };
  }
  return {
    conversation_id: conv.conversation_id,
    channel: conv.channel,
    language: conv.language,
    group: conv.group,
    turns: conv.transcript.length,
    operatorTurns: conv.transcript.filter((t) => t.speaker === 'operator').length,
    hasAudio: Boolean(conv.audio_url),
    importedAt: conv.importedAt,
    evaluation,
  };
}

function fullEvaluation(ev) {
  if (!ev) return null;
  const { raw, ...rest } = ev;
  return { ...rest, rawAvailable: Boolean(raw?.length), result: finalResult(ev) };
}

function upsertConversations(records, group) {
  let added = 0;
  let updated = 0;
  const errors = [];
  const ids = [];
  for (const r of records) {
    const errs = validateRecord(r);
    if (errs.length) {
      errors.push({ conversation_id: r?.conversation_id || '?', errors: errs });
      continue;
    }
    const exists = Boolean(db().conversations[r.conversation_id]);
    db().conversations[r.conversation_id] = {
      conversation_id: String(r.conversation_id),
      channel: r.channel || 'agent chat',
      language: r.language || '',
      transcript: r.transcript,
      audio_url: r.audio_url || null,
      group: group || r.group || 'UPLOAD',
      importedAt: now(),
    };
    exists ? updated++ : added++;
    ids.push(String(r.conversation_id));
  }
  save();
  return { added, updated, errors, total: records.length, ids };
}

// ── пакетная оценка ─────────────────────────────────────────────────
const jobs = new Map();

const pickMode = (m) => (['single', 'agents'].includes(m) ? m : config.mode);

function startJob({ ids, checklist, votes, mode, smart = false }) {
  const job = {
    id: newId('job'),
    createdAt: now(),
    checklistId: checklist.id,
    checklistName: checklist.name,
    votes,
    mode,
    total: ids.length,
    done: 0,
    failed: 0,
    running: [],
    errors: [],
    costUsd: 0,
    status: 'running',
  };
  jobs.set(job.id, job);
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const conv = db().conversations[id];
      if (!conv) continue;
      job.running.push(id);
      try {
        // один зависший диалог не должен держать всю очередь
        const ev = await Promise.race([
          smart ? evaluateSmart(conv, checklist, { votes, mode }) : evaluateConversation(conv, checklist, { votes, mode }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Превышено время оценки (5 мин) — запустите диалог повторно')), 5 * 60_000)),
        ]);
        db().evaluations.push(ev);
        save();
        job.costUsd += ev.costUsd;
        job.done++;
      } catch (e) {
        job.failed++;
        job.errors.push({ conversation_id: id, error: e.message });
        conv.lastError = e.message;
      } finally {
        job.running = job.running.filter((x) => x !== id);
      }
    }
  };
  Promise.all(Array.from({ length: Math.min(config.concurrency, ids.length) }, worker)).then(() => {
    job.status = 'finished';
    job.finishedAt = now();
    flush();
  });
  return job;
}

// ── экспорт ──────────────────────────────────────────────────────────
function exportRows(group) {
  return Object.values(db().conversations)
    .filter((c) => !group || c.group === group)
    .map((c) => {
      const ev = latestEvaluation(c.conversation_id);
      if (!ev) return { conversation_id: c.conversation_id, channel: c.channel, language: c.language, evaluated: false };
      const fr = finalResult(ev);
      const criteria = Object.fromEntries(
        ev.checklist.criteria.map((cr) => {
          const item = ev.items.find((i) => i.criterionId === cr.id);
          const row = fr.finalScore.rows.find((r) => r.criterionId === cr.id);
          return [
            cr.id,
            {
              name: cr.name,
              answer: fr.finalAnswers[cr.id] ?? null,
              ai_answer: item?.answer ?? null,
              points: row?.effectivePoints ?? null,
              explanation: item?.explanation || '',
              evidence: item?.evidence || [],
            },
          ];
        }),
      );
      return {
        conversation_id: c.conversation_id,
        channel: c.channel,
        language: c.language,
        evaluated: true,
        checklist: `${ev.checklist.name} v${ev.checklistVersion}`,
        model: ev.model,
        total: fr.finalScore.total,
        ai_total: ev.score.total,
        gross_error: fr.finalScore.grossError,
        criteria,
        evaluated_at: ev.createdAt,
      };
    });
}

function toCsv(rows) {
  const criteriaIds = [...new Set(rows.flatMap((r) => Object.keys(r.criteria || {})))];
  const head = ['conversation_id', 'channel', 'language', 'checklist', 'total', 'ai_total', 'gross_error', ...criteriaIds.map((id) => `${id}`), 'model', 'evaluated_at'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [r.conversation_id, r.channel, r.language, r.checklist, r.total, r.ai_total, r.gross_error, ...criteriaIds.map((id) => r.criteria?.[id]?.answer), r.model, r.evaluated_at].map(esc).join(','),
  );
  return '﻿' + [head.join(','), ...lines].join('\n');
}

// ── статистика ───────────────────────────────────────────────────────
function stats() {
  const convs = Object.values(db().conversations);
  const evaluated = convs.map((c) => ({ c, ev: latestEvaluation(c.conversation_id) })).filter((x) => x.ev);
  const totals = evaluated.map((x) => finalResult(x.ev).finalScore.total).filter((t) => t != null);
  const avg = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null);
  const byLanguage = {};
  for (const { c, ev } of evaluated) {
    const t = finalResult(ev).finalScore.total;
    if (t == null) continue;
    (byLanguage[c.language || '—'] ||= []).push(t);
  }
  // частота ответов по критериям активного чек-листа (по совпадающим id)
  const cl = findChecklist();
  const criteria = (cl?.criteria || []).map((cr) => {
    const answers = evaluated.map(({ ev }) => finalResult(ev).finalAnswers[cr.id]).filter((a) => a !== undefined);
    const count = (pred) => answers.filter(pred).length;
    const scored = answers.filter((a) => a !== 'na');
    const ok = cr.type === 'scale' ? scored.filter((a) => Number(a) === Math.max(...cr.scale.map((s) => s.value))).length : count((a) => a === (cr.type === 'flag' ? 'no' : 'yes'));
    return {
      id: cr.id,
      name: cr.name,
      type: cr.type,
      evaluated: answers.length,
      na: count((a) => a === 'na'),
      ok,
      notOk: scored.length - ok,
    };
  });
  // согласие ИИ с проверяющим: доля апелляций, где оценка подтверждена
  const resolved = db().appeals.filter((a) => a.status === 'resolved');
  const allEvals = db().evaluations;
  return {
    conversations: convs.length,
    evaluated: evaluated.length,
    averageTotal: avg(totals),
    byLanguage: Object.fromEntries(Object.entries(byLanguage).map(([k, v]) => [k, { count: v.length, average: avg(v) }])),
    grossErrors: evaluated.filter(({ ev }) => finalResult(ev).finalScore.grossError).length,
    needsReview: evaluated.reduce((s, { ev }) => s + ev.items.filter((i) => i.needsReview).length, 0),
    criteria,
    appeals: {
      total: db().appeals.length,
      open: db().appeals.filter((a) => a.status === 'open').length,
      confirmed: resolved.filter((a) => a.decision.action === 'confirm').length,
      changed: resolved.filter((a) => a.decision.action === 'change').length,
    },
    cost: {
      evaluations: allEvals.length,
      totalUsd: Math.round(allEvals.reduce((s, e) => s + (e.costUsd || 0), 0) * 10000) / 10000,
      perEvaluationUsd: allEvals.length ? Math.round((allEvals.reduce((s, e) => s + (e.costUsd || 0), 0) / allEvals.length) * 1e5) / 1e5 : null,
      avgSeconds: allEvals.length ? Math.round(allEvals.reduce((s, e) => s + e.durationMs, 0) / allEvals.length / 100) / 10 : null,
    },
  };
}

// ── маршруты ─────────────────────────────────────────────────────────
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/meta', () => ({
  model: config.model,
  backend: backendName(),
  votes: config.votes,
  mode: config.mode,
  priceInputPerM: config.priceInputPerM,
  priceOutputPerM: config.priceOutputPerM,
  orgApi: Boolean(config.orgApiUrl),
  activeChecklistId: db().activeChecklistId,
}));

route('GET', '/api/conversations', () => Object.values(db().conversations).map(conversationSummary));

route('GET', '/api/conversations/:id', ({ params }) => {
  const conv = db().conversations[params.id];
  if (!conv) throw notFound('Диалог не найден');
  const evs = db().evaluations.filter((e) => e.conversationId === params.id);
  return {
    conversation: conv,
    evaluations: evs.map((e) => ({ id: e.id, createdAt: e.createdAt, total: e.score.total, checklist: `${e.checklist.name} v${e.checklistVersion}`, model: e.model, votes: e.votes })),
    current: fullEvaluation(evs[evs.length - 1]),
    trainings: trainingsFor(params.id).map((t) => ({ token: t.token, createdAt: t.createdAt, author: t.author, title: t.scenario.title, originalTotal: t.originalTotal, attempts: publicView(t).attempts })),
  };
});

route('DELETE', '/api/conversations/:id', ({ params }) => {
  delete db().conversations[params.id];
  save();
  return { ok: true };
});

route('GET', '/api/evaluations/:id', ({ params }) => {
  const ev = db().evaluations.find((e) => e.id === params.id);
  if (!ev) throw notFound('Оценка не найдена');
  return fullEvaluation(ev);
});

route('GET', '/api/evaluations/:id/raw', ({ params }) => {
  const ev = db().evaluations.find((e) => e.id === params.id);
  if (!ev) throw notFound('Оценка не найдена');
  return { raw: ev.raw || [] };
});

route('POST', '/api/import', async ({ body }) => {
  const groupId = String(body.groupId || '').trim();
  const url = String(body.url || '').trim();
  if (!groupId && !url) throw bad('Укажите group_id или ссылку');
  const data = await fetchGroup(groupId, url || undefined);
  const group = String(body.group || data.dataset_group_id || groupId || 'PROD');
  return { group, ...upsertConversations(data.records || [], group) };
});

route('POST', '/api/upload', ({ body }) => {
  const records = extractRecords(body.payload);
  if (!records.length) throw bad('В файле не найдено ни одной записи диалога');
  return upsertConversations(records, String(body.group || 'UPLOAD'));
});

route('GET', '/api/audio/:id', async ({ params, res }) => {
  const conv = db().conversations[params.id];
  if (!conv?.audio_url) throw notFound('У диалога нет записи');
  const url = await resolveAudio(conv.conversation_id, conv.audio_url);
  res.writeHead(302, { location: url, 'cache-control': 'no-store' });
  res.end();
  return undefined;
});

// чек-листы
route('GET', '/api/checklists', () => ({ activeId: db().activeChecklistId, checklists: db().checklists }));

route('POST', '/api/checklists', ({ body }) => {
  const source = body.cloneFrom ? db().checklists.find((c) => c.id === body.cloneFrom) : body.checklist;
  if (!source) throw bad('Нет данных чек-листа');
  const cl = {
    ...structuredClone(source),
    id: newId('cl'),
    name: body.name || (body.cloneFrom ? `${source.name} (копия)` : source.name),
    version: 1,
    createdAt: now(),
    updatedAt: now(),
  };
  validateChecklist(cl);
  db().checklists.push(cl);
  save();
  return cl;
});

route('PUT', '/api/checklists/:id', ({ params, body }) => {
  const idx = db().checklists.findIndex((c) => c.id === params.id);
  if (idx < 0) throw notFound('Чек-лист не найден');
  const prev = db().checklists[idx];
  const next = {
    ...prev,
    name: body.name ?? prev.name,
    generalRules: body.generalRules ?? prev.generalRules,
    sections: body.sections ?? prev.sections,
    criteria: (body.criteria ?? prev.criteria).map((c, i, all) => ({ ...c, id: c.id || nextCriterionId(all) })),
    version: prev.version + 1,
    updatedAt: now(),
  };
  validateChecklist(next);
  db().checklists[idx] = next;
  save();
  return next;
});

// превью влияния изменений чек-листа (до сохранения) и применение посчитанного без повторных вызовов ИИ
route('POST', '/api/checklists/:id/impact', ({ params, body }) => {
  const draft = validateChecklist({ ...structuredClone(body.draft || {}), id: params.id });
  return publicImpact(startImpact(params.id, draft));
});

route('GET', '/api/impact/:id', ({ params }) => {
  const job = getImpactJob(params.id);
  if (!job) throw notFound('Расчёт влияния не найден');
  return publicImpact(job);
});

route('POST', '/api/checklists/:id/apply-impact', ({ params, body }) => {
  const idx = db().checklists.findIndex((c) => c.id === params.id);
  if (idx < 0) throw notFound('Чек-лист не найден');
  const prev = db().checklists[idx];
  const draft = validateChecklist({ ...prev, ...structuredClone(body.draft || {}), id: prev.id, version: prev.version + 1, updatedAt: now() });
  const job = body.jobId ? getImpactJob(body.jobId) : null;
  db().checklists[idx] = draft;
  db().activeChecklistId = draft.id;
  let applied = 0;
  // посчитанное в превью применяется только к тому же самому содержимому чек-листа
  if (job?.status === 'finished' && !job.summary?.needsFull && job.fingerprint === fingerprint(draft)) {
    for (const ev of job.evaluations) {
      ev.checklistVersion = draft.version;
      ev.checklist = { ...ev.checklist, version: draft.version };
      db().evaluations.push(ev);
      applied++;
    }
  }
  save();
  return { checklist: draft, applied, total: job?.total ?? 0 };
});

route('POST', '/api/checklists/:id/activate', ({ params }) => {
  if (!db().checklists.some((c) => c.id === params.id)) throw notFound('Чек-лист не найден');
  db().activeChecklistId = params.id;
  save();
  return { ok: true };
});

route('DELETE', '/api/checklists/:id', ({ params }) => {
  if (db().activeChecklistId === params.id) throw bad('Нельзя удалить активный чек-лист');
  db().checklists = db().checklists.filter((c) => c.id !== params.id);
  save();
  return { ok: true };
});

// оценка
route('POST', '/api/evaluate', async ({ body }) => {
  const conv = db().conversations[body.conversationId];
  if (!conv) throw notFound('Диалог не найден');
  const checklist = findChecklist(body.checklistId);
  if (!checklist) throw notFound('Чек-лист не найден');
  const votes = Math.max(1, Math.min(5, Number(body.votes) || config.votes));
  const ev = await evaluateConversation(conv, checklist, { votes, mode: pickMode(body.mode) });
  db().evaluations.push(ev);
  save();
  return fullEvaluation(ev);
});

route('POST', '/api/jobs', ({ body }) => {
  const checklist = findChecklist(body.checklistId);
  if (!checklist) throw notFound('Чек-лист не найден');
  let ids = Array.isArray(body.conversationIds) && body.conversationIds.length ? body.conversationIds : Object.keys(db().conversations);
  if (body.group) ids = ids.filter((id) => db().conversations[id]?.group === body.group);
  if (body.onlyMissing) ids = ids.filter((id) => {
    const ev = latestEvaluation(id);
    return !ev || ev.checklistId !== checklist.id || ev.checklistVersion !== checklist.version;
  });
  if (!ids.length) throw bad('Нет диалогов для оценки');
  const votes = Math.max(1, Math.min(5, Number(body.votes) || config.votes));
  return startJob({ ids, checklist, votes, mode: pickMode(body.mode), smart: Boolean(body.onlyMissing) && body.smart !== false });
});

route('GET', '/api/jobs/:id', ({ params }) => {
  const job = jobs.get(params.id);
  if (!job) throw notFound('Задача не найдена');
  return job;
});

route('GET', '/api/jobs', () => [...jobs.values()].slice(-5).reverse());

// апелляции
route('GET', '/api/appeals', ({ query }) => {
  const status = query.get('status');
  return db()
    .appeals.filter((a) => !status || a.status === status)
    .map((a) => {
      const ev = db().evaluations.find((e) => e.id === a.evaluationId);
      const cr = ev?.checklist.criteria.find((c) => c.id === a.criterionId);
      const item = ev?.items.find((i) => i.criterionId === a.criterionId);
      return { ...a, criterionName: cr?.name, criterionType: cr?.type, aiAnswer: item?.answer, conversationId: ev?.conversationId };
    })
    .reverse();
});

route('POST', '/api/appeals', ({ body }) => {
  const ev = db().evaluations.find((e) => e.id === body.evaluationId);
  if (!ev) throw notFound('Оценка не найдена');
  if (!ev.checklist.criteria.some((c) => c.id === body.criterionId)) throw bad('Критерий не найден в оценке');
  const comment = String(body.comment || '').trim();
  if (!comment) throw bad('Добавьте комментарий к апелляции');
  if (db().appeals.some((a) => a.evaluationId === ev.id && a.criterionId === body.criterionId && a.status === 'open'))
    throw bad('По этому критерию уже есть открытая апелляция');
  const appeal = {
    id: newId('ap'),
    evaluationId: ev.id,
    criterionId: body.criterionId,
    comment,
    author: String(body.author || 'Сотрудник'),
    proposedAnswer: body.proposedAnswer ?? null,
    createdAt: now(),
    status: 'open',
    decision: null,
  };
  db().appeals.push(appeal);
  save();
  return appeal;
});

route('POST', '/api/appeals/:id/decision', ({ params, body }) => {
  const appeal = db().appeals.find((a) => a.id === params.id);
  if (!appeal) throw notFound('Апелляция не найдена');
  if (appeal.status !== 'open') throw bad('Апелляция уже рассмотрена');
  const ev = db().evaluations.find((e) => e.id === appeal.evaluationId);
  const cr = ev.checklist.criteria.find((c) => c.id === appeal.criterionId);
  const action = body.action === 'change' ? 'change' : 'confirm';
  const reason = String(body.reason || '').trim();
  if (!reason) throw bad('Укажите причину решения');
  let answer = null;
  if (action === 'change') {
    answer = String(body.answer ?? '');
    if (!allowedAnswers(cr).includes(answer)) throw bad(`Недопустимое значение для критерия: ${answer}`);
    const current = ev.items.find((i) => i.criterionId === cr.id)?.answer;
    if (answer === current) throw bad('Новая оценка совпадает с исходной — выберите «Подтвердить»');
  }
  appeal.status = 'resolved';
  appeal.decision = { action, answer, reason, reviewer: String(body.reviewer || 'Проверяющий'), decidedAt: now() };
  save();
  return { appeal, evaluation: fullEvaluation(ev) };
});

// ИИ-ассистент администратора
route('POST', '/api/assistant', async ({ body }) => {
  const history = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && typeof m.text === 'string').map((m) => ({ role: m.role, text: m.text.slice(0, 2000) }));
  if (!history.length || history[history.length - 1].role !== 'user') throw bad('Нет вопроса');
  return assistantTurn(history, body.context || {});
});

// тест языковой честности
route('GET', '/api/parity', () => parityState());
route('POST', '/api/parity', ({ body }) => startParity({ n: body.n, languages: body.languages }));

// обучение на решениях проверяющих
route('GET', '/api/learning', () => {
  const resolved = db().appeals.filter((a) => a.status === 'resolved');
  const byCriterion = {};
  for (const a of resolved) (byCriterion[a.criterionId] ||= { confirm: 0, change: 0 })[a.decision.action]++;
  return { enabled: config.usePrecedents, curve: learningCurve(), byCriterion, lastReplay: db().lastReplay || null };
});

// перепроверка: для каждой исправленной апелляции заново оцениваем этот критерий с прецедентами
// (кроме прецедента из того же диалога) и смотрим, совпадает ли теперь ИИ с проверяющим
route('POST', '/api/learning/replay', async () => {
  const changed = db().appeals.filter((a) => a.status === 'resolved' && a.decision.action === 'change');
  if (!changed.length) throw bad('Пока нет исправленных апелляций — исправьте хотя бы одну оценку');
  const details = await Promise.all(
    changed.map(async (a) => {
      const ev = db().evaluations.find((e) => e.id === a.evaluationId);
      const conv = ev && db().conversations[ev.conversationId];
      const cl = ev?.checklist;
      const c = cl?.criteria.find((x) => x.id === a.criterionId);
      if (!c || !conv) return null;
      const transcript = formatTranscript(conv);
      const mapText = ev.pipeline?.dialogMap ? formatMap(ev.pipeline.dialogMap) : '';
      try {
        const r = await criterionAgent({ ...cl, generalRules: cl.generalRules ?? findChecklist(ev.checklistId)?.generalRules }, c, conv, transcript, mapText, config.model);
        const before = ev.items.find((i) => i.criterionId === c.id)?.answer;
        return { conversationId: conv.conversation_id, criterionId: c.id, criterionName: c.name, before, reviewer: a.decision.answer, now: r.item.answer, learned: r.item.answer === a.decision.answer };
      } catch (e) {
        return { conversationId: conv.conversation_id, criterionId: c.id, error: e.message };
      }
    }),
  );
  const ok = details.filter((d) => d && !d.error);
  db().lastReplay = { at: now(), total: ok.length, learned: ok.filter((d) => d.learned).length, details: ok };
  save();
  return db().lastReplay;
});

// тренажёр оператора
const trainingOr404 = (token) => {
  const t = findTraining(token);
  if (!t) throw notFound('Тренировка не найдена или ссылка устарела');
  return t;
};

route('POST', '/api/trainings', async ({ body }) => {
  const t = await createTraining({ evaluationId: body.evaluationId, author: body.author });
  return { token: t.token, path: '/train/' + t.token, mistakes: t.mistakes.length, title: t.scenario.title };
});

route('GET', '/api/train/:token', ({ params }) => publicView(trainingOr404(params.token)));

route('POST', '/api/train/:token/attempts', ({ params, body }) => {
  const t = trainingOr404(params.token);
  return startAttempt(t, body.mode === 'voice' ? 'voice' : 'text');
});

route('GET', '/api/train/:token/attempts/:aid', ({ params }) => getAttempt(trainingOr404(params.token), params.aid));

route('POST', '/api/train/:token/attempts/:aid/message', async ({ params, body }) => {
  const t = trainingOr404(params.token);
  const a = getAttempt(t, params.aid);
  if (a.finishedAt) throw bad('Попытка уже завершена');
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) throw bad('Пустое сообщение');
  return operatorMessage(t, a, text);
});

route('POST', '/api/train/:token/attempts/:aid/finish', async ({ params }) => {
  const t = trainingOr404(params.token);
  const a = getAttempt(t, params.aid);
  if (a.finishedAt) return { attempt: a, originalTotal: t.originalTotal };
  return finishAttempt(t, a);
});

route('GET', '/api/stats', () => stats());

// результаты для сдачи организаторам (формат JSON 1.0 из приложения к гайду)
route('GET', '/api/results', ({ query, res }) => {
  const doc = buildResults({ group: query.get('group') || '' });
  const problems = validateResults(doc);
  if (query.get('download')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="results.json"' });
    res.end(JSON.stringify(doc, null, 2));
    return undefined;
  }
  return { problems, count: doc.results.length, errors: doc.results.filter((r) => r.status === 'error').length, doc };
});

route('GET', '/api/export', ({ query, res }) => {
  const rows = exportRows(query.get('group') || '');
  if (query.get('format') === 'csv') {
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="cqa-results-${Date.now()}.csv"`,
    });
    res.end(toCsv(rows));
    return undefined;
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="cqa-results-${Date.now()}.json"`,
  });
  res.end(JSON.stringify(rows, null, 2));
  return undefined;
});

// ── статика ──────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Запрещено' });
  if (pathname.startsWith('/train/')) file = path.join(PUBLIC, 'train.html');
  else if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // CORS: интерфейс можно встроить как HTML-компонент в другую систему (Dynamics 365)
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.end();
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return send(res, 404, { error: 'Метод не найден' });
  const m = url.pathname.match(r.re);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  try {
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const out = await r.handler({ req, res, params, body, query: url.searchParams });
    if (out !== undefined) send(res, 200, out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
  }
});

attachLive(server);

server.listen(config.port, () => {
  console.log(`CQA: http://localhost:${config.port}  · модель ${config.model} · ${backendName()}`);
});

process.on('SIGINT', () => {
  flush();
  process.exit(0);
});
