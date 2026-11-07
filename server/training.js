// Тренажёр оператора: разбор ошибок + ролевая игра с ИИ-клиентом по тому же сценарию + ИИ-коуч + итоговая оценка.
// Оператор работает по ссылке /train/<token> без входа в систему; токен — случайные 12 байт.
import crypto from 'node:crypto';
import { generate } from './gemini.js';
import { getDb, save, now, newId } from './store.js';
import { evaluateConversation } from './evaluate.js';
import { formatTranscript, describeCriterion } from './prompt.js';
import { scaleMax } from '../public/js/scoring.js';
import { finalResult } from './results.js';

const db = () => getDb();
const trainings = () => (db().trainings ||= []);

// ── создание тренировки ───────────────────────────────────────────────
function mistakesOf(ev) {
  const fr = finalResult(ev);
  return ev.checklist.criteria
    .map((c) => {
      const answer = fr.finalAnswers[c.id];
      const item = ev.items.find((i) => i.criterionId === c.id);
      const bad =
        answer !== undefined &&
        answer !== 'na' &&
        (c.type === 'flag' ? answer === 'yes' : c.type === 'scale' ? Number(answer) < scaleMax(c) : answer === 'no');
      return bad ? { criterionId: c.id, name: c.name, answer, explanation: item?.explanation || '', advice: item?.advice || '', evidence: item?.evidence || [] } : null;
    })
    .filter(Boolean);
}

const SCENARIO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    language: { type: 'STRING', enum: ['RU', 'KZ', 'EN'] },
    persona: { type: 'STRING' },
    context_before_operator: { type: 'STRING' },
    opening_message: { type: 'STRING' },
    goals: { type: 'ARRAY', items: { type: 'STRING' } },
    hidden_facts: { type: 'STRING' },
    mood: { type: 'STRING' },
    needs_identification: { type: 'BOOLEAN' },
  },
  required: ['title', 'language', 'persona', 'context_before_operator', 'opening_message', 'goals', 'hidden_facts', 'mood', 'needs_identification'],
};

async function buildScenario(conv) {
  const res = await generate({
    system: 'Ты готовишь сценарий тренировки для операторов поддержки брокерской компании. Отвечай JSON.',
    user: `По реальному диалогу составь сценарий для ролевой игры: ИИ будет играть ЭТОГО ЖЕ клиента, а оператор — отвечать заново.
- persona — кто клиент и как пишет (коротко, 1–2 предложения);
- context_before_operator — что клиент уже написал боту до подключения оператора (оператор это видит);
- opening_message — первое сообщение клиента оператору (на языке диалога);
- goals — вопросы клиента по порядку, которые он должен задать, если оператор сам их не закроет;
- hidden_facts — детали, которые клиент сообщает только если оператор спросит (устройство, валюта, название бумаги и т. п.);
- mood — настроение и как клиент реагирует на грубость или небрежность;
- needs_identification — нужна ли проверка личности по сути запроса;
- title — короткое название ситуации на русском.

Диалог ${conv.conversation_id} (язык ${conv.language}):
${formatTranscript(conv)}`,
    schema: SCENARIO_SCHEMA,
  });
  return JSON.parse(res.text);
}

export async function createTraining({ evaluationId, author }) {
  const ev = db().evaluations.find((e) => e.id === evaluationId);
  if (!ev) throw Object.assign(new Error('Оценка не найдена'), { status: 404 });
  const conv = db().conversations[ev.conversationId];
  const scenario = await buildScenario(conv);
  const t = {
    id: newId('tr'),
    token: crypto.randomBytes(12).toString('base64url'),
    conversationId: conv.conversation_id,
    channel: conv.channel,
    evaluationId: ev.id,
    originalTotal: finalResult(ev).finalScore.total,
    checklistId: ev.checklistId,
    mistakes: mistakesOf(ev),
    scenario,
    author: author || 'Проверяющий',
    createdAt: now(),
    attempts: [],
  };
  trainings().push(t);
  save();
  return t;
}

export const findTraining = (token) => trainings().find((t) => t.token === token);
export const trainingsFor = (conversationId) => trainings().filter((t) => t.conversationId === conversationId);

/** То, что видит оператор (без внутренних деталей сценария). */
export function publicView(t) {
  return {
    token: t.token,
    conversationId: t.conversationId,
    channel: t.channel,
    title: t.scenario.title,
    language: t.scenario.language,
    contextBeforeOperator: t.scenario.context_before_operator,
    originalTotal: t.originalTotal,
    mistakes: t.mistakes,
    attempts: t.attempts.map(attemptSummary),
    createdAt: t.createdAt,
  };
}

const attemptSummary = (a) => ({
  id: a.id,
  mode: a.mode,
  startedAt: a.startedAt,
  finishedAt: a.finishedAt,
  total: a.result?.total ?? null,
  grossError: a.result?.grossError ?? false,
  turns: a.transcript.length,
});

// ── ход тренировки ───────────────────────────────────────────────────
const clock = (startedAt) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function startAttempt(t, mode) {
  const a = { id: newId('at'), mode, startedAt: now(), finishedAt: null, transcript: [], coach: [], result: null };
  const sc = t.scenario;
  if (mode === 'text') {
    a.transcript.push({ timestamp: '00:00', speaker: 'system', text: `Чат передан оператору. Клиент ранее писал боту: ${sc.context_before_operator}` });
    a.transcript.push({ timestamp: '00:00', speaker: 'client', text: sc.opening_message });
  }
  t.attempts.push(a);
  save();
  return a;
}

export const clientSystemPrompt = (t) => {
  const sc = t.scenario;
  return `Ты играешь КЛИЕНТА брокерской компании Freedom Broker в учебной ролевой игре. Оператор — живой человек, который тренируется.
Говори только от лица клиента, естественно и коротко (1–2 предложения), на языке: ${sc.language === 'KZ' ? 'казахский' : sc.language === 'EN' ? 'английский' : 'русский'}.
Кто ты: ${sc.persona}
Что ты уже написал боту: ${sc.context_before_operator}
Твои вопросы по порядку: ${sc.goals.join(' | ')}
Детали, которые сообщаешь только если оператор спросит: ${sc.hidden_facts}
Настроение: ${sc.mood}
Правила:
- не подсказывай оператору, что делать, и не оценивай его вслух;
- если оператор просит подтвердить личность — соглашайся;
- если оператор грубит или отвечает невнятно — реагируй как реальный клиент (переспроси, вырази недовольство);
- когда все твои вопросы закрыты или оператор попрощался — поблагодари и попрощайся.`;
};

const CLIENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    agreed_to_identification: { type: 'BOOLEAN' },
    conversation_finished: { type: 'BOOLEAN' },
  },
  required: ['reply', 'agreed_to_identification', 'conversation_finished'],
};

const COACH_SCHEMA = {
  type: 'OBJECT',
  properties: {
    tips: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { type: { type: 'STRING', enum: ['good', 'warn'] }, criterion: { type: 'STRING' }, text: { type: 'STRING' } },
        required: ['type', 'criterion', 'text'],
      },
    },
  },
  required: ['tips'],
};

export async function coachTips(t, transcript) {
  const checklist = db().checklists.find((c) => c.id === t.checklistId) || db().checklists.find((c) => c.id === db().activeChecklistId);
  const sectionsById = Object.fromEntries((checklist.sections || []).map((s) => [s.id, s.name]));
  const last = [...transcript].reverse().find((m) => m.speaker === 'operator');
  if (!last) return [];
  const res = await generate({
    system:
      'Ты — ИИ-коуч оператора поддержки. Оператор тренируется по чек-листу качества. После каждой его реплики дай 0–2 очень коротких подсказки (до 15 слов): что сделано хорошо (good) или что нужно исправить прямо сейчас (warn). Опирайся на чек-лист и на ошибки, которые оператор допустил в прошлый раз. Не повторяй уже данные подсказки. Пиши на русском.',
    user: `Чек-лист:\n${checklist.criteria.map((c) => describeCriterion(c, sectionsById)).join('\n')}

Ошибки оператора в исходном диалоге: ${t.mistakes.map((m) => `${m.name} — ${m.advice || m.explanation}`).join('; ') || 'нет'}

Тренировочный диалог:
${transcript.map((m, i) => `[${i}] ${m.speaker === 'operator' ? 'Оператор' : m.speaker === 'client' ? 'Клиент' : 'Система'}: ${m.text}`).join('\n')}

Дай подсказки по последней реплике оператора: «${last.text}». criterion — id критерия (c01…), к которому относится подсказка.`,
    schema: COACH_SCHEMA,
  });
  return JSON.parse(res.text).tips.slice(0, 2);
}

/** Реплика оператора в текстовом режиме → ответ ИИ-клиента + подсказки коуча (параллельно). */
export async function operatorMessage(t, a, text) {
  a.transcript.push({ timestamp: clock(a.startedAt), speaker: 'operator', text });
  const snapshot = [...a.transcript];
  const dialog = snapshot.map((m) => `${m.speaker === 'operator' ? 'Оператор' : m.speaker === 'client' ? 'Клиент (ты)' : 'Система'}: ${m.text}`).join('\n');
  const [client, tips] = await Promise.all([
    generate({ system: clientSystemPrompt(t), user: `Диалог до этого момента:\n${dialog}\n\nОтветь следующей репликой клиента.`, schema: CLIENT_SCHEMA, temperature: 0.7 }).then((r) => JSON.parse(r.text)),
    coachTips(t, snapshot).catch(() => []),
  ]);
  const added = [];
  if (client.agreed_to_identification && t.scenario.needs_identification && !a.transcript.some((m) => m.speaker === 'system' && /подтвержден/i.test(m.text))) {
    const sys = { timestamp: clock(a.startedAt), speaker: 'system', text: 'Личность клиента подтверждена.' };
    a.transcript.push(sys);
    added.push(sys);
  }
  const reply = { timestamp: clock(a.startedAt), speaker: 'client', text: client.reply };
  a.transcript.push(reply);
  added.push(reply);
  a.coach.push({ afterIndex: snapshot.length - 1, tips });
  save();
  return { added, tips, finished: client.conversation_finished };
}

/** Завершение попытки: оценка тренировочного диалога тем же конвейером, сравнение с исходным баллом. */
export async function finishAttempt(t, a) {
  if (!a.transcript.some((m) => m.speaker === 'operator')) throw Object.assign(new Error('Оператор ещё ничего не ответил'), { status: 400 });
  const checklist = db().checklists.find((c) => c.id === t.checklistId) || db().checklists.find((c) => c.id === db().activeChecklistId);
  const record = {
    conversation_id: `${t.conversationId}·тренировка`,
    channel: a.mode === 'voice' ? 'voice call' : 'agent chat',
    language: t.scenario.language,
    transcript: a.transcript,
    audio_url: null,
  };
  const ev = await evaluateConversation(record, checklist, {});
  const fr = ev.score;
  a.finishedAt = now();
  a.result = {
    total: fr.total,
    grossError: fr.grossError,
    items: ev.items.map(({ criterionId, answer, explanation, advice, evidence }) => ({ criterionId, answer, explanation, advice, evidence })),
    checklist: ev.checklist,
    costUsd: ev.costUsd,
    rows: fr.rows,
  };
  save();
  return { attempt: a, originalTotal: t.originalTotal };
}

export function getAttempt(t, id) {
  const a = t.attempts.find((x) => x.id === id);
  if (!a) throw Object.assign(new Error('Попытка не найдена'), { status: 404 });
  return a;
}
