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
export const dataTools = {
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
    // названия критериев вместо голых id — иначе модель угадывает смысл «c02» и ошибается
    const cl = db().checklists.find((c) => c.id === db().activeChecklistId);
    const nameOf = (id) => cl?.criteria.find((c) => c.id === id)?.name || id;
    const list = Object.values(by)
      .filter((o) => o.totals.length)
      .map((o) => ({
        operator: o.operator,
        average: Math.round((o.totals.reduce((s, x) => s + x, 0) / o.totals.length) * 100) / 100,
        dialogs: o.dialogs,
        gross_errors: o.gross,
        failed_criteria: Object.entries(o.failed).map(([id, n]) => ({ criterion_id: id, name: nameOf(id), times: n })),
      }));
    list.sort((a, b) => (order === 'worst' ? a.average - b.average : b.average - a.average) || b.dialogs.length - a.dialogs.length);
    return {
      order,
      operators: list.slice(0, Math.min(20, limit || 5)),
      note: 'Оператор определяется по имени из первой реплики. Чтобы объяснить конкретную ошибку, сначала вызови get_conversation и опирайся на explanation критерия.',
    };
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
export const UI_TOOLS = new Set(['open_page', 'open_conversation', 'point_at_criterion', 'point_at_message', 'point_at_rows']);
// управление сайтом как пользователь: браузер выполняет действие и возвращает результат и новый снимок экрана
export const CLIENT_TOOLS = new Set(['read_screen', 'click', 'type_text', 'select_option', 'set_checkbox', 'scroll_to', 'press_key', 'highlight', 'tour']);

const S = (properties, required = []) => ({ type: 'OBJECT', properties, required });
export const TOOLS = [
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
  // ── управление любыми элементами сайта ──
  {
    name: 'read_screen',
    description: 'Снимок текущего экрана: адрес, текст страницы, все кнопки, ссылки, поля, списки и флажки с ref (e1, e2…) и смысловые блоки страницы — показатели, секции, графики, таблицы — с ref (b1, b2…). Вызывай перед первым действием на экране и перед объяснением страницы.',
    parameters: S({}),
  },
  {
    name: 'tour',
    description:
      'Экскурсия по нескольким местам: окно ассистента сворачивается, аватар по очереди переходит к месту каждого шага, подсвечивает его и рядом показывает text этого шага; следующее место — когда текст дочитан. Место шага: ref (b… или e… из последнего read_screen) ИЛИ conversation_ids (строки списка) ИЛИ conversation_id + criterion_id (критерий) ИЛИ conversation_id + message_index (реплика) ИЛИ conversation_id (карточка) ИЛИ page (раздел). text — 1–2 предложения строго об этом месте.',
    parameters: S(
      {
        steps: {
          type: 'ARRAY',
          items: S(
            {
              ref: { type: 'STRING' },
              conversation_ids: { type: 'ARRAY', items: { type: 'STRING' } },
              conversation_id: { type: 'STRING' },
              criterion_id: { type: 'STRING' },
              message_index: { type: 'INTEGER' },
              page: { type: 'STRING', enum: ['list', 'appeals', 'checklists', 'stats'] },
              text: { type: 'STRING' },
            },
            ['text'],
          ),
        },
      },
      ['steps'],
    ),
  },
  {
    name: 'highlight',
    description: 'Подвести аватар к одному блоку или элементу текущего экрана (ref b… или e…) и подсветить его, ничего не нажимая. Для ответа про одно место. Несколько мест в тексте — через tour.',
    parameters: S({ ref: { type: 'STRING' }, caption: { type: 'STRING' } }, ['ref']),
  },
  {
    name: 'click',
    description: 'Нажать кнопку, ссылку, вкладку, переключатель или раскрыть блок по ref из последнего снимка. Для элементов с пометкой [нужно подтверждение] сначала спроси пользователя и после его «да» передай confirmed=true.',
    parameters: S({ ref: { type: 'STRING' }, confirmed: { type: 'BOOLEAN' }, caption: { type: 'STRING' } }, ['ref']),
  },
  {
    name: 'type_text',
    description: 'Ввести текст в поле (поиск, комментарий, название, вес, group_id и т. п.). submit=true — сразу отправить (Enter). append=true — дописать к уже введённому.',
    parameters: S({ ref: { type: 'STRING' }, text: { type: 'STRING' }, submit: { type: 'BOOLEAN' }, append: { type: 'BOOLEAN' } }, ['ref', 'text']),
  },
  { name: 'select_option', description: 'Выбрать вариант в выпадающем списке по его тексту.', parameters: S({ ref: { type: 'STRING' }, option: { type: 'STRING' } }, ['ref', 'option']) },
  { name: 'set_checkbox', description: 'Отметить или снять флажок.', parameters: S({ ref: { type: 'STRING' }, checked: { type: 'BOOLEAN' } }, ['ref', 'checked']) },
  { name: 'scroll_to', description: 'Прокрутить экран к элементу, чтобы пользователь его увидел.', parameters: S({ ref: { type: 'STRING' } }, ['ref']) },
  { name: 'press_key', description: 'Нажать клавишу (Escape, Enter, ArrowRight…) — на элементе ref или на текущем фокусе.', parameters: S({ key: { type: 'STRING' }, ref: { type: 'STRING' } }, ['key']) },
];

export const SYSTEM = `Ты — «Аудитор», ИИ-ассистент руководителя контроля качества на платформе Freedom CQA (оценка диалогов операторов поддержки по чек-листу).
Ты ИИ, а не реальный человек: не называй себя чужим именем и не говори от лица руководителей компании.
Отвечай кратко и по делу, как опытный руководитель КК: цифры, имена, конкретные ошибки и что с ними делать.
Язык ответа: отвечай на том языке, на котором к тебе обратились в последнем сообщении (русский, казахский, английский или любой другой). Сменил собеседник язык — переходи на новый. Названия кнопок и разделов сайта называй так, как они написаны на экране, а цитаты из диалогов приводи на языке оригинала. Эта инструкция написана по-русски только для удобства — она не значит, что отвечать нужно по-русски.
Правила:
- Всегда опирайся на данные из инструментов, ничего не выдумывай. Если данных нет — скажи об этом.
- Прежде чем называть или показывать ошибку конкретного диалога, ОБЯЗАТЕЛЬНО вызови get_conversation и пересказывай explanation нужного критерия. Реплику для point_at_message бери из evidence этого критерия.
- Учитывай все аспекты: средний балл, грубые ошибки, типичные слабые критерии, апелляции, число диалогов (по одному диалогу выводы делай осторожно).
- Пол оператора неизвестен: не пиши и не говори «он/она», «сделал/сделала» — говори «оператор Саша», «оператор ответил».
- Баллы — из 100 (например «45,5 из 100»), не проценты.
- В ответе: 2–6 предложений или короткий список. Названия критериев — по-человечески, id в скобках.
Управление сайтом — ты работаешь в интерфейсе сам, как пользователь с мышью и клавиатурой:
- Если просят что-то сделать на сайте (нажать, включить, ввести, найти, отфильтровать, переключить роль, открыть вкладку, раскрыть критерий, подать апелляцию, поменять вес, запустить оценку…) — ДЕЛАЙ это сам, не объясняй, куда нажимать.
- Порядок: read_screen → действие по ref (click, type_text, select_option, set_checkbox, scroll_to, press_key) → смотри новый снимок в ответе инструмента → следующее действие. ref из старых снимков не используй.
- Нужного элемента нет — сначала перейди в нужный раздел (open_page, open_conversation или click по меню), потом read_screen.
- Действия с пометкой [нужно подтверждение] меняют данные или тратят вызовы модели (удалить, сохранить, применить, оценить, решение по апелляции, подать апелляцию). Сначала коротко скажи, что именно нажмёшь, и спроси подтверждения на языке собеседника. Только после явного согласия («да», «иә», «yes»…) вызывай click с confirmed=true. Если браузер показал своё окно подтверждения — пользователь отвечает в нём сам.
- Выбрать файл с диска может только пользователь — попроси его.
- После действий коротко скажи, что сделано и что теперь на экране.
Как отвечать — выбери ОДИН из трёх способов (окно ассистента сворачивается само только в третьем):
1) ТОЛЬКО ТЕКСТ — вопрос о цифрах, выводах, сравнении, совете («какой средний балл», «кто хуже всех», «что улучшить», «почему»), если не просят показать. Инструменты показа не вызывай: ответ в окне, окно остаётся открытым.
2) ОДНО МЕСТО — ответ про один конкретный элемент, блок, диалог, критерий или реплику («что это за график», «покажи худший диалог», «где ошибка в диалоге 14»). Ровно один вызов показа: highlight (блок/элемент на текущем экране) или point_at_rows / point_at_criterion / point_at_message / open_conversation / open_page — и короткий ответ именно про это место. Окно остаётся открытым.
3) ЭКСКУРСИЯ — объяснение страницы, раздела, интерфейса или нескольких мест («что здесь», «объясни страницу», «как пользоваться», «покажи ошибки оператора по шагам»): один вызов tour, у каждого шага своё место и свой текст. Окно свернётся, указатель пройдёт по местам, текст шага покажется рядом с его местом.
Правила экскурсии (tour):
- Места текущего экрана — через ref: сначала открой нужный раздел (open_page или click по меню), потом read_screen, потом tour с ref из ЭТОГО снимка (b… — блоки, e… — кнопки и поля). Места в данных — шаг с conversation_ids, conversation_id+criterion_id или conversation_id+message_index; в одном tour не смешивай ref и переходы на другие страницы.
- Текст шага — ТОЛЬКО о месте этого шага: назови его так, как оно подписано на экране, и объясни, что это и что из этого следует, с цифрами из подписи этого блока. Не упоминай соседние блоки и не забегай вперёд — о следующем месте говорит следующий шаг.
- 1–2 коротких предложения на шаг, 3–7 шагов, порядок — сверху вниз по странице (или от общего к частному: строки списка → диалог → критерий → реплика).
- После tour — одна короткая фраза (что можно сделать дальше), пояснения не повторяй.
- Когда показываешь больше одного места, всегда используй tour, а не несколько отдельных вызовов показа: иначе указатель и текст разойдутся.`;

const MAX_STEPS = 24;

/**
 * Один ход диалога с ассистентом: модель ходит в инструменты, пока не даст текстовый ответ.
 * Инструменты управления сайтом выполняет браузер: тогда ход прерывается и возвращается { pending },
 * браузер делает действия и присылает resume = { contents, step, done, results } — ход продолжается.
 */
export async function assistantTurn(history, context, resume) {
  let contents;
  let startStep = 0;
  if (resume?.contents) {
    contents = resume.contents;
    startStep = Number(resume.step) || 0;
    // ответы на вызовы прошлого шага: посчитанные сервером + выполненные браузером, в исходном порядке
    const results = resume.results || [];
    const parts = (resume.done || []).map((d) =>
      d.client ? { functionResponse: { name: d.name, response: results.shift() || { error: 'браузер не выполнил действие' } } } : { functionResponse: { name: d.name, response: d.response } },
    );
    contents.push({ role: 'user', parts });
  } else {
    contents = history.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
    if (context?.route) contents[contents.length - 1].parts.unshift({ text: `(Служебное: сейчас на экране ${context.route})` });
  }
  const actions = [];
  const trace = [];
  for (let step = startStep; step < MAX_STEPS; step++) {
    // последний шаг — без инструментов: модель обязана ответить текстом по уже собранным данным
    const last = step === MAX_STEPS - 1;
    const { json } = await generateRaw({
      systemInstruction: { role: 'system', parts: [{ text: SYSTEM }] },
      contents,
      tools: [{ functionDeclarations: TOOLS }],
      ...(last ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
      generationConfig: { temperature: 0.2 },
    });
    const parts = json.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) {
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
      return { reply: text || 'Готово.', actions, trace };
    }
    contents.push({ role: 'model', parts });
    if (calls.some((fc) => CLIENT_TOOLS.has(fc.name))) {
      const done = calls.map((fc) => {
        trace.push(fc.name);
        if (CLIENT_TOOLS.has(fc.name)) return { name: fc.name, client: true };
        if (UI_TOOLS.has(fc.name)) {
          actions.push({ name: fc.name, args: fc.args || {} });
          return { name: fc.name, response: { result: 'показано на экране' } };
        }
        try {
          return { name: fc.name, response: dataTools[fc.name] ? { result: dataTools[fc.name](fc.args || {}) } : { error: 'нет такого инструмента' } };
        } catch (e) {
          return { name: fc.name, response: { error: e.message } };
        }
      });
      const clientCalls = calls.filter((fc) => CLIENT_TOOLS.has(fc.name)).map((fc) => ({ name: fc.name, args: fc.args || {} }));
      return { pending: { contents, step: step + 1, done, calls: clientCalls }, actions, trace };
    }
    const responses = calls.map((fc) => {
      let response;
      if (UI_TOOLS.has(fc.name)) {
        actions.push({ name: fc.name, args: fc.args || {} });
        response = { result: 'показано на экране. Если всё нужное уже показано — ответь пользователю текстом.' };
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
