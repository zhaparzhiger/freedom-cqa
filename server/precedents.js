// «Проверяющий учит систему»: решения по апелляциям становятся прецедентами в промпте следующих оценок.
// Прецедент = фрагмент диалога + ответ ИИ + решение проверяющего + причина. Прецеденты из того же
// диалога, который сейчас оценивается, не используются — иначе модель просто «подсмотрит» ответ.
import { getDb } from './store.js';
import { config } from './env.js';

const db = () => getDb();
const ANS = { yes: 'Да', no: 'Нет', na: 'N/A' };
const label = (a) => ANS[a] || a;

export function precedentsFor(criterionId, excludeConversationId, limit = 4) {
  if (!config.usePrecedents) return [];
  const out = [];
  const resolved = db()
    .appeals.filter((a) => a.status === 'resolved' && a.criterionId === criterionId)
    .sort((a, b) => (a.decision.action === b.decision.action ? Date.parse(b.decision.decidedAt) - Date.parse(a.decision.decidedAt) : a.decision.action === 'change' ? -1 : 1));
  for (const a of resolved) {
    const ev = db().evaluations.find((e) => e.id === a.evaluationId);
    if (!ev || ev.conversationId === excludeConversationId) continue;
    const conv = db().conversations[ev.conversationId];
    const item = ev.items.find((i) => i.criterionId === criterionId);
    if (!conv || !item) continue;
    const lines = [...new Set([...(item.evidence || []), ...(item.checkedRange ? [item.checkedRange[0], item.checkedRange[1]] : [])])]
      .sort((x, y) => x - y)
      .slice(0, 4)
      .map((i) => conv.transcript[i] && `[${i}] ${conv.transcript[i].speaker}: ${String(conv.transcript[i].text).slice(0, 220)}`)
      .filter(Boolean);
    out.push({
      conversationId: conv.conversation_id,
      aiAnswer: item.answer,
      finalAnswer: a.decision.action === 'change' ? a.decision.answer : item.answer,
      action: a.decision.action,
      reason: a.decision.reason,
      comment: a.comment,
      excerpt: lines,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function precedentsText(criterionId, excludeConversationId) {
  const list = precedentsFor(criterionId, excludeConversationId);
  if (!list.length) return '';
  return (
    'Прецеденты проверяющих по этому критерию (решения по апелляциям — следуй этой практике в похожих ситуациях):\n' +
    list
      .map(
        (p, i) =>
          `${i + 1}) Диалог ${p.conversationId}: ИИ поставил «${label(p.aiAnswer)}», проверяющий ${p.action === 'change' ? `ИСПРАВИЛ на «${label(p.finalAnswer)}»` : 'ПОДТВЕРДИЛ'}. Причина: ${p.reason}\n   Фрагмент: ${p.excerpt.join(' | ') || '—'}`,
      )
      .join('\n')
  );
}

/** Для одиночного режима: прецеденты по всем критериям чек-листа одним блоком. */
export function precedentsBlock(checklist, excludeConversationId) {
  const parts = checklist.criteria.map((c) => {
    const t = precedentsText(c.id, excludeConversationId);
    return t ? `[${c.id}] ${t}` : '';
  });
  return parts.filter(Boolean).join('\n\n');
}

/** Кривая обучения: доля апелляций, где ИИ оказался прав, по мере накопления решений. */
export function learningCurve() {
  const resolved = db()
    .appeals.filter((a) => a.status === 'resolved')
    .sort((a, b) => Date.parse(a.decision.decidedAt) - Date.parse(b.decision.decidedAt));
  let confirmed = 0;
  return resolved.map((a, i) => {
    if (a.decision.action === 'confirm') confirmed++;
    return { n: i + 1, agreement: Math.round((confirmed / (i + 1)) * 1000) / 10, action: a.decision.action, at: a.decision.decidedAt };
  });
}
