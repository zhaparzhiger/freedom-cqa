// Выгрузка results.json по формату приложения к гайду (JSON 1.0) из базы приложения.
//   node scripts/results.js --group DEV --out results/dev/results.json
//   node scripts/results.js --group <контрольный group_id> --out results/prod/results.json --expect 10
// Только читает базу — можно запускать при работающем сервере.
import fs from 'node:fs';
import path from 'node:path';
import { load } from '../server/store.js';
import { buildResults, validateResults } from '../server/submission.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []),
);
if (!args.group || !args.out) {
  console.error('Использование: node scripts/results.js --group DEV --out results/dev/results.json [--expect 65]');
  process.exit(1);
}

load();
const doc = buildResults({ group: args.group });
const problems = validateResults(doc, { expectedCount: args.expect ? Number(args.expect) : undefined });
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(doc, null, 2) + '\n', 'utf8');

const errors = doc.results.filter((r) => r.status === 'error');
console.log(`${args.out}: ${doc.results.length} записей, ошибок ${errors.length}, модель: ${doc.model.name}`);
errors.forEach((r) => console.log(`  ошибка ${r.conversation_id}: ${r.error}`));
if (problems.length) {
  console.log(`Проблемы формата (${problems.length}):`);
  problems.slice(0, 30).forEach((p) => console.log('  - ' + p));
  process.exit(2);
}
console.log('Формат проверен: всё по правилам приложения.');
