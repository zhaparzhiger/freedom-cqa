// Оценка одного диалога: N независимых прогонов модели → проверка ответов → голосование → подсчёт баллов кодом.
import { config } from './env.js';
import { generate, costUsd, backendName } from './gemini.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildSchema } from './prompt.js';
import { allowedAnswers, computeScore } from '../public/js/scoring.js';
import { newId, now } from './store.js';
import { runPipeline, markEvidence } from './pipeline.js';

const LOW_CONFIDENCE = 0.7;

/** Приводит ответ модели к допустимому значению критерия или возвращает null. */
export function normalizeAnswer(criterion, raw) {
  const allowed = allowedAnswers(criterion);
  let a = String(raw ?? '').trim().toLowerCase();
  const aliases = { 'да': 'yes', 'нет': 'no', 'n/a': 'na', 'н/д': 'na', 'na': 'na', 'true': 'yes', 'false': 'no' };
  a = aliases[a] || a;
  if (allowed.includes(a)) return a;
  if (criterion.type === 'scale' && a !== '' && !Number.isNaN(Number(a))) {
    // ближайшая ступень шкалы
    const steps = criterion.scale.map((s) => Number(s.value));
    const nearest = steps.reduce((best, s) => (Math.abs(s - Number(a)) < Math.abs(best - Number(a)) ? s : best), steps[0]);
    return String(nearest);
  }
  return null;
}

function parseRun(text, checklist, transcriptLength) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    json = m ? JSON.parse(m[0]) : null;
  }
  if (!json?.criteria) throw new Error('Ответ модели не содержит criteria');
  const inRange = (n) => Number.isInteger(n) && n >= 0 && n < transcriptLength;
  const items = {};
  const problems = [];
  for (const c of checklist.criteria) {
    const r = json.criteria[c.id];
    const answer = r ? normalizeAnswer(c, r.answer) : null;
    if (!answer) {
      problems.push(c.id);
      continue;
    }
    items[c.id] = {
      criterionId: c.id,
      answer,
      analysis: String(r.analysis || ''),
      explanation: String(r.explanation || ''),
      advice: String(r.advice || ''),
      evidence: [...new Set((r.evidence || []).map(Number).filter(inRange))],
      invalidEvidence: (r.evidence || []).map(Number).filter((n) => !inRange(n)),
      checkedRange: inRange(r.checked_from) && inRange(r.checked_to) ? [r.checked_from, r.checked_to] : null,
      confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
    };
  }
  return { items, summary: String(json.summary || ''), problems };
}

function majority(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Голосование по прогонам: большинство по каждому критерию; при равенстве на шкале — медиана. */
function aggregate(runs, checklist) {
  const items = [];
  for (const c of checklist.criteria) {
    const votes = runs.map((r) => r.items[c.id]).filter(Boolean);
    if (!votes.length) continue;
    const ranked = majority(votes.map((v) => v.answer));
    let answer = ranked[0][0];
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1] && c.type === 'scale') {
      const nums = votes.map((v) => (v.answer === 'na' ? null : Number(v.answer))).filter((x) => x !== null).sort((a, b) => a - b);
      if (nums.length) answer = String(nums[Math.floor((nums.length - 1) / 2)]);
    }
    const agreeing = votes.filter((v) => v.answer === answer);
    const best = (agreeing.length ? agreeing : votes).sort((a, b) => b.confidence - a.confidence)[0];
    const agreement = agreeing.length / votes.length;
    const confidence = agreeing.length ? agreeing.reduce((s, v) => s + v.confidence, 0) / agreeing.length : 0;
    items.push({
      ...best,
      answer,
      agreement,
      confidence: Math.round(confidence * agreement * 100) / 100,
      votes: votes.map((v) => v.answer),
      needsReview: agreement < 1 || confidence * agreement < LOW_CONFIDENCE,
    });
  }
  return items;
}

export async function evaluateConversation(record, checklist, { votes = config.votes, model = config.model, mode = config.mode } = {}) {
  const started = Date.now();
  if (mode === 'agents') {
    const p = await runPipeline(record, checklist, { model });
    return finish({ record, checklist, started, model, mode, votes: 1, usage: p.usage, items: p.items, summary: p.summary, raw: p.raw, pipeline: p.pipeline });
  }
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(checklist, record);
  const schema = buildSchema(checklist);
  const total = (record.transcript || []).length;
  const usage = { input: 0, output: 0, calls: 0, models: [] };

  const oneRun = async (i) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await generate({
        system,
        user,
        schema,
        model,
        temperature: votes > 1 ? 0.4 : 0,
        seed: votes > 1 ? 1000 + i * 17 + attempt : undefined,
      });
      usage.input += res.usage.input;
      usage.output += res.usage.output;
      usage.calls += 1;
      if (res.model && !usage.models.includes(res.model)) usage.models.push(res.model);
      const parsed = parseRun(res.text, checklist, total);
      if (!parsed.problems.length || attempt === 1) return { ...parsed, raw: res.text, model: res.model };
    }
  };

  const runs = await Promise.all(Array.from({ length: votes }, (_, i) => oneRun(i)));
  return finish({
    record, checklist, started, votes, usage, mode: 'single',
    model: runs[0]?.model || model,
    items: markEvidence(checklist, aggregate(runs, checklist), record),
    summary: runs.map((r) => r.summary).find(Boolean) || '',
    raw: runs.map((r) => r.raw),
    pipeline: null,
  });
}

function finish({ record, checklist, started, model, mode, votes, usage, items, summary, raw, pipeline }) {
  const missing = checklist.criteria.filter((c) => !items.some((i) => i.criterionId === c.id)).map((c) => c.id);
  const answers = Object.fromEntries(items.map((i) => [i.criterionId, i.answer]));
  return {
    id: newId('ev'),
    conversationId: record.conversation_id,
    checklistId: checklist.id,
    checklistVersion: checklist.version,
    checklist: snapshot(checklist),
    createdAt: now(),
    durationMs: Date.now() - started,
    model: usage.models?.length ? usage.models.join(' + ') : model,
    backend: backendName(),
    mode,
    votes,
    usage,
    costUsd: Math.round(costUsd(usage) * 1e6) / 1e6,
    summary,
    items,
    missing,
    score: computeScore(checklist, answers),
    pipeline,
    raw,
  };
}

export const snapshot = (checklist) => ({
  id: checklist.id,
  name: checklist.name,
  version: checklist.version,
  generalRules: checklist.generalRules || '',
  sections: structuredClone(checklist.sections),
  criteria: structuredClone(checklist.criteria),
});
