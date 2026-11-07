// Частичный пересчёт при изменении чек-листа и превью влияния до сохранения.
//
// Для каждого диалога сравниваем новый чек-лист с тем, по которому он был оценён:
//   • изменился только вес        → ИИ не нужен, баллы пересчитываются кодом;
//   • изменились формулировка, тип, шкала, N/A, уточнение или критерий новый
//                                  → агент перепроверяет ТОЛЬКО этот критерий;
//   • удалён критерий              → просто выпадает из итога;
//   • изменились общие правила     → честно нужна полная переоценка (они влияют на все критерии).
// Остальные критерии и «карта диалога» берутся из прошлой оценки (кэш).
import crypto from 'node:crypto';
import { config } from './env.js';
import { getDb, newId, now } from './store.js';
import { computeScore } from '../public/js/scoring.js';
import { contextAgent, formatMap, criterionAgent, validate, markEvidence } from './pipeline.js';
import { formatTranscript } from './prompt.js';
import { snapshot, evaluateConversation } from './evaluate.js';
import { costUsd, backendName } from './gemini.js';
import { latestEvaluation, finalResult } from './results.js';

const db = () => getDb();

/** Поля критерия, которые видит модель. Вес сюда не входит: он влияет только на арифметику. */
const semantic = (c) => JSON.stringify([c.name, c.type, c.rule, c.hint || '', Boolean(c.naAllowed), c.naCondition || '', (c.scale || []).map((s) => [Number(s.value), s.label])]);

export function diffChecklists(oldCl, newCl, oldRules = null) {
  const oldById = Object.fromEntries(oldCl.criteria.map((c) => [c.id, c]));
  const newIds = new Set(newCl.criteria.map((c) => c.id));
  const out = { unchanged: [], weightOnly: [], changed: [], added: [], removed: [], rulesChanged: false };
  for (const c of newCl.criteria) {
    const o = oldById[c.id];
    if (!o) out.added.push(c.id);
    else if (semantic(o) !== semantic(c)) out.changed.push(c.id);
    else if (Number(o.weight) !== Number(c.weight) || o.section !== c.section) out.weightOnly.push(c.id);
    else out.unchanged.push(c.id);
  }
  out.removed = oldCl.criteria.filter((c) => !newIds.has(c.id)).map((c) => c.id);
  if (oldRules !== null) out.rulesChanged = (oldRules || '').trim() !== (newCl.generalRules || '').trim();
  return out;
}

/** Отпечаток содержимого чек-листа — чтобы применить посчитанное превью только к тому же самому чек-листу. */
export const fingerprint = (cl) =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify([cl.generalRules || '', cl.sections, cl.criteria.map((c) => [c.id, c.weight, c.section, semantic(c)])]))
    .digest('hex');

/** Новая оценка диалога по новому чек-листу: пересчитываются только изменённые и новые критерии. */
export async function evaluateIncremental(record, newCl, baseEv, diff, { model = config.model } = {}) {
  const started = Date.now();
  const recompute = [...diff.changed, ...diff.added];
  const usage = { input: 0, output: 0, calls: 0, models: [] };
  const track = (res) => {
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.calls++;
    if (res.model && !usage.models.includes(res.model)) usage.models.push(res.model);
  };
  const transcript = formatTranscript(record);
  let map = baseEv.pipeline?.dialogMap;
  const steps = [];
  if (recompute.length && !map) {
    const ctx = await contextAgent(record, transcript, model);
    track(ctx.res);
    map = ctx.map;
    steps.push({ agent: 'context', title: 'Агент контекста', ms: ctx.res.ms, tokens: ctx.res.usage.input + ctx.res.usage.output, output: map });
  }
  const mapText = map ? formatMap(map) : '';

  const reused = baseEv.items.filter((i) => newCl.criteria.some((c) => c.id === i.criterionId) && !recompute.includes(i.criterionId));
  const fresh = await Promise.all(
    recompute.map(async (id) => {
      const c = newCl.criteria.find((x) => x.id === id);
      const r = await criterionAgent(newCl, c, record, transcript, mapText, model);
      track(r.res);
      steps.push({ agent: 'criterion', criterionId: id, title: `Агент «${c.name}»`, ms: r.res.ms, tokens: r.res.usage.input + r.res.usage.output, answer: r.item.answer, confidence: r.item.confidence });
      return { ...r.item, agreement: 1, votes: [r.item.answer], needsReview: r.item.confidence < 0.7 };
    }),
  );
  markEvidence(newCl, fresh, record);
  const items = newCl.criteria.map((c) => fresh.find((i) => i.criterionId === c.id) || reused.find((i) => i.criterionId === c.id)).filter(Boolean);
  const notes = validate(newCl, Object.fromEntries(fresh.map((i) => [i.criterionId, i])), record);
  steps.push({ agent: 'validator', title: 'Валидатор правил (код)', ms: 0, tokens: 0, notes });
  steps.unshift({
    agent: 'incremental',
    title: 'Частичный пересчёт',
    reused: reused.map((i) => i.criterionId),
    recomputed: recompute,
    weightOnly: diff.weightOnly,
    removed: diff.removed,
    baseEvaluationId: baseEv.id,
  });
  const answers = Object.fromEntries(items.map((i) => [i.criterionId, i.answer]));
  return {
    id: newId('ev'),
    conversationId: record.conversation_id,
    checklistId: newCl.id,
    checklistVersion: newCl.version,
    checklist: snapshot(newCl),
    createdAt: now(),
    durationMs: Date.now() - started,
    model: usage.models.length ? usage.models.join(' + ') : model,
    backend: backendName(),
    mode: 'incremental',
    votes: 1,
    usage,
    costUsd: Math.round(costUsd(usage) * 1e6) / 1e6,
    summary: baseEv.summary,
    items,
    missing: [],
    score: computeScore(newCl, answers),
    pipeline: { mode: 'incremental', steps, dialogMap: map || null },
    raw: [],
    parentEvaluationId: baseEv.id,
  };
}

/** Оценка диалога по чек-листу «как выгоднее»: частично, если есть база с теми же общими правилами, иначе полностью. */
export async function evaluateSmart(record, cl, { mode, votes } = {}) {
  const base = latestEvaluation(record.conversation_id);
  if (base && base.checklist.criteria.length) {
    // в старых оценках общих правил в снимке нет — тогда считаем их прежними
    const rules = base.checklist.generalRules ?? cl.generalRules;
    const diff = diffChecklists(base.checklist, cl, rules);
    if (!diff.rulesChanged && base.checklistId === cl.id) return evaluateIncremental(record, cl, base, diff);
  }
  return evaluateConversation(record, cl, { mode, votes });
}

// ── превью влияния ────────────────────────────────────────────────────
const impactJobs = new Map();
export const getImpactJob = (id) => impactJobs.get(id);

export function startImpact(checklistId, draft) {
  const current = db().checklists.find((c) => c.id === checklistId);
  if (!current) throw Object.assign(new Error('Чек-лист не найден'), { status: 404 });
  const cl = { ...structuredClone(draft), id: current.id, version: current.version + 1 };
  const rulesChanged = (current.generalRules || '').trim() !== (cl.generalRules || '').trim();
  const convs = Object.values(db().conversations)
    .map((c) => ({ c, ev: latestEvaluation(c.conversation_id) }))
    .filter((x) => x.ev);
  const job = {
    id: newId('imp'),
    checklistId,
    fingerprint: fingerprint(cl),
    status: 'running',
    rulesChanged,
    total: convs.length,
    done: 0,
    failed: 0,
    costUsd: 0,
    calls: 0,
    startedAt: Date.now(),
    summary: null,
    rows: [],
    evaluations: [], // кэш посчитанных оценок — применяются без повторных вызовов ИИ
    diff: diffChecklists(current, cl),
  };
  impactJobs.set(job.id, job);
  if (rulesChanged) {
    job.status = 'finished';
    job.summary = { needsFull: true };
    return job;
  }
  const queue = [...convs];
  const worker = async () => {
    while (queue.length) {
      const { c, ev } = queue.shift();
      try {
        const d = diffChecklists(ev.checklist, cl);
        const next = await evaluateIncremental(c, cl, ev, d);
        // решения по апелляциям сохраняются для критериев, которые не пересчитывались
        const before = finalResult(ev).finalScore;
        const kept = finalResult(ev).finalAnswers;
        const recomputed = new Set([...d.changed, ...d.added]);
        const answers = Object.fromEntries(next.items.map((i) => [i.criterionId, recomputed.has(i.criterionId) ? i.answer : kept[i.criterionId] ?? i.answer]));
        const after = computeScore(cl, answers);
        job.rows.push({
          conversationId: c.conversation_id,
          language: c.language,
          before: before.total,
          after: after.total,
          delta: before.total != null && after.total != null ? Math.round((after.total - before.total) * 100) / 100 : null,
          grossBefore: before.grossError,
          grossAfter: after.grossError,
          recomputed: [...recomputed],
        });
        job.evaluations.push(next);
        job.costUsd += next.costUsd;
        job.calls += next.usage.calls;
        job.done++;
      } catch (e) {
        job.failed++;
      }
    }
  };
  Promise.all(Array.from({ length: Math.min(config.concurrency + 1, convs.length || 1) }, worker)).then(() => {
    const valid = job.rows.filter((r) => r.before != null && r.after != null);
    const avg = (k) => (valid.length ? Math.round((valid.reduce((s, r) => s + r[k], 0) / valid.length) * 100) / 100 : null);
    job.summary = {
      needsFull: false,
      affected: job.rows.filter((r) => r.delta !== 0 || r.grossBefore !== r.grossAfter).length,
      avgBefore: avg('before'),
      avgAfter: avg('after'),
      worse: valid.filter((r) => r.delta < 0).length,
      better: valid.filter((r) => r.delta > 0).length,
      same: valid.filter((r) => r.delta === 0).length,
      grossNew: job.rows.filter((r) => r.grossAfter && !r.grossBefore).length,
      grossGone: job.rows.filter((r) => !r.grossAfter && r.grossBefore).length,
      seconds: Math.round((Date.now() - job.startedAt) / 100) / 10,
    };
    job.rows.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
    job.status = 'finished';
  });
  return job;
}

export const publicImpact = (job) => {
  const { evaluations, ...rest } = job;
  return rest;
};
