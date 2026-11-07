// Сравнение оценок с эталоном: совпадение по критериям и отклонение итогового балла.
//   node scripts/accuracy.js --labels data/labels/dev-reference.json [--run data/runs/flash.json]
// Без --run берётся последняя оценка каждого диалога из базы приложения (с учётом решений по апелляциям).
// Формат эталона: { "p1-ru-001": { "c01": "yes", "c02": "na", "c04": "20", ... }, ... }
import fs from 'node:fs';
import { load, getDb } from '../server/store.js';
import { computeScore } from '../public/js/scoring.js';
import { finalResult, latestEvaluation } from '../server/results.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.labels) {
  console.error('Укажите --labels <файл эталона>');
  process.exit(1);
}
const labels = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(args.labels, 'utf8'))).filter(([k]) => !k.startsWith('_')));
load();
const db = getDb();

let predictions; // id → { answers, checklist }
if (args.run) {
  const run = JSON.parse(fs.readFileSync(args.run, 'utf8'));
  predictions = Object.fromEntries(run.map((ev) => [ev.conversationId, { answers: Object.fromEntries(ev.items.map((i) => [i.criterionId, i.answer])), checklist: ev.checklist }]));
} else {
  predictions = {};
  for (const id of Object.keys(labels)) {
    const ev = latestEvaluation(id);
    if (ev) predictions[id] = { answers: finalResult(ev).finalAnswers, checklist: ev.checklist };
  }
}

const perCriterion = {};
const diffs = [];
let totalErr = 0;
let totalN = 0;
for (const [id, truth] of Object.entries(labels)) {
  const p = predictions[id];
  if (!p) continue;
  for (const [cid, t] of Object.entries(truth)) {
    if (cid.startsWith('_')) continue;
    const s = (perCriterion[cid] ||= { n: 0, ok: 0, misses: [] });
    s.n++;
    if (String(p.answers[cid]) === String(t)) s.ok++;
    else s.misses.push(`${id}: эталон ${t}, ИИ ${p.answers[cid]}`);
  }
  const tScore = computeScore(p.checklist, Object.fromEntries(Object.entries(truth).filter(([k]) => !k.startsWith('_')))).total;
  const pScore = computeScore(p.checklist, p.answers).total;
  if (tScore != null && pScore != null) {
    totalErr += Math.abs(tScore - pScore);
    totalN++;
    diffs.push({ id, truth: tScore, ai: pScore, delta: Math.round((pScore - tScore) * 100) / 100 });
  }
}

const all = Object.values(perCriterion).reduce((a, s) => ({ n: a.n + s.n, ok: a.ok + s.ok }), { n: 0, ok: 0 });
console.log(`\nДиалогов в сравнении: ${totalN}`);
console.log(`Совпадение ответов по критериям: ${((all.ok / all.n) * 100).toFixed(1)}% (${all.ok}/${all.n})`);
console.log(`Среднее отклонение итогового балла: ${(totalErr / Math.max(1, totalN)).toFixed(2)} балла\n`);
for (const [cid, s] of Object.entries(perCriterion).sort()) {
  console.log(`${cid}: ${((s.ok / s.n) * 100).toFixed(0).padStart(3)}%  (${s.ok}/${s.n})`);
  if (process.argv.includes("--verbose")) s.misses.forEach((m) => console.log(`      ${m}`));
}
const worst = diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8);
console.log('\nНаибольшие расхождения итога:');
worst.forEach((d) => console.log(`  ${d.id}: эталон ${d.truth}, ИИ ${d.ai} (${d.delta > 0 ? '+' : ''}${d.delta})`));
