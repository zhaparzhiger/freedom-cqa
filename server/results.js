// Финальный результат = исходная оценка ИИ + решения проверяющего по апелляциям.
import { computeScore } from '../public/js/scoring.js';
import { getDb } from './store.js';

export function appealsFor(evaluationId) {
  return getDb().appeals.filter((a) => a.evaluationId === evaluationId);
}

/** Собирает итоговую карточку оценки: исходные ответы, решения, финальный балл. */
export function finalResult(ev) {
  const appeals = appealsFor(ev.id);
  const original = Object.fromEntries(ev.items.map((i) => [i.criterionId, i.answer]));
  const final = { ...original };
  for (const a of appeals) {
    if (a.status === 'resolved' && a.decision?.action === 'change') final[a.criterionId] = a.decision.answer;
  }
  const finalScore = computeScore(ev.checklist, final);
  return {
    originalScore: ev.score,
    finalScore,
    finalAnswers: final,
    changed: Object.keys(final).filter((k) => final[k] !== original[k]),
    appeals,
    openAppeals: appeals.filter((a) => a.status === 'open').length,
  };
}

export function latestEvaluation(conversationId) {
  const evs = getDb().evaluations.filter((e) => e.conversationId === conversationId);
  return evs.length ? evs[evs.length - 1] : null;
}
