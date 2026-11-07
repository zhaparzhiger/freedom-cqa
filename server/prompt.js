// Сборка промпта и JSON-схемы ответа из конфигурации чек-листа.
// Критерии берутся из настроек: новый или изменённый критерий сразу попадает в промпт и схему.
import { allowedAnswers } from '../public/js/scoring.js';
import { normalizeTranscript, roleName } from '../public/js/transcript.js';
import { precedentsBlock } from './precedents.js';

export const SYSTEM_PROMPT = `Ты — старший специалист отдела контроля качества (CQA) брокерской компании Freedom Broker.
Ты оцениваешь работу ОПЕРАТОРА (живого сотрудника поддержки) в одном диалоге строго по выданному чек-листу.

Правила оценки:
1. Оценивай только реплики с ролью «Оператор». Реплики бота и системы — контекст: они показывают, что клиент уже сообщил до подключения оператора, и что произошло в чате (эскалация, подтверждение личности, закрытие чата, обрыв связи). Ошибки бота оператору не засчитываются.
2. Следуй формулировкам критериев и уточнениям буквально. Не добавляй требований, которых нет в чек-листе.
2а. Каждый критерий отвечает на свой отдельный вопрос. Одно нарушение не снижает автоматически другие критерии: если по правилу конкретного критерия всё выполнено, ставь максимум, даже если в диалоге есть другие ошибки.
3. N/A ставь только если он разрешён для критерия И условие неприменимости действительно выполнено. Иначе выбери «Да»/«Нет» или ступень шкалы.
4. «Нет» — действие было нужно, но оператор его пропустил или выполнил неправильно.
5. Для шкалы выбери ровно одну ступень из списка — ту, чьё описание точнее всего подходит.
6. Сначала заполни analysis: коротко перечисли факты из диалога, относящиеся к критерию. Ответ answer должен следовать из analysis.
7. evidence — номера реплик [N], на которых основан вывод (обычно 1–3). Если действие пропущено, укажи в checked_from и checked_to участок разговора, где оно ожидалось. Для N/A объясни, какое условие неприменимости выполнено.
8. explanation — 1–2 предложения на русском языке в стиле: «Завершение — Нет. После ответа на вопрос оператор закрыл чат без прощания. Основание — последняя реплика оператора [11] и сообщение о закрытии чата [12].» Цитаты из диалога приводи на языке оригинала.
9. advice — если ответ не максимальный (Нет или не верхняя ступень шкалы), одной фразой подскажи оператору, что нужно было сделать или написать. Иначе оставь пустую строку. Для критерия грубых ошибок при «Да» назови нарушение.
10. confidence — твоя уверенность в ответе от 0 до 1. Ставь ниже 0.7, если ситуация пограничная или правило допускает два прочтения.
11. Диалоги бывают на русском, казахском и английском. Оценивай одинаково, независимо от языка.
12. Звонки — автоматическая расшифровка речи с ошибками распознавания. Оценивай по смыслу, не снижай баллы за искажённые слова. Пометка «[Имя скрыто]» означает, что имя было названо.`;

const TYPE_LABEL = {
  yesno: 'Да / Нет',
  scale: 'шкала',
  flag: 'флаг Да / Нет (без баллов)',
};

export function describeCriterion(c, sectionsById) {
  const lines = [];
  const answers = allowedAnswers(c);
  lines.push(`[${c.id}] ${c.name}${c.section && sectionsById[c.section] ? ` — раздел «${sectionsById[c.section]}»` : ''}`);
  lines.push(`  Тип: ${TYPE_LABEL[c.type] || c.type}${c.type !== 'flag' ? ` · вес ${c.weight}` : ''}`);
  if (c.rule) lines.push(`  Правило: ${c.rule}`);
  if (c.type === 'scale') {
    lines.push('  Ступени шкалы:');
    for (const s of [...c.scale].sort((a, b) => b.value - a.value)) lines.push(`    ${s.value} — ${s.label}`);
  }
  lines.push(c.naAllowed && c.type !== 'flag' ? `  N/A допускается, только если: ${c.naCondition || 'критерий неприменим'}` : '  N/A не допускается.');
  if (c.hint) lines.push(`  Уточнение: ${c.hint}`);
  lines.push(`  Допустимые значения answer: ${answers.map((a) => `"${a}"`).join(', ')}`);
  return lines.join('\n');
}

export function formatTranscript(record) {
  return normalizeTranscript(record)
    .map((t) => `[${t.index}] ${t.label} ${roleName(t.speaker)}: ${String(t.text || '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

export function buildUserPrompt(checklist, record) {
  const sectionsById = Object.fromEntries((checklist.sections || []).map((s) => [s.id, s.name]));
  const parts = [];
  parts.push(`ЧЕК-ЛИСТ «${checklist.name}» (версия ${checklist.version})`);
  if (checklist.generalRules?.trim()) parts.push(`Общие правила чек-листа:\n${checklist.generalRules.trim()}`);
  parts.push(`Критерии:\n${checklist.criteria.map((c) => describeCriterion(c, sectionsById)).join('\n\n')}`);
  const prec = precedentsBlock(checklist, record.conversation_id);
  if (prec) parts.push(`Прецеденты проверяющих (решения по апелляциям):
${prec}`);
  parts.push(
    `ДИАЛОГ ${record.conversation_id} · канал: ${record.channel} · язык: ${record.language}\n` +
      'Номер в квадратных скобках — ссылка на реплику для evidence.\n' +
      formatTranscript(record),
  );
  parts.push(
    'Оцени оператора по каждому критерию чек-листа и верни JSON по схеме. ' +
      'В поле summary — 1–2 предложения на русском: суть обращения клиента и главный вывод о работе оператора.',
  );
  return parts.join('\n\n');
}

/** Схема ответа по одному критерию: сначала рассуждение, потом ответ из допустимых значений. */
export const criterionItemSchema = (c) => ({
  type: 'OBJECT',
  properties: {
    analysis: { type: 'STRING' },
    answer: { type: 'STRING', enum: allowedAnswers(c) },
    evidence: { type: 'ARRAY', items: { type: 'INTEGER' } },
    checked_from: { type: 'INTEGER', nullable: true },
    checked_to: { type: 'INTEGER', nullable: true },
    explanation: { type: 'STRING' },
    advice: { type: 'STRING' },
    confidence: { type: 'NUMBER' },
  },
  required: ['analysis', 'answer', 'evidence', 'explanation', 'advice', 'confidence'],
  propertyOrdering: ['analysis', 'answer', 'evidence', 'checked_from', 'checked_to', 'explanation', 'advice', 'confidence'],
});

/** Схема ответа одного вызова по всему чек-листу. */
export function buildSchema(checklist) {
  const criterionSchema = criterionItemSchema;
  const ids = checklist.criteria.map((c) => c.id);
  return {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      criteria: {
        type: 'OBJECT',
        properties: Object.fromEntries(checklist.criteria.map((c) => [c.id, criterionSchema(c)])),
        required: ids,
        propertyOrdering: ids,
      },
    },
    required: ['summary', 'criteria'],
    propertyOrdering: ['criteria', 'summary'],
  };
}
