// Тест языковой честности: одинаково ли ИИ оценивает один и тот же диалог на разных языках.
//
// Номера диалогов в DEV на разных языках не совпадают по содержанию, поэтому сравнивать «p1-ru-001 с p1-kz-001»
// нельзя — там разные операторы и разные ошибки. Делаем контрфактический тест: берём русский диалог,
// переводим каждую реплику на казахский и английский (смысл, ошибки оператора и порядок реплик сохраняются)
// и оцениваем все версии. Плюс повторно оцениваем русский оригинал — это шум модели между прогонами.
// Если разница «язык» заметно больше «шума», это предвзятость модели к языку.
import { generate } from './gemini.js';
import { getDb, save, now, newId } from './store.js';
import { evaluateConversation } from './evaluate.js';
import { latestEvaluation } from './results.js';
import { config } from './env.js';

const db = () => getDb();
const LANG_NAME = { KZ: 'казахский', EN: 'английский' };
let current = null;

async function translate(record, lang) {
  const turns = record.transcript.map((t) => t.text);
  // у каждой реплики своё обязательное поле t0…tN — модель не может склеить или потерять реплики
  const keys = turns.map((_, i) => `t${i}`);
  const res = await generate({
    system: 'Ты профессиональный переводчик диалогов службы поддержки. Отвечай JSON.',
    user: `Переведи каждую реплику диалога на ${LANG_NAME[lang]} язык. Сохрани смысл, тон, вежливость и грубость, ошибки и недосказанность оператора — перевод не должен ни улучшать, ни ухудшать работу оператора. Имена людей не меняй. Названия разделов приложения переводи так, как их написал бы клиент на этом языке. Перевод реплики [i] положи в поле t{i}.

${turns.map((t, i) => `[${i}] ${record.transcript[i].speaker}: ${t}`).join('\n')}`,
    schema: { type: 'OBJECT', properties: Object.fromEntries(keys.map((k) => [k, { type: 'STRING' }])), required: keys, propertyOrdering: keys },
  });
  const json = JSON.parse(res.text);
  const out = keys.map((k, i) => (typeof json[k] === 'string' && json[k].trim() ? json[k] : null) ?? turns[i]);
  if (keys.some((k) => typeof json[k] !== 'string')) throw new Error('перевод пропустил реплики');
  return {
    ...record,
    conversation_id: `${record.conversation_id}→${lang}`,
    language: lang,
    transcript: record.transcript.map((t, i) => ({ ...t, text: out[i] })),
  };
}

const answersOf = (ev) => Object.fromEntries(ev.items.map((i) => [i.criterionId, i.answer]));

export function parityState() {
  return { running: current && current.status === 'running' ? current : null, runs: (db().parityRuns || []).slice(-3).reverse() };
}

export function startParity({ n = 8, languages = ['KZ', 'EN'] } = {}) {
  if (current?.status === 'running') throw Object.assign(new Error('Тест уже идёт'), { status: 400 });
  const checklist = db().checklists.find((c) => c.id === db().activeChecklistId);
  const sources = Object.values(db().conversations)
    .filter((c) => c.language === 'RU' && c.channel === 'agent chat')
    .sort((a, b) => a.conversation_id.localeCompare(b.conversation_id))
    .slice(0, Math.max(2, Math.min(30, Number(n) || 8)));
  const run = {
    id: newId('par'),
    createdAt: now(),
    status: 'running',
    model: config.model,
    mode: config.mode,
    checklist: `${checklist.name} v${checklist.version}`,
    languages,
    total: sources.length,
    done: 0,
    costUsd: 0,
    rows: [],
    summary: null,
  };
  current = run;
  const queue = [...sources];
  const worker = async () => {
    while (queue.length) {
      const conv = queue.shift();
      try {
        let base = latestEvaluation(conv.conversation_id);
        if (!base || base.checklistId !== checklist.id || base.checklistVersion !== checklist.version) {
          base = await evaluateConversation(conv, checklist);
          run.costUsd += base.costUsd;
        }
        const variants = [{ lang: 'RU (повтор)', record: conv }];
        for (const lang of languages) variants.push({ lang, record: await translate(conv, lang) });
        const results = await Promise.all(
          variants.map(async (v) => {
            const ev = await evaluateConversation(v.record, checklist);
            run.costUsd += ev.costUsd;
            return { lang: v.lang, total: ev.score.total, answers: answersOf(ev) };
          }),
        );
        const baseAnswers = answersOf(base);
        run.rows.push({
          conversationId: conv.conversation_id,
          ru: base.score.total,
          variants: results.map((r) => ({
            lang: r.lang,
            total: r.total,
            delta: r.total != null && base.score.total != null ? Math.round((r.total - base.score.total) * 100) / 100 : null,
            agree: checklist.criteria.filter((c) => baseAnswers[c.id] === r.answers[c.id]).length,
            of: checklist.criteria.length,
            diff: checklist.criteria.filter((c) => baseAnswers[c.id] !== r.answers[c.id]).map((c) => `${c.id}: ${baseAnswers[c.id]}→${r.answers[c.id]}`),
          })),
        });
      } catch (e) {
        run.rows.push({ conversationId: conv.conversation_id, error: e.message });
      }
      run.done++;
    }
  };
  Promise.all(Array.from({ length: 2 }, worker)).then(() => {
    const langs = ['RU (повтор)', ...languages];
    run.summary = langs.map((lang) => {
      const vs = run.rows.flatMap((r) => (r.variants || []).filter((v) => v.lang === lang && v.delta != null));
      const mean = (f) => (vs.length ? Math.round((vs.reduce((s, v) => s + f(v), 0) / vs.length) * 100) / 100 : null);
      return {
        lang,
        n: vs.length,
        meanDelta: mean((v) => v.delta),
        meanAbsDelta: mean((v) => Math.abs(v.delta)),
        agreement: vs.length ? Math.round((vs.reduce((s, v) => s + v.agree, 0) / vs.reduce((s, v) => s + v.of, 0)) * 1000) / 10 : null,
      };
    });
    run.status = 'finished';
    run.finishedAt = now();
    (db().parityRuns ||= []).push(run);
    save();
  });
  return run;
}
