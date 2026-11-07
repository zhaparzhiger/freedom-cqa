// Мультиагентный конвейер оценки.
//
//   1. Агент контекста      — один раз строит «карту диалога»: факты без оценок.
//   2. Агенты критериев     — по одному на критерий, параллельно; каждый видит только своё правило,
//                             поэтому одно нарушение не «размазывается» по чужим критериям.
//   3. Валидатор правил     — код, не ИИ: N/A разрешён? доказательства существуют? это реплики оператора?
//   4. Агент-проверяющий    — смотрит на все вердикты вместе, ищет противоречия и ошибки трактовки.
//   5. Агент-уточнитель     — пересматривает спорные критерии с учётом замечаний; несогласие → ручная проверка.
//
// Баллы по-прежнему считает код (public/js/scoring.js), агенты только выбирают ответы.
import { generate } from './gemini.js';
import { SYSTEM_PROMPT, describeCriterion, formatTranscript, criterionItemSchema } from './prompt.js';
import { allowedAnswers } from '../public/js/scoring.js';
import { normalizeAnswer } from './evaluate.js';
import { precedentsText } from './precedents.js';

const LOW_CONFIDENCE = 0.7;

// ── 1. агент контекста ───────────────────────────────────────────────
const CONTEXT_SYSTEM = `Ты — агент контекста в системе контроля качества диалогов поддержки брокерской компании.
Твоя задача — НЕ оценивать оператора, а извлечь из диалога проверяемые факты для других агентов.
Реплики пронумерованы [N]. Указывай номера реплик точно. Пиши кратко, на русском; цитаты — на языке оригинала.
Роли: Клиент, Оператор (живой сотрудник), Бот (автоматический ассистент до оператора), Система (служебные события).`;

const CONTEXT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    client_language: { type: 'STRING' },
    client_requests: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { msg: { type: 'INTEGER' }, request: { type: 'STRING' }, asked_before_operator: { type: 'BOOLEAN' }, resolved_by_operator: { type: 'STRING', enum: ['yes', 'partly', 'no', 'unclear'] } },
        required: ['msg', 'request', 'asked_before_operator', 'resolved_by_operator'],
      },
    },
    known_before_operator: { type: 'STRING' },
    operator_first_msg: { type: 'INTEGER', nullable: true },
    operator_first_text: { type: 'STRING' },
    identity_events: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { msg: { type: 'INTEGER' }, event: { type: 'STRING' } }, required: ['msg', 'event'] },
    },
    account_specific_info_by_operator: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { msg: { type: 'INTEGER' }, what: { type: 'STRING' } }, required: ['msg', 'what'] },
    },
    client_dissatisfaction: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { msg: { type: 'INTEGER' }, quote: { type: 'STRING' } }, required: ['msg', 'quote'] },
    },
    operator_waits: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { msg: { type: 'INTEGER' }, warned: { type: 'BOOLEAN' } }, required: ['msg', 'warned'] },
    },
    risky_operator_phrases: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { msg: { type: 'INTEGER' }, kind: { type: 'STRING', enum: ['rude', 'insult', 'personal_service', 'disclosure', 'other'] }, quote: { type: 'STRING' } },
        required: ['msg', 'kind', 'quote'],
      },
    },
    ending: {
      type: 'OBJECT',
      properties: {
        how: { type: 'STRING', enum: ['operator_farewell', 'operator_closed_without_farewell', 'client_left', 'connection_lost', 'call_ended', 'other'] },
        last_operator_msg: { type: 'INTEGER', nullable: true },
        last_operator_text: { type: 'STRING' },
      },
      required: ['how', 'last_operator_text'],
    },
  },
  required: ['client_language', 'client_requests', 'known_before_operator', 'operator_first_text', 'identity_events', 'account_specific_info_by_operator', 'client_dissatisfaction', 'operator_waits', 'risky_operator_phrases', 'ending'],
};

export async function contextAgent(record, transcript, model) {
  const user = `Диалог ${record.conversation_id} · канал ${record.channel} · язык ${record.language}

${transcript}

Извлеки факты:
- client_requests — все вопросы и просьбы клиента по существу, включая заданные боту до подключения оператора; для каждого — решил ли его оператор;
- known_before_operator — что клиент уже сообщил до первой реплики оператора;
- operator_first_msg / operator_first_text — первая реплика оператора;
- identity_events — подтверждения личности (системные сообщения или проверки оператором);
- account_specific_info_by_operator — где оператор сообщил сведения о конкретном счёте клиента или выполнил действие по счёту;
- client_dissatisfaction — где клиент явно выразил недовольство, раздражение, упрёк или жалобу на сервис/оператора («уже надоело», «я же писал», «со мной так говорить не надо»). Просьба соединить с оператором и обычное «не могу найти» — НЕ недовольство;
- operator_waits — где оператор уходил проверять информацию (warned — предупредил ли);
- risky_operator_phrases — грубые, оскорбительные фразы оператора, предложения личных услуг в обход компании, раскрытие данных;
- ending — чем закончился диалог и последняя реплика оператора.
Пустые списки допустимы.`;
  const res = await generate({ system: CONTEXT_SYSTEM, user, schema: CONTEXT_SCHEMA, model });
  return { map: JSON.parse(res.text), res };
}

export function formatMap(map) {
  const lines = [];
  lines.push(`Язык клиента: ${map.client_language}`);
  lines.push(`Известно до оператора: ${map.known_before_operator || '—'}`);
  lines.push(`Первая реплика оператора: ${map.operator_first_msg != null ? `[${map.operator_first_msg}] ` : ''}${map.operator_first_text || '—'}`);
  lines.push('Запросы клиента:' + (map.client_requests.length ? '' : ' —'));
  map.client_requests.forEach((r) => lines.push(`  [${r.msg}] ${r.request}${r.asked_before_operator ? ' (задан до оператора)' : ''} → решён оператором: ${r.resolved_by_operator}`));
  lines.push(`Подтверждение личности: ${map.identity_events.map((e) => `[${e.msg}] ${e.event}`).join('; ') || 'нет'}`);
  lines.push(`Сведения о счёте от оператора: ${map.account_specific_info_by_operator.map((e) => `[${e.msg}] ${e.what}`).join('; ') || 'нет'}`);
  lines.push(`Недовольство клиента: ${map.client_dissatisfaction.map((e) => `[${e.msg}] «${e.quote}»`).join('; ') || 'нет'}`);
  lines.push(`Ожидания: ${map.operator_waits.map((e) => `[${e.msg}] ${e.warned ? 'с предупреждением' : 'без предупреждения'}`).join('; ') || 'нет'}`);
  lines.push(`Рискованные фразы оператора: ${map.risky_operator_phrases.map((e) => `[${e.msg}] ${e.kind}: «${e.quote}»`).join('; ') || 'нет'}`);
  lines.push(`Завершение: ${map.ending.how}${map.ending.last_operator_msg != null ? `, последняя реплика оператора [${map.ending.last_operator_msg}]` : ''}: «${map.ending.last_operator_text}»`);
  return lines.join('\n');
}

// ── 2. агенты критериев ──────────────────────────────────────────────
const CRITERION_SYSTEM = `${SYSTEM_PROMPT}

Ты — агент, отвечающий за ОДИН критерий чек-листа. Оценивай только его; другие критерии оценивают другие агенты.
Тебе дана «карта диалога» от агента контекста — это подсказка, а не истина: сверяй каждый факт с транскриптом.`;

function criterionUser(checklist, c, record, transcript, mapText, extra = '') {
  const sectionsById = Object.fromEntries((checklist.sections || []).map((s) => [s.id, s.name]));
  return [
    checklist.generalRules?.trim() ? `Общие правила чек-листа:\n${checklist.generalRules.trim()}` : '',
    `Твой критерий:\n${describeCriterion(c, sectionsById)}`,
    `Карта диалога (от агента контекста):\n${mapText}`,
    `ДИАЛОГ ${record.conversation_id} · канал: ${record.channel} · язык: ${record.language}\n${transcript}`,
    extra,
    `Оцени оператора только по критерию [${c.id}] и верни JSON.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function parseItem(c, text, total) {
  const r = JSON.parse(text);
  const inRange = (n) => Number.isInteger(n) && n >= 0 && n < total;
  const answer = normalizeAnswer(c, r.answer);
  if (!answer) throw new Error(`Недопустимый ответ ${r.answer} по ${c.id}`);
  const cited = (r.evidence || []).map(Number);
  return {
    criterionId: c.id,
    answer,
    analysis: String(r.analysis || ''),
    explanation: String(r.explanation || ''),
    advice: String(r.advice || ''),
    evidence: [...new Set(cited.filter(inRange))],
    invalidEvidence: cited.filter((n) => !inRange(n)),
    checkedRange: inRange(r.checked_from) && inRange(r.checked_to) ? [r.checked_from, r.checked_to] : null,
    confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
  };
}

export async function criterionAgent(checklist, c, record, transcript, mapText, model, extra = '') {
  const prec = precedentsText(c.id, record.conversation_id);
  if (prec) extra = [prec, extra].filter(Boolean).join('\n\n');
  const res = await generate({ system: CRITERION_SYSTEM, user: criterionUser(checklist, c, record, transcript, mapText, extra), schema: criterionItemSchema(c), model });
  return { item: parseItem(c, res.text, record.transcript.length), res };
}

// ── 3. валидатор правил (код) ────────────────────────────────────────
export function validate(checklist, items, record) {
  const notes = {};
  const add = (id, msg) => (notes[id] ||= []).push(msg);
  for (const c of checklist.criteria) {
    const it = items[c.id];
    if (!it) continue;
    if (!allowedAnswers(c).includes(it.answer)) add(c.id, `ответ ${it.answer} не разрешён для критерия`);
    if (it.answer !== 'na' && !it.evidence.length && !it.checkedRange && !(c.type === 'flag' && it.answer === 'no'))
      add(c.id, 'нет ссылок на реплики-доказательства');
    if (it.invalidEvidence?.length) add(c.id, `ссылки на несуществующие реплики: ${it.invalidEvidence.map((i) => `#${i}`).join(', ')}`);
    const speakers = it.evidence.map((i) => record.transcript[i]?.speaker);
    // положительный вывод о работе оператора должен опираться на реплику оператора или системное событие
    const positive = it.answer === 'yes' || (c.type === 'scale' && Number(it.answer) > 0);
    if (it.evidence.length && c.type !== 'flag' && positive && !speakers.some((s) => s === 'operator' || s === 'system'))
      add(c.id, 'вывод о работе оператора не опирается ни на одну реплику оператора');
    // нарушение (грубая ошибка) должно быть подтверждено репликой оператора
    if (c.type === 'flag' && it.answer === 'yes' && !speakers.includes('operator')) add(c.id, 'нарушение не подтверждено репликой оператора');
    if (it.answer === 'na' && !c.naAllowed) add(c.id, 'N/A не разрешён');
  }
  return notes;
}

/** Проверка доказательств на финальных ответах: при замечаниях критерий помечается «требует проверки человеком». */
export function markEvidence(checklist, itemsList, record) {
  const notes = validate(checklist, Object.fromEntries(itemsList.map((i) => [i.criterionId, i])), record);
  for (const it of itemsList) {
    it.evidenceIssues = notes[it.criterionId] || [];
    if (it.evidenceIssues.length) it.needsReview = true;
  }
  return itemsList;
}

// ── 4. агент-проверяющий ─────────────────────────────────────────────
const VERIFIER_SYSTEM = `${SYSTEM_PROMPT}

Ты — агент-проверяющий (старший контролёр). Другие агенты уже оценили каждый критерий по отдельности.
Проверь их вердикты по транскрипту и правилам чек-листа и найди ошибки:
- ответ не следует из правила критерия или его N/A-условия (например, «Да», хотя данных хватало и уточнять было нечего — должен быть N/A; или «Да» за прощание без итога);
- доказательство не подтверждает вывод или вывод противоречит транскрипту;
- двойное наказание: критерий снижен за нарушение, которое относится к другому критерию;
- противоречия между критериями (например, сведения о счёте раскрыты без подтверждения личности, а идентификация не «Нет»);
- замечания валидатора правил.
Ставь "doubt" только при конкретной ошибке; если вердикт верен — "ok". Не меняй вердикты ради перестраховки.`;

function verifierSchema(checklist) {
  const ids = checklist.criteria.map((c) => c.id);
  return {
    type: 'OBJECT',
    properties: Object.fromEntries(
      checklist.criteria.map((c) => [
        c.id,
        {
          type: 'OBJECT',
          properties: {
            verdict: { type: 'STRING', enum: ['ok', 'doubt'] },
            issue: { type: 'STRING' },
            suggested_answer: { type: 'STRING', enum: allowedAnswers(c) },
          },
          required: ['verdict', 'issue', 'suggested_answer'],
          propertyOrdering: ['issue', 'verdict', 'suggested_answer'],
        },
      ]),
    ),
    required: ids,
    propertyOrdering: ids,
  };
}

export async function verifierAgent(checklist, items, notes, record, transcript, mapText, model) {
  const sectionsById = Object.fromEntries((checklist.sections || []).map((s) => [s.id, s.name]));
  const verdicts = checklist.criteria
    .filter((c) => items[c.id])
    .map((c) => {
      const it = items[c.id];
      return `[${c.id}] ${c.name}: ответ «${it.answer}», доказательства ${JSON.stringify(it.evidence)}${it.checkedRange ? `, проверен участок ${it.checkedRange.join('–')}` : ''}
  обоснование: ${it.explanation}${notes[c.id] ? `\n  замечания валидатора: ${notes[c.id].join('; ')}` : ''}`;
    })
    .join('\n');
  const user = [
    checklist.generalRules?.trim() ? `Общие правила чек-листа:\n${checklist.generalRules.trim()}` : '',
    `Критерии:\n${checklist.criteria.map((c) => describeCriterion(c, sectionsById)).join('\n\n')}`,
    `Карта диалога:\n${mapText}`,
    `ДИАЛОГ ${record.conversation_id}\n${transcript}`,
    `Вердикты агентов критериев:\n${verdicts}`,
    'Для каждого критерия верни verdict (ok/doubt), issue (в чём ошибка или «ошибок нет») и suggested_answer (верный, по-твоему, ответ; при ok — тот же ответ).',
  ]
    .filter(Boolean)
    .join('\n\n');
  const res = await generate({ system: VERIFIER_SYSTEM, user, schema: verifierSchema(checklist), model });
  return { checks: JSON.parse(res.text), res };
}

// ── конвейер целиком ─────────────────────────────────────────────────
export async function runPipeline(record, checklist, { model }) {
  const transcript = formatTranscript(record);
  const usage = { input: 0, output: 0, calls: 0, models: [] };
  const steps = [];
  const raw = [];
  const track = (res) => {
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    usage.calls++;
    if (res.model && !usage.models.includes(res.model)) usage.models.push(res.model);
    raw.push(res.text);
  };

  // 1
  const ctx = await contextAgent(record, transcript, model);
  track(ctx.res);
  const mapText = formatMap(ctx.map);
  steps.push({ agent: 'context', title: 'Агент контекста', ms: ctx.res.ms, tokens: ctx.res.usage.input + ctx.res.usage.output, output: ctx.map });

  // 2
  const items = {};
  const firstPass = await Promise.all(
    checklist.criteria.map(async (c) => {
      try {
        const r = await criterionAgent(checklist, c, record, transcript, mapText, model);
        track(r.res);
        items[c.id] = r.item;
        return { agent: 'criterion', criterionId: c.id, title: `Агент «${c.name}»`, ms: r.res.ms, tokens: r.res.usage.input + r.res.usage.output, answer: r.item.answer, confidence: r.item.confidence };
      } catch (e) {
        return { agent: 'criterion', criterionId: c.id, title: `Агент «${c.name}»`, error: e.message };
      }
    }),
  );
  // упавшие агенты (обычно лимит запросов) — ещё одна попытка после основного прохода, по одному
  for (const st of firstPass.filter((x) => x.error)) {
    const c = checklist.criteria.find((x) => x.id === st.criterionId);
    try {
      await new Promise((r) => setTimeout(r, 5000));
      const r = await criterionAgent(checklist, c, record, transcript, mapText, model);
      track(r.res);
      items[c.id] = r.item;
      Object.assign(st, { error: undefined, retried: true, ms: r.res.ms, tokens: r.res.usage.input + r.res.usage.output, answer: r.item.answer, confidence: r.item.confidence });
    } catch (e) {
      st.error = e.message;
    }
  }
  // без ответа хотя бы по одному критерию оценка неполная — пусть пакетная оценка повторит диалог
  const lost = firstPass.filter((x) => x.error).map((x) => x.criterionId);
  if (lost.length) throw new Error(`Не удалось оценить критерии ${lost.join(', ')}: ${firstPass.find((x) => x.error).error.slice(0, 160)}`);
  steps.push(...firstPass);

  // 3
  const notes = validate(checklist, items, record);
  steps.push({ agent: 'validator', title: 'Валидатор правил (код)', ms: 0, tokens: 0, notes });

  // 4
  // проверяющий — дополнительная страховка: если он не ответил, оценка остаётся полной, просто без пересмотра
  let ver;
  try {
    ver = await verifierAgent(checklist, items, notes, record, transcript, mapText, model);
    track(ver.res);
  } catch (e) {
    ver = { checks: {}, res: null, error: e.message };
  }
  const doubts = Object.entries(ver.checks).filter(([id, v]) => items[id] && (v.verdict === 'doubt' || notes[id]) && v.suggested_answer !== undefined);
  steps.push({
    agent: 'verifier',
    title: 'Агент-проверяющий',
    ms: ver.res?.ms || 0,
    tokens: ver.res ? ver.res.usage.input + ver.res.usage.output : 0,
    checks: ver.checks,
    doubts: doubts.map(([id]) => id),
    ...(ver.error ? { error: `не ответил: ${ver.error.slice(0, 160)}` } : {}),
  });

  // 5
  for (const it of Object.values(items)) {
    it.verifier = ver.checks[it.criterionId] || null;
    it.needsReview = it.confidence < LOW_CONFIDENCE;
  }
  await Promise.all(
    doubts.map(async ([id, v]) => {
      const c = checklist.criteria.find((x) => x.id === id);
      const before = items[id];
      const extra = `Первичная оценка агента: «${before.answer}». Обоснование: ${before.explanation}
Замечание агента-проверяющего: ${v.issue}. Предлагаемый им ответ: «${v.suggested_answer}».${notes[id] ? `\nЗамечания валидатора: ${notes[id].join('; ')}` : ''}
Перепроверь критерий по транскрипту и правилу и прими окончательное решение. Согласись с проверяющим, только если его довод подтверждается правилом и транскриптом.`;
      try {
        const r = await criterionAgent(checklist, c, record, transcript, mapText, model, extra);
        track(r.res);
        const after = r.item;
        const agreedWithVerifier = after.answer === v.suggested_answer;
        items[id] = {
          ...after,
          verifier: v,
          revision: after.answer !== before.answer ? { from: before.answer, to: after.answer, reason: v.issue } : null,
          // спор не разрешён: уточнитель не согласился ни с первичной оценкой, ни с проверяющим, или уверенность низкая
          needsReview: (!agreedWithVerifier && after.answer !== before.answer) || (!agreedWithVerifier && v.verdict === 'doubt' && after.confidence < 0.85) || after.confidence < LOW_CONFIDENCE,
        };
        steps.push({ agent: 'rejudge', criterionId: id, title: `Уточнитель «${c.name}»`, ms: r.res.ms, tokens: r.res.usage.input + r.res.usage.output, from: before.answer, to: after.answer, issue: v.issue, suggested: v.suggested_answer });
      } catch (e) {
        before.needsReview = true;
        steps.push({ agent: 'rejudge', criterionId: id, title: `Уточнитель «${c.name}»`, error: e.message });
      }
    }),
  );

  const ENDING = {
    operator_farewell: 'оператор попрощался',
    operator_closed_without_farewell: 'оператор закрыл чат без прощания',
    client_left: 'клиент ушёл',
    connection_lost: 'связь прервалась',
    call_ended: 'звонок завершён',
    other: 'другое',
  };
  const summary = ctx.map.client_requests.length
    ? `Запросы клиента: ${ctx.map.client_requests.map((r) => r.request).join('; ')}. Завершение: ${ENDING[ctx.map.ending.how] || ctx.map.ending.how}.`
    : '';
  return {
    items: markEvidence(
      checklist,
      checklist.criteria.filter((c) => items[c.id]).map((c) => ({ ...items[c.id], agreement: 1, votes: [items[c.id].answer] })),
      record,
    ),
    usage,
    raw,
    summary,
    pipeline: { mode: 'agents', steps, dialogMap: ctx.map },
  };
}
