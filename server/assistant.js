// ИИ-ассистент администратора «Аудитор»: отвечает на вопросы по данным платформы и сам управляет интерфейсом.
// Модель вызывает инструменты двух видов:
//   • данные (выполняются на сервере): обзор, рейтинг операторов, поиск диалогов, разбор оценки, проблемные критерии;
//   • интерфейс (выполняются в браузере): открыть страницу или диалог, подвести указатель к критерию/реплике/строке.
import { generateRaw } from './gemini.js';
import { getDb } from './store.js';
import { latestEvaluation, finalResult } from './results.js';
import { scaleMax } from '../public/js/scoring.js';

const db = () => getDb();

// ── имя оператора из первой реплики ─────────────────────────────────
const NAME_PATTERNS = [
  /меня зовут\s+([А-ЯЁA-Z][а-яёa-z]+)/i,
  // \b в JS не работает с кириллицей — границу слова проверяем явно
  /(?<![А-Яа-яЁё])[Яя]\s+[—-]?\s*([А-ЯЁ][а-яё]{2,})/,
  /атым\s+([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+)/i,
  /(?<![А-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі])мен\s+([А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]{2,})/i,
  /(?:my name is|i am|i'm|this is)\s+([A-Z][a-z]+)/i,
];
const STOP = new Set(['Здравствуйте', 'Сейчас', 'Понимаю', 'Сегодня', 'Freedom', 'Компания']);

export function operatorName(conv) {
  if (conv.operatorName !== undefined) return conv.operatorName;
  const first = conv.transcript.find((t) => t.speaker === 'operator')?.text || '';
  let name = null;
  for (const re of NAME_PATTERNS) {
    const m = first.match(re);
    if (m && !STOP.has(m[1])) {
      // казахское «Мен Нұрланмын» — отрезаем личное окончание «-мын/-мін»
      const base = m[1].replace(/(мын|мін|пын|пін|бын|бін)$/i, '');
      name = base[0].toUpperCase() + base.slice(1);
      break;
    }
  }
  if (!name && /\[Имя скрыто\]/i.test(first)) name = null;
  conv.operatorName = name;
  return name;
}

function rows() {
  return Object.values(db().conversations)
    .map((c) => {
      const ev = latestEvaluation(c.conversation_id);
      if (!ev) return null;
      const fr = finalResult(ev);
      const failed = ev.checklist.criteria
        .filter((cr) => {
          const a = fr.finalAnswers[cr.id];
          if (a === undefined || a === 'na') return false;
          return cr.type === 'flag' ? a === 'yes' : cr.type === 'scale' ? Number(a) < scaleMax(cr) : a === 'no';
        })
        .map((cr) => cr.id);
      return {
        id: c.conversation_id,
        operator: operatorName(c) || `оператор ${c.conversation_id}`,
        language: c.language,
        channel: c.channel === 'voice call' ? 'звонок' : 'чат',
        total: fr.finalScore.total,
        gross: fr.finalScore.grossError,
        failed,
      };
    })
    .filter(Boolean);
}

// ── инструменты данных ───────────────────────────────────────────────
const dataTools = {
  get_overview() {
    const r = rows();
    const totals = r.map((x) => x.total).filter((t) => t != null);
    const cl = db().checklists.find((c) => c.id === db().activeChecklistId);
    return {
      dialogs: Object.keys(db().conversations).length,
      evaluated: r.length,
      average: totals.length ? Math.round((totals.reduce((s, x) => s + x, 0) / totals.length) * 100) / 100 : null,
      gross_errors: r.filter((x) => x.gross).map((x) => x.id),
      open_appeals: db().appeals.filter((a) => a.status === 'open').length,
      checklist: cl ? `${cl.name} v${cl.version}: ${cl.criteria.map((c) => `${c.id} ${c.name} (вес ${c.weight})`).join('; ')}` : null,
    };
  },
  rank_operators({ order = 'best', limit = 5 }) {
    const by = {};
    for (const r of rows()) {
      const o = (by[r.operator] ||= { operator: r.operator, dialogs: [], totals: [], gross: 0, failed: {} });
      o.dialogs.push(r.id);
      if (r.total != null) o.totals.push(r.total);
      if (r.gross) o.gross++;
      r.failed.forEach((f) => (o.failed[f] = (o.failed[f] || 0) + 1));
    }
    const list = Object.values(by)
      .filter((o) => o.totals.length)
      .map((o) => ({ operator: o.operator, average: Math.round((o.totals.reduce((s, x) => s + x, 0) / o.totals.length) * 100) / 100, dialogs: o.dialogs, gross_errors: o.gross, typical_failures: o.failed }));
    list.sort((a, b) => (order === 'worst' ? a.average - b.average : b.average - a.average) || b.dialogs.length - a.dialogs.length);
    return { order, operators: list.slice(0, Math.min(20, limit || 5)), note: 'Оператор определяется по имени из первой реплики; у одного имени может быть несколько диалогов.' };
  },
  find_conversations({ language, channel, gross_error, failed_criterion, min_score, max_score, sort = 'score_asc', limit = 10 }) {
    let r = rows();
    if (language) r = r.filter((x) => x.language === language.toUpperCase());
    if (channel) r = r.filter((x) => (channel === 'call' ? x.channel === 'звонок' : x.channel === 'чат'));
    if (gross_error !== undefined) r = r.filter((x) => x.gross === gross_error);
    if (failed_criterion) r = r.filter((x) => x.failed.includes(failed_criterion));
    if (min_score !== undefined) r = r.filter((x) => x.total != null && x.total >= min_score);
    if (max_score !== undefined) r = r.filter((x) => x.total != null && x.total <= max_score);
    r.sort((a, b) => (sort === 'score_desc' ? (b.total ?? -1) - (a.total ?? -1) : (a.total ?? 101) - (b.total ?? 101)));
    return { count: r.length, conversations: r.slice(0, Math.min(30, limit || 10)) };
  },
  get_conversation({ conversation_id }) {
    const c = db().conversations[conversation_id];
    if (!c) return { error: 'диалог не найден' };
    const ev = latestEvaluation(conversation_id);
    if (!ev) return { conversation_id, evaluated: false };
    const fr = finalResult(ev);
    return {
      conversation_id,
      operator: operatorName(c),
      language: c.language,
      channel: c.channel,
      total: fr.finalScore.total,
      gross_error: fr.finalScore.grossError,
      summary: ev.summary,
      criteria: ev.checklist.criteria.map((cr) => {
        const it = ev.items.find((i) => i.criterionId === cr.id);
        return { id: cr.id, name: cr.name, answer: fr.finalAnswers[cr.id], explanation: it?.explanation, advice: it?.advice, evidence: it?.evidence, needs_review: it?.needsReview || false };
      }),
      transcript: c.transcript.map((t, i) => `[${i}] ${t.speaker}: ${String(t.text).slice(0, 200)}`).join('\n').slice(0, 6000),
      appeals: fr.appeals.map((a) => ({ criterion: a.criterionId, status: a.status, comment: a.comment, decision: a.decision })),
    };
  },
  criterion_failure_rates() {
    const r = rows();
    const cl = db().checklists.find((c) => c.id === db().activeChecklistId);
    return {
      evaluated: r.length,
      criteria: cl.criteria.map((c) => ({ id: c.id, name: c.name, failed_in: r.filter((x) => x.failed.includes(c.id)).length })),
    };
  },
};

// ── инструменты интерфейса (выполняет браузер) ──────────────────────
const UI_TOOLS = new Set(['open_page', 'open_conversation', 'point_at_criterion', 'point_at_message', 'point_at_rows']);

const S = (properties, required = []) => ({ type: 'OBJECT', properties, required });
const TOOLS = [
  { name: 'get_overview', description: 'Общая сводка: число диалогов, средний балл, грубые ошибки, открытые апелляции, активный чек-лист.', parameters: S({}) },
  {
    name: 'rank_operators',
    description: 'Рейтинг операторов по среднему баллу их диалогов: лучшие или худшие, с типичными ошибками (id критериев).',
    parameters: S({ order: { type: 'STRING', enum: ['best', 'worst'] }, limit: { type: 'INTEGER' } }),
  },
  {
    name: 'find_conversations',
    description: 'Поиск оценённых диалогов по фильтрам. failed_criterion — id критерия (c01…), который не выполнен.',
    parameters: S({
      language: { type: 'STRING', enum: ['RU', 'KZ', 'EN'] },
      channel: { type: 'STRING', enum: ['chat', 'call'] },
      gross_error: { type: 'BOOLEAN' },
      failed_criterion: { type: 'STRING' },
      min_score: { type: 'NUMBER' },
      max_score: { type: 'NUMBER' },
      sort: { type: 'STRING', enum: ['score_asc', 'score_desc'] },
      limit: { type: 'INTEGER' },
    }),
  },
  { name: 'get_conversation', description: 'Полный разбор оценки диалога: баллы, ответы по критериям, объяснения, советы, транскрипт.', parameters: S({ conversation_id: { type: 'STRING' } }, ['conversation_id']) },
  { name: 'criterion_failure_rates', description: 'Сколько раз не выполнен каждый критерий — самые проблемные места.', parameters: S({}) },
  { name: 'open_page', description: 'Открыть раздел платформы на экране.', parameters: S({ page: { type: 'STRING', enum: ['list', 'appeals', 'checklists', 'stats'] } }, ['page']) },
  { name: 'open_conversation', description: 'Открыть карточку диалога на экране.', parameters: S({ conversation_id: { type: 'STRING' } }, ['conversation_id']) },
  {
    name: 'point_at_criterion',
    description: 'Открыть карточку диалога, подвести указатель к блоку критерия и подсветить его. Используй, когда объясняешь ошибку.',
    parameters: S({ conversation_id: { type: 'STRING' }, criterion_id: { type: 'STRING' }, caption: { type: 'STRING' } }, ['conversation_id', 'criterion_id']),
  },
  {
    name: 'point_at_message',
    description: 'Подсветить реплику в транскрипте диалога (номер реплики), например доказательство ошибки.',
    parameters: S({ conversation_id: { type: 'STRING' }, index: { type: 'INTEGER' }, caption: { type: 'STRING' } }, ['conversation_id', 'index']),
  },
  {
    name: 'point_at_rows',
    description: 'Открыть список диалогов и подсветить строки с указанными ID (например, диалоги лучшего оператора).',
    parameters: S({ conversation_ids: { type: 'ARRAY', items: { type: 'STRING' } }, caption: { type: 'STRING' } }, ['conversation_ids']),
  },
];

const SYSTEM = `Ты — «Аудитор», ИИ-ассистент руководителя контроля качества на платформе Freedom CQA (оценка диалогов операторов поддержки по чек-листу).
Ты отвечаешь по-русски, кратко и по делу, как опытный руководитель КК: цифры, имена, конкретные ошибки и что с ними делать.
Правила:
- Всегда опирайся на данные из инструментов, ничего не выдумывай. Если данных нет — скажи об этом.
- Когда говоришь о конкретном операторе, диалоге или ошибке — ПОКАЗЫВАЙ это на экране: point_at_rows для списка диалогов, point_at_criterion для ошибки, point_at_message для реплики-доказательства, open_page для раздела. Пользователь видит, как ты ведёшь указатель.
- Порядок показа: сначала общий вид (строки в списке), затем конкретный диалог и критерий, затем реплика. Не больше 4 действий на экране за ответ.
- Учитывай все аспекты: средний балл, грубые ошибки, типичные слабые критерии, апелляции, число диалогов (по одному диалогу выводы делай осторожно).
- Баллы — из 100 (например «45,5 из 100»), не проценты.
- Баллы — из 100 (например «45,5 из 100»), не проценты.
- В ответе: 2–6 предложений или короткий список. Названия критериев — по-человечески, id в скобках.`;

/** Один ход диалога с ассистентом: модель ходит в инструменты, пока не даст текстовый ответ. */
export async function assistantTurn(history, context) {
  const contents = history.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
  if (context?.route) contents[contents.length - 1].parts.unshift({ text: `(Служебное: сейчас на экране ${context.route})` });
  const actions = [];
  const trace = [];
  for (let step = 0; step < 6; step++) {
    const { json } = await generateRaw({
      systemInstruction: { role: 'system', parts: [{ text: SYSTEM }] },
      contents,
      tools: [{ functionDeclarations: TOOLS }],
      generationConfig: { temperature: 0.2 },
    });
    const parts = json.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
      return { reply: text || 'Готово.', actions, trace };
    }
    contents.push({ role: 'model', parts });
    const responses = calls.map((fc) => {
      let response;
      if (UI_TOOLS.has(fc.name)) {
        actions.push({ name: fc.name, args: fc.args || {} });
        response = { result: 'показано на экране' };
      } else if (dataTools[fc.name]) {
        try {
          response = { result: dataTools[fc.name](fc.args || {}) };
        } catch (e) {
          response = { error: e.message };
        }
      } else response = { error: 'нет такого инструмента' };
      trace.push(fc.name);
      return { functionResponse: { name: fc.name, response } };
    });
    contents.push({ role: 'user', parts: responses });
  }
  return { reply: 'Не удалось завершить ответ — уточните вопрос.', actions, trace };
}
