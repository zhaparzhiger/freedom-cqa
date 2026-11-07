// Контрольный этап одной командой (сервер должен быть запущен: npm start).
//   node scripts/control.js --group <group_id>            — набор из API организаторов по group_id
//   node scripts/control.js --url "<полная GET-ссылка>"    — если выдадут отдельную ссылку
//   node scripts/control.js --file prod.json               — если выдадут файл
// Добавьте --push, чтобы сразу сделать commit и push results/prod/results.json.
// Шаги: загрузка → оценка (мультиагентный конвейер) → повтор упавших → results/prod/results.json → проверка → git.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : acc), []),
);
const BASE = args.server || `http://localhost:${process.env.PORT || 8870}`;
const OUT = args.out || 'results/prod/results.json';
const EXPECT = args.expect ? Number(args.expect) : 10;
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} с] ${m}`);

async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function runJob(ids) {
  let job = await api('POST', '/api/jobs', { conversationIds: ids, mode: 'agents' });
  log(`оценка ${job.total} диалогов запущена`);
  let last = -1;
  while (job.status === 'running') {
    await new Promise((r) => setTimeout(r, 3000));
    job = await api('GET', `/api/jobs/${job.id}`);
    if (job.done + job.failed !== last) log(`  ${job.done + job.failed}/${job.total} · ошибок ${job.failed} · $${job.costUsd.toFixed(3)}`);
    last = job.done + job.failed;
  }
  return job;
}

try {
  await api('GET', '/api/meta').catch(() => {
    throw new Error(`сервер не отвечает на ${BASE} — запустите npm start`);
  });

  // 1. загрузка
  let imp;
  const group = args.name || 'PROD';
  if (args.file) {
    const payload = JSON.parse(fs.readFileSync(args.file, 'utf8'));
    imp = await api('POST', '/api/upload', { payload, group });
  } else if (args.url) imp = await api('POST', '/api/import', { url: args.url, group });
  else if (args.group) imp = await api('POST', '/api/import', { groupId: args.group, group });
  else throw new Error('укажите --group, --url или --file');
  const ids = imp.ids || [];
  log(`загружено ${ids.length} диалогов в набор «${group}»${imp.errors?.length ? `, с ошибками формата ${imp.errors.length}` : ''}`);
  if (ids.length !== EXPECT) log(`ВНИМАНИЕ: ожидалось ${EXPECT} диалогов`);

  // 2. оценка + до двух повторов для упавших и неполных диалогов
  await runJob(ids);
  let res = await api('GET', `/api/results?group=${encodeURIComponent(group)}`);
  for (let round = 1; round <= 2; round++) {
    const bad = res.doc.results.filter((r) => r.status !== 'ok').map((r) => r.conversation_id);
    if (!bad.length) break;
    log(`повтор ${round}: ${bad.join(', ')}`);
    await new Promise((r) => setTimeout(r, 15000)); // даём лимиту запросов восстановиться
    await runJob(bad);
    res = await api('GET', `/api/results?group=${encodeURIComponent(group)}`);
  }

  // 3. выгрузка и проверка
  fs.mkdirSync('results/prod', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(res.doc, null, 2) + '\n', 'utf8');
  log(`${OUT}: ${res.count} записей, со status=error: ${res.errors}`);
  if (res.problems.length) {
    console.log('Проблемы формата:');
    res.problems.forEach((p) => console.log('  - ' + p));
  } else log('формат проверен по приложению к гайду');
  if (res.count !== EXPECT) log(`ВНИМАНИЕ: в файле ${res.count} записей, а в prod должно быть ровно ${EXPECT}`);

  // 4. git
  if (args.push) {
    execFileSync('git', ['add', OUT], { stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', `Результаты по контрольному набору (${res.count} диалогов)`], { stdio: 'inherit' });
    execFileSync('git', ['push'], { stdio: 'inherit' });
    log('commit и push выполнены');
  } else log('проверьте файл и выполните: git add results/prod/results.json && git commit -m "prod results" && git push');
} catch (e) {
  console.error(`ОШИБКА: ${e.message}`);
  process.exit(1);
}
