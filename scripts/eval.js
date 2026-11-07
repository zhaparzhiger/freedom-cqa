// Пакетная оценка из консоли (без интерфейса) — для замера точности и сравнения моделей.
//   node scripts/eval.js --group DEV --model gemini-3.8-flash --votes 1 --out data/runs/flash.json [--ids p1-ru-001,p1-ru-002] [--limit 10]
// Без --out результаты сохраняются в базу приложения (видны в интерфейсе).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/env.js';
import { load, getDb, save, flush } from '../server/store.js';
import { evaluateConversation } from '../server/evaluate.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []),
);

load();
const db = getDb();
const checklist = db.checklists.find((c) => c.id === (args.checklist || db.activeChecklistId));
let convs = Object.values(db.conversations);
if (args.group) convs = convs.filter((c) => c.group === args.group);
if (args.ids) convs = convs.filter((c) => String(args.ids).split(',').includes(c.conversation_id));
if (args.limit) convs = convs.slice(0, Number(args.limit));
if (!convs.length) {
  console.error('Нет диалогов. Сначала загрузите набор в интерфейсе или через POST /api/import.');
  process.exit(1);
}

const model = args.model || config.model;
const votes = Number(args.votes || config.votes);
const mode = args.mode || config.mode;
const concurrency = Number(args.concurrency || config.concurrency);
console.log(`Оценка ${convs.length} диалогов · ${model} · режим ${mode} · прогонов ${votes} · чек-лист «${checklist.name}» v${checklist.version}`);

const results = [];
const queue = [...convs];
let done = 0;
let cost = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const conv = queue.shift();
      try {
        const ev = await evaluateConversation(conv, checklist, { votes, model, mode });
        cost += ev.costUsd;
        if (args.out) results.push(ev);
        else {
          db.evaluations.push(ev);
          save();
        }
        done++;
        process.stdout.write(`\r${done}/${convs.length}  $${cost.toFixed(4)}   `);
      } catch (e) {
        console.error(`\n${conv.conversation_id}: ${e.message}`);
      }
    }
  }),
);
console.log();
if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(results.map(({ raw, ...r }) => r), null, 1));
  console.log(`Сохранено: ${args.out}`);
} else flush();
console.log(`Стоимость: $${cost.toFixed(4)} · в среднем $${(cost / Math.max(1, done)).toFixed(5)} за диалог`);
