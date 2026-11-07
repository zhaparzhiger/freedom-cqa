// Список диалогов: «требуют внимания», загрузка наборов, пакетная оценка, фильтры, карточки с отпечатком, экспорт.
import { api } from '../api.js';
import { esc, fmt, fmtDate, fmtUsd, toast, busy, band, icon, chev, CHANNEL, modeSelect, readMode, answerLabel, plural } from '../ui.js';
import { loadConversations, cachedDetail, prefetch, evalModel, topicOf, messages, durationOf } from '../data.js';
import { fingerprint } from '../viz.js';
import { formatSec } from '../transcript.js';
import { painted, keepScroll, refreshCounts, swap } from '../shell.js';

const EMPTY = { q: '', lang: '', channel: '', status: '', group: '', crit: '' };
const filters = { ...EMPTY };
let viewMode = 'cards';
/** Сброс фильтров списка (нужно ассистенту, чтобы показать строки, скрытые фильтром). */
export function setListFilters(next = {}) {
  Object.assign(filters, EMPTY, next);
}

const STATUS = [
  ['', 'Все'],
  ['gross', 'Грубые ошибки'],
  ['appeal', 'Апелляции'],
  ['review', 'Проверить'],
  ['none', 'Не оценены'],
];

let activeJob = null;
let pollTimer = null;
let loader = null;
let page = null; // { ctx, convs, checklists, activeId, activeVersion, job }

export async function renderList(ctx) {
  const [convs, { checklists, activeId }, jobs] = await Promise.all([loadConversations(), api.checklists(), api.jobs()]);
  if (!ctx.isCurrent()) return;
  const running = jobs.find((j) => j.status === 'running');
  if (running) activeJob = running.id;
  const active = checklists.find((c) => c.id === activeId);
  page = { ctx, convs, checklists, activeId, activeVersion: active?.version, job: running || null };
  draw();
  refreshCounts(convs);
  if (activeJob) pollJob();
  // карточки диалогов (транскрипт + оценка) догружаются фоном: из них строятся отпечатки и поиск по фразе
  loader?.stop();
  const my = prefetch(convs, (id) => {
    if (!ctx.isCurrent()) return my.stop();
    patchItem(id);
  });
  loader = my;
  my.done.then(() => {
    my.finished = true;
    if (ctx.isCurrent() && loader === my && (filters.q || filters.crit)) keepScroll(draw);
  });
}

// ── модель строки ─────────────────────────────────────────────────────
function rowModel(s) {
  const detail = cachedDetail(s);
  const ev = detail?.current || null;
  const model = ev ? evalModel(ev) : null;
  const msgs = detail ? messages(detail.conversation) : null;
  return { s, e: s.evaluation, detail, model, msgs, topic: detail ? topicOf(detail.conversation, ev) : null };
}

function matches(r) {
  const { s, e } = r;
  if (filters.lang && s.language !== filters.lang) return false;
  if (filters.channel && s.channel !== filters.channel) return false;
  if (filters.group && s.group !== filters.group) return false;
  if (filters.crit) {
    const row = r.model?.rows.find((x) => x.c.id === filters.crit);
    if (!row || (row.state !== 'x' && row.state !== 'c')) return false;
  }
  if (filters.q) {
    const q = filters.q.toLowerCase().trim();
    const hit = s.conversation_id.toLowerCase().includes(q) || (r.topic || '').toLowerCase().includes(q) || (r.detail?.conversation.transcript || []).some((m) => m.text.toLowerCase().includes(q));
    if (!hit) return false;
  }
  switch (filters.status) {
    case 'none': return !e;
    case 'review': return e?.needsReview > 0;
    case 'appeal': return e?.appeals > 0;
    case 'gross': return Boolean(e?.grossError);
    default: return true;
  }
}

const isRunning = (id) => Boolean(page.job?.running?.includes(id));
const outdated = (e) => e && (e.checklistId !== page.activeId || e.checklistVersion !== page.activeVersion);

// ── разметка ─────────────────────────────────────────────────────────
function draw() {
  const { ctx, convs, checklists, activeId } = page;
  const rows = convs.map(rowModel).filter(matches).sort((a, b) => a.s.conversation_id.localeCompare(b.s.conversation_id, 'ru', { numeric: true }));
  const evaluated = convs.filter((c) => c.evaluation);
  const totals = evaluated.map((c) => c.evaluation.total).filter((t) => t != null);
  const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
  const missing = convs.filter((c) => !c.evaluation || outdated(c.evaluation)).length;
  const groups = [...new Set(convs.map((c) => c.group))].sort();
  const langs = [...new Set(convs.map((c) => c.language))].filter(Boolean).sort();
  const attention = convs
    .filter((c) => c.evaluation && (c.evaluation.grossError || c.evaluation.openAppeals || c.evaluation.needsReview))
    .sort((a, b) => (b.evaluation.grossError ? 2 : b.evaluation.openAppeals ? 1 : 0) - (a.evaluation.grossError ? 2 : a.evaluation.openAppeals ? 1 : 0) || (a.evaluation.total ?? 0) - (b.evaluation.total ?? 0))
    .slice(0, 4);
  const critName = filters.crit && rows[0]?.model?.rows.find((x) => x.c.id === filters.crit)?.c.name;
  const sel = (key, opts, label) => `<select class="select" data-filter="${key}" aria-label="${label}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${filters[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  ctx.view.innerHTML = `<div class="page-anim">
    <section class="lane" data-field="lane">
      <div class="lane-l">
        <h1>Диалоги</h1>
        <p>${convs.length ? `Оценено <b class="roll" data-roll="${evaluated.length}" data-key="scored">${evaluated.length}</b> из ${convs.length}${avg != null ? ` · средний балл <b class="roll" data-roll="${fmt(avg)}" data-key="avg">${fmt(avg)}</b>` : ''}` : 'Загрузите набор из API организаторов или JSON-файл.'}</p>
        <button type="button" class="btn lime" id="run-missing" ${missing && !activeJob ? '' : 'disabled'} title="Оценить диалоги без оценки или оценённые прошлой версией чек-листа">${icon('spark')}${missing ? `Оценить новые · ${missing}` : 'Все оценены'}</button>
        <div id="job-box" class="job-box"></div>
      </div>
      <div class="lane-r">
        <span class="cap">Требуют внимания · ${attention.length}</span>
        <div class="att">${attention.length ? attention.map(attHtml).join('') : '<p class="att-none">Грубых ошибок, открытых апелляций и спорных оценок нет.</p>'}</div>
      </div>
    </section>

    ${opsHtml(checklists, activeId, rows.length, groups)}

    <div class="toolbar">
      <label class="search">${icon('search')}<input class="input" type="search" data-input="q" placeholder="ID, тема или фраза из разговора" value="${esc(filters.q)}" aria-label="Поиск"></label>
      <div class="seg" role="group" aria-label="Статус">${STATUS.map(([v, l]) => `<button type="button" data-status="${v}" aria-pressed="${filters.status === v}">${l}</button>`).join('')}</div>
      <div class="end">
        ${sel('channel', [['', 'Все каналы'], ['agent chat', 'Чаты'], ['voice call', 'Звонки']], 'Канал')}
        ${sel('lang', [['', 'Все языки'], ...langs.map((l) => [l, l])], 'Язык')}
        ${groups.length > 1 ? sel('group', [['', 'Все наборы'], ...groups.map((g) => [g, g])], 'Набор') : ''}
        <div class="seg view" role="group" aria-label="Вид"><button type="button" data-view="cards" aria-pressed="${viewMode === 'cards'}" aria-label="Карточки">${icon('grid')}</button><button type="button" data-view="table" aria-pressed="${viewMode === 'table'}" aria-label="Таблица">${icon('list')}</button></div>
      </div>
    </div>
    ${filters.crit ? `<div class="chips"><button type="button" class="pill appeal" data-clear-crit>Не выполнен: ${esc(critName || filters.crit)} ${icon('x')}</button></div>` : ''}
    <p class="count-line">${rows.length} из ${convs.length} ${plural(convs.length, 'диалога', 'диалогов', 'диалогов')}${filters.q && loader && !loader.finished ? ' · поиск по фразам идёт по мере загрузки' : ''}</p>
    ${!convs.length ? '<div class="sheet empty"><b>Диалогов пока нет</b>Загрузите набор DEV из API организаторов или JSON-файл с транскриптами.</div>'
      : !rows.length ? '<div class="sheet empty"><b>Ничего не найдено</b>Снимите фильтр или измените запрос.</div>'
      : viewMode === 'cards' ? `<ul class="cards">${rows.map(cardHtml).join('')}</ul>` : `<div class="sheet"><ul class="rows">${rows.map(tableRowHtml).join('')}</ul></div>`}
  </div>`;
  bind();
  painted(ctx.view, 'list');
  if (activeJob && page.job) jobHtml(page.job);
}

function attHtml(c) {
  const e = c.evaluation;
  const why = e.grossError ? 'Грубая ошибка' : e.openAppeals ? 'Апелляция ждёт решения' : `ИИ не уверен: ${e.needsReview} ${plural(e.needsReview, 'критерий', 'критерия', 'критериев')}`;
  const r = rowModel(c);
  return `<a href="#/c/${encodeURIComponent(c.conversation_id)}" class="att-i" data-row-id="${esc(c.conversation_id)}"><b class="${e.grossError ? 'c' : 'a'}">${fmt(e.total, 1)}</b><span>${esc(r.topic || c.conversation_id)}<small>${esc(c.conversation_id)} · ${why}</small></span>${icon('right')}</a>`;
}

function opsHtml(checklists, activeId, filtered, groups) {
  return `<section class="sheet ops">
    <div class="ops-b">
      <form id="import-form" class="ops-col">
        <span class="cap">${icon('db')} Источник данных</span>
        <div class="ops-row">
          <input class="input" name="group" placeholder="group_id, например DEV" value="${esc(groups.length === 1 ? groups[0] : 'DEV')}" autocomplete="off" required aria-label="group_id набора">
          <button class="btn" type="submit">Загрузить набор</button>
        </div>
        <label class="btn quiet sm file-btn">${icon('upload')}Загрузить JSON-файл<input type="file" id="file-input" accept=".json,application/json" hidden></label>
      </form>
      <div class="ops-col">
        <span class="cap">${icon('spark')} Пакетная оценка</span>
        <div class="ops-row">
          <select class="select" id="checklist-select" aria-label="Чек-лист">${checklists.map((c) => `<option value="${c.id}" ${c.id === activeId ? 'selected' : ''}>${esc(c.name)} · v${c.version}${c.id === activeId ? ' (активный)' : ''}</option>`).join('')}</select>
          ${modeSelect('mode-select')}
        </div>
        <div class="ops-row">
          <button class="btn primary sm" id="eval-missing" type="button">Оценить все неоценённые</button>
          <button class="btn sm" id="eval-filtered" type="button" ${filtered ? '' : 'disabled'} title="Заново оценить диалоги, которые сейчас показаны фильтром">Оценить показанные · ${filtered}</button>
        </div>
      </div>
      <div class="ops-col">
        <span class="cap">${icon('download')} Выгрузка</span>
        <a class="btn sm primary-soft" href="${api.resultsUrl(filters.group)}" download="results.json" title="Формат JSON 1.0 из приложения к гайду">results.json для сдачи</a>
        <div class="ops-row">
          <a class="btn sm" href="${api.exportUrl('csv')}" download>Экспорт CSV</a>
          <a class="btn sm" href="${api.exportUrl('json')}" download>Экспорт JSON</a>
        </div>
      </div>
    </div>
  </section>`;
}

function pills(r) {
  const { s, e } = r;
  const out = [];
  if (isRunning(s.conversation_id)) out.push('<span class="pill">Оценивается…</span>');
  if (!e && !isRunning(s.conversation_id)) out.push('<span class="pill">Не оценён</span>');
  if (e?.openAppeals) out.push('<span class="pill appeal">Апелляция</span>');
  else if (e?.changed) out.push('<span class="pill">Пересмотрено</span>');
  if (e?.needsReview) out.push(`<span class="pill warn" title="ИИ не уверен в части критериев">Проверить · ${e.needsReview}</span>`);
  if (outdated(e)) out.push('<span class="pill">Старый чек-лист</span>');
  return out.join('');
}

function cardHtml(r, k) {
  const { s, e, model, msgs } = r;
  const id = s.conversation_id;
  const v = e?.total ?? null;
  const gross = Boolean(e?.grossError);
  const running = isRunning(id);
  const st = !e ? (running ? 'running' : 'wait') : `b-${gross ? 'low' : band(v)}`;
  const flag = model?.flags[0];
  const q = flag?.item?.evidence?.length && r.detail ? r.detail.conversation.transcript[flag.item.evidence[0]]?.text : null;
  const score = `<div class="cv-score">${v == null ? '<b class="g-num none">—</b>' : `<b class="g-num roll" data-roll="${fmt(v, 1)}" data-key="cv:${esc(id)}">${fmt(v, 1)}</b>`}<span class="mini${v == null ? '' : ` m-${band(v)}`}" aria-hidden="true"${v == null ? '' : ` style="--v:${v}"`}><i></i><i></i><i></i>${v == null ? '' : '<em></em>'}</span></div>`;
  let body = '';
  if (model) {
    const scored = model.rows.filter((x) => x.c.type !== 'flag');
    const t = { v: scored.filter((x) => x.state === 'v').length, x: scored.filter((x) => x.state === 'x').length, n: scored.filter((x) => x.state === 'na').length };
    const miss = scored.find((x) => x.state === 'x');
    body =
      `<div class="cv-secs">${model.final.sections.map((sec) => `<div><span title="${esc(sec.name)}">${esc(sec.name.split(' ')[0])}</span><i><em class="${sec.percent == null ? 'na' : band(sec.percent)}" style="--w:${sec.percent ?? 0}%"></em></i><b>${sec.percent == null ? 'N/A' : Math.round(sec.percent)}</b></div>`).join('')}</div>` +
      `<div class="cv-tally"><span class="t-v${t.v ? '' : ' zero'}"><i></i>${t.v} выполнено</span><span class="t-x${t.x ? '' : ' zero'}"><i></i>${t.x} с потерей</span>${t.n ? `<span class="t-n"><i></i>${t.n} N/A</span>` : ''}</div>` +
      (q ? `<p class="cv-q"><span>${icon('alert')}Грубая ошибка · ${esc(flag.c.name)}</span><em>«${esc(q)}»</em></p>` : flag ? `<p class="cv-q"><span>${icon('alert')}Грубая ошибка · ${esc(flag.c.name)}</span><em>${esc(flag.item?.explanation || '')}</em></p>` : `<p class="cv-note">${miss ? `<span>Зона роста</span>${esc(miss.c.name)}` : '<span>Без замечаний</span>Все применимые пункты чек-листа выполнены'}</p>`);
  } else if (e) {
    body = '<div class="cv-skel" aria-hidden="true"><i></i><i></i></div>';
  }
  const dur = msgs ? formatSec(durationOf(msgs)) : null;
  return `<li style="--i:${Math.min(k, 18)}" data-row-id="${esc(id)}"><a class="cv ${st}${gross ? ' crit' : ''}" href="#/c/${encodeURIComponent(id)}" aria-label="${esc(`${id}${v == null ? ', не оценён' : `, итог ${fmt(v)}`}`)}">
    <div class="cv-head">${score}<div class="cv-id"><b>${esc(r.topic || id)}</b><span>${esc(id)}${s.group ? ` · ${esc(s.group)}` : ''}</span></div></div>
    <div class="cv-meta"><span>${icon(s.channel === 'voice call' ? 'call' : 'chat')}${CHANNEL[s.channel] || esc(s.channel)}</span><span>${esc(s.language || '—')}</span>${dur ? `<span>${icon('clock')}${dur}</span>` : ''}<span>${s.turns} реплик</span>${e ? `<span>оценён ${fmtDate(e.createdAt)}</span>` : ''}</div>
    <div class="cv-fp"><span class="fp-l">оператор<br>клиент</span>${msgs ? fingerprint(msgs, model) : '<span class="fp-wait">Загружаю ход разговора…</span>'}</div>
    ${body}
    <div class="cv-foot"><span class="pills">${pills(r)}</span><span class="open">Открыть${icon('arrow')}</span></div>
  </a></li>`;
}

function tableRowHtml(r, k) {
  const { s, e, model } = r;
  const v = e?.total ?? null;
  const id = s.conversation_id;
  return `<li style="--i:${Math.min(k, 18)}" data-row-id="${esc(id)}"><a class="row${isRunning(id) ? ' running' : ''}" href="#/c/${encodeURIComponent(id)}">
    ${v == null ? `<span class="sc none">${isRunning(id) ? 'оценка…' : 'не оценён'}</span>` : `<span class="sc c-${e.grossError ? 'low' : band(v)}">${fmt(v, 1)}${e.changed ? `<small class="was-ai">ИИ ${fmt(e.originalTotal, 1)}</small>` : ''}</span>`}
    <span class="t"><b>${esc(r.topic || id)}</b><span>${esc(id)}${e ? ` · ${esc(e.checklistName)} v${e.checklistVersion}` : ''}</span></span>
    <span class="ch">${CHANNEL[s.channel] || esc(s.channel)} · ${esc(s.language)}${s.hasAudio ? ' · запись' : ''}</span>
    ${model ? `<span class="strip">${model.rows.map((x) => `<i class="${x.state}" title="${esc(`${x.code} · ${x.c.name} · ${answerLabel(x.c, x.finalAnswer)}`)}"></i>`).join('')}</span>` : '<span></span>'}
    <span class="flags">${e?.grossError ? '<span class="pill crit">Грубая ошибка</span>' : ''}${pills(r)}</span>${icon('right', 'go')}
  </a></li>`;
}

/** Карточка догрузилась — подменяем только её, не трогая остальной экран. */
function patchItem(id) {
  const s = page?.convs.find((c) => c.conversation_id === id);
  if (!s) return;
  const att = page.ctx.view.querySelector(`.att-i[data-row-id="${CSS.escape(id)}"]`);
  if (att) att.outerHTML = attHtml(s);
  const li = page.ctx.view.querySelector(`li[data-row-id="${CSS.escape(id)}"]`);
  if (!li) return;
  const r = rowModel(s);
  if (!matches(r)) return;
  const k = parseInt(li.style.getPropertyValue('--i'), 10) || 0;
  const tmp = document.createElement('ul');
  tmp.innerHTML = viewMode === 'cards' ? cardHtml(r, k) : tableRowHtml(r, k);
  const next = tmp.firstElementChild;
  next.className = li.className;
  if (li.firstElementChild?.classList.contains('ai-focus')) next.firstElementChild.classList.add('ai-focus');
  li.replaceWith(next);
}

// ── события ──────────────────────────────────────────────────────────
function bind() {
  const { ctx } = page;
  const $ = (s) => ctx.view.querySelector(s);
  const rerender = () => keepScroll(draw);

  $('#import-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    const group = new FormData(ev.target).get('group').trim();
    busy(btn, true, 'Загружаю…');
    try {
      const r = await api.importGroup(group);
      toast(`Набор ${r.group}: новых ${r.added}, обновлено ${r.updated}${r.errors.length ? `, с ошибками ${r.errors.length}` : ''}`, 'ok');
      renderList(ctx);
    } catch (e) {
      toast(e.message, 'error');
      busy(btn, false);
    }
  });

  $('#file-input').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const r = await api.upload(payload, file.name.replace(/\.json$/i, ''));
      toast(`Файл ${file.name}: новых ${r.added}, обновлено ${r.updated}${r.errors.length ? `, с ошибками ${r.errors.length}` : ''}`, r.errors.length ? 'error' : 'ok');
      renderList(ctx);
    } catch (e) {
      toast(`Файл не загружен: ${e.message}`, 'error');
    }
  });

  const start = async (body, btn) => {
    busy(btn, true, 'Запускаю…');
    try {
      const job = await api.startJob({ ...body, checklistId: $('#checklist-select').value, ...readMode($('#mode-select').value) });
      activeJob = job.id;
      page.job = job;
      toast(`Запущена оценка: ${job.total} ${plural(job.total, 'диалог', 'диалога', 'диалогов')}`, 'ok');
      rerender();
      pollJob();
    } catch (e) {
      toast(e.message, 'error');
      busy(btn, false);
    }
  };
  $('#run-missing').addEventListener('click', (ev) => start({ onlyMissing: true, group: filters.group || undefined }, ev.currentTarget));
  $('#eval-missing').addEventListener('click', (ev) => start({ onlyMissing: true, group: filters.group || undefined }, ev.currentTarget));
  $('#eval-filtered').addEventListener('click', (ev) => {
    const ids = [...ctx.view.querySelectorAll('li[data-row-id]')].map((li) => li.dataset.rowId);
    if (!ids.length) return;
    if (!confirm(`Оценить заново ${ids.length} ${plural(ids.length, 'диалог', 'диалога', 'диалогов')}? Каждый диалог — вызовы модели и расходы.`)) return;
    start({ conversationIds: ids }, ev.currentTarget);
  });

  ctx.view.querySelectorAll('[data-status]').forEach((b) =>
    b.addEventListener('click', () => {
      filters.status = b.dataset.status;
      rerender();
    }),
  );
  ctx.view.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      viewMode = b.dataset.view;
      swap(rerender);
    }),
  );
  ctx.view.querySelectorAll('[data-filter]').forEach((sel) =>
    sel.addEventListener('change', () => {
      filters[sel.dataset.filter] = sel.value;
      rerender();
    }),
  );
  $('[data-clear-crit]')?.addEventListener('click', () => {
    filters.crit = '';
    rerender();
  });
  let t;
  $('[data-input="q"]').addEventListener('input', (ev) => {
    clearTimeout(t);
    t = setTimeout(() => {
      filters.q = ev.target.value;
      const pos = ev.target.selectionStart;
      rerender();
      const q = ctx.view.querySelector('[data-input="q"]');
      q.focus();
      q.setSelectionRange(pos, pos);
    }, 220);
  });
}

/** Фильтр «критерий не выполнен» — для перехода из аналитики. */
export function showFailing(criterionId) {
  setListFilters({ crit: criterionId });
  viewMode = 'cards';
}

// ── пакетная оценка: прогресс и стоимость ────────────────────────────
function jobHtml(job) {
  const box = page?.ctx.view.querySelector('#job-box');
  if (!box) return;
  const pct = job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 100;
  box.innerHTML = `
    <div class="job">
      <div class="job-line"><b>${job.status === 'running' ? 'Идёт оценка' : 'Оценка завершена'}</b><span>${job.done + job.failed} из ${job.total}${job.failed ? ` · ошибок ${job.failed}` : ''} · ${fmtUsd(job.costUsd)} · «${esc(job.checklistName)}»</span></div>
      <div class="prog"><i style="width:${pct}%"></i></div>
      ${job.errors.length ? `<details class="more job-err"><summary>Ошибки (${job.errors.length})${chev}</summary>${job.errors.slice(0, 20).map((e) => `<div>${esc(e.conversation_id)}: ${esc(e.error)}</div>`).join('')}</details>` : ''}
    </div>`;
}

function pollJob() {
  clearTimeout(pollTimer);
  const tick = async () => {
    if (!activeJob || !page?.ctx.isCurrent()) return;
    let job;
    try {
      job = await api.job(activeJob);
    } catch {
      activeJob = null;
      return;
    }
    page.job = job;
    jobHtml(job);
    // отметка «оценивается» на карточках
    page.ctx.view.querySelectorAll('li[data-row-id]').forEach((li) => {
      const on = job.running.includes(li.dataset.rowId);
      li.querySelector('.cv, .row')?.classList.toggle('running', on);
    });
    if (job.status === 'running') pollTimer = setTimeout(tick, 1500);
    else {
      activeJob = null;
      toast(`Оценка завершена: ${job.done} ${plural(job.done, 'диалог', 'диалога', 'диалогов')}${job.failed ? `, ошибок ${job.failed}` : ''}, ${fmtUsd(job.costUsd)}`, job.failed ? 'error' : 'ok');
      const finished = job;
      setTimeout(async () => {
        if (!page?.ctx.isCurrent()) return;
        await renderList(page.ctx);
        page.job = null;
        jobHtml(finished);
      }, 600);
    }
  };
  tick();
}

