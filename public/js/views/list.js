// Список диалогов: загрузка наборов, пакетная оценка, фильтры, экспорт.
import { api } from '../api.js';
import { esc, fmt, fmtDate, fmtUsd, toast, busy, scoreTone, LANG, CHANNEL, modeSelect, readMode } from '../ui.js';

const filters = { q: '', lang: '', channel: '', status: '', group: '' };
/** Сброс фильтров списка (нужно ассистенту, чтобы показать строки, скрытые фильтром). */
export function setListFilters(next = {}) {
  Object.assign(filters, { q: '', lang: '', channel: '', status: '', group: '' }, next);
}
let activeJob = null;
let pollTimer = null;

const STATUS = {
  '': 'Все',
  none: 'Не оценены',
  done: 'Оценены',
  review: 'ИИ не уверен',
  appeal: 'Есть апелляция',
  gross: 'Грубая ошибка',
};

function matches(c) {
  const e = c.evaluation;
  if (filters.q && !c.conversation_id.toLowerCase().includes(filters.q.toLowerCase())) return false;
  if (filters.lang && c.language !== filters.lang) return false;
  if (filters.channel && c.channel !== filters.channel) return false;
  if (filters.group && c.group !== filters.group) return false;
  switch (filters.status) {
    case 'none': return !e;
    case 'done': return Boolean(e);
    case 'review': return e?.needsReview > 0;
    case 'appeal': return e?.appeals > 0;
    case 'gross': return e?.grossError;
    default: return true;
  }
}

export async function renderList(ctx) {
  const [convs, { checklists, activeId }, jobs] = await Promise.all([api.conversations(), api.checklists(), api.jobs()]);
  if (!ctx.isCurrent()) return;
  const groups = [...new Set(convs.map((c) => c.group))].sort();
  const langs = [...new Set(convs.map((c) => c.language))].filter(Boolean).sort();
  const running = jobs.find((j) => j.status === 'running');
  if (running) activeJob = running.id;

  const rows = convs.filter(matches).sort((a, b) => a.conversation_id.localeCompare(b.conversation_id, 'ru', { numeric: true }));
  const evaluated = convs.filter((c) => c.evaluation);
  const avg = evaluated.length ? evaluated.reduce((s, c) => s + (c.evaluation.total ?? 0), 0) / evaluated.filter((c) => c.evaluation.total != null).length : null;

  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Диалоги</h1>
        <p class="muted">${convs.length} диалогов · оценено ${evaluated.length}${avg != null ? ` · средний балл ${fmt(avg)}` : ''}</p>
      </div>
      <div class="head-actions">
        <a class="btn ghost" href="${api.exportUrl('csv')}" download>Экспорт CSV</a>
        <a class="btn ghost" href="${api.exportUrl('json')}" download>Экспорт JSON</a>
      </div>
    </div>

    <section class="panel load-panel">
      <form id="import-form" class="inline-form">
        <label class="field">
          <span>Набор из API организаторов</span>
          <input name="group" placeholder="group_id, например DEV" value="DEV" autocomplete="off" required>
        </label>
        <button class="btn" type="submit">Загрузить набор</button>
        <span class="or">или</span>
        <label class="btn ghost file-btn">Загрузить JSON-файл<input type="file" id="file-input" accept=".json,application/json" hidden></label>
      </form>
      <div class="inline-form eval-form">
        <label class="field">
          <span>Чек-лист</span>
          <select id="checklist-select">
            ${checklists.map((c) => `<option value="${c.id}" ${c.id === activeId ? 'selected' : ''}>${esc(c.name)} · v${c.version}${c.id === activeId ? ' (активный)' : ''}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>Режим оценки</span>
          ${modeSelect('mode-select')}
        </label>
        <button class="btn primary" id="eval-selected" type="button" disabled>Оценить выбранные</button>
        <button class="btn" id="eval-missing" type="button">Оценить все неоценённые</button>
      </div>
      <div id="job-box"></div>
    </section>

    <div class="filters">
      <input type="search" id="f-q" placeholder="Поиск по ID" value="${esc(filters.q)}">
      <select id="f-status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${filters.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <select id="f-lang"><option value="">Все языки</option>${langs.map((l) => `<option value="${l}" ${filters.lang === l ? 'selected' : ''}>${LANG[l] || l}</option>`).join('')}</select>
      <select id="f-channel"><option value="">Все каналы</option><option value="agent chat" ${filters.channel === 'agent chat' ? 'selected' : ''}>Чаты</option><option value="voice call" ${filters.channel === 'voice call' ? 'selected' : ''}>Звонки</option></select>
      ${groups.length > 1 ? `<select id="f-group"><option value="">Все наборы</option>${groups.map((g) => `<option value="${esc(g)}" ${filters.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>` : ''}
      <span class="muted count">${rows.length} из ${convs.length}</span>
    </div>

    ${convs.length ? `
    <div class="table-wrap">
      <table class="table">
        <thead><tr>
          <th class="check"><input type="checkbox" id="check-all" aria-label="Выбрать все"></th>
          <th>Диалог</th><th>Канал</th><th>Язык</th><th class="num">Реплик</th>
          <th class="num">Итог</th><th>Статус</th><th>Оценка</th>
        </tr></thead>
        <tbody>
          ${rows.map((c) => rowHtml(c)).join('')}
        </tbody>
      </table>
    </div>` : `
    <div class="empty">
      <h2>Диалогов пока нет</h2>
      <p>Загрузите набор DEV из API организаторов или JSON-файл с транскриптами.</p>
    </div>`}
  `;

  bind(ctx, convs);
  if (activeJob) pollJob(ctx);
}

function rowHtml(c) {
  const e = c.evaluation;
  const badges = [];
  if (e?.grossError) badges.push('<span class="tag bad">Грубая ошибка</span>');
  if (e?.openAppeals) badges.push(`<span class="tag warn">Апелляция: ${e.openAppeals}</span>`);
  else if (e?.changed) badges.push('<span class="tag info">Пересмотрено</span>');
  if (e?.needsReview) badges.push(`<span class="tag mid" title="ИИ не уверен в части критериев">Проверить: ${e.needsReview}</span>`);
  return `
    <tr data-id="${esc(c.conversation_id)}">
      <td class="check"><input type="checkbox" class="row-check" value="${esc(c.conversation_id)}" aria-label="Выбрать ${esc(c.conversation_id)}"></td>
      <td><a class="row-link" href="#/c/${encodeURIComponent(c.conversation_id)}">${esc(c.conversation_id)}</a></td>
      <td>${CHANNEL[c.channel] || esc(c.channel)}${c.hasAudio ? ' <span class="muted" title="Есть запись">♪</span>' : ''}</td>
      <td>${esc(c.language)}</td>
      <td class="num">${c.turns}</td>
      <td class="num">${e ? `<span class="score ${scoreTone(e.total)}">${fmt(e.total)}</span>${e.changed ? `<div class="muted tiny">ИИ: ${fmt(e.originalTotal)}</div>` : ''}` : '<span class="muted">—</span>'}</td>
      <td class="tags">${badges.join('') || (e ? '<span class="muted">—</span>' : '<span class="muted">не оценён</span>')}</td>
      <td class="muted tiny">${e ? `${esc(e.checklistName)} v${e.checklistVersion}<br>${fmtDate(e.createdAt)}` : ''}</td>
    </tr>`;
}

function bind(ctx, convs) {
  const $ = (s) => ctx.view.querySelector(s);
  const rerender = () => renderList(ctx);

  $('#import-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    const group = new FormData(ev.target).get('group').trim();
    busy(btn, true, 'Загружаю…');
    try {
      const r = await api.importGroup(group);
      toast(`Набор ${r.group}: новых ${r.added}, обновлено ${r.updated}${r.errors.length ? `, с ошибками ${r.errors.length}` : ''}`, 'ok');
      rerender();
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
      rerender();
    } catch (e) {
      toast(`Файл не загружен: ${e.message}`, 'error');
    }
  });

  const selected = () => [...ctx.view.querySelectorAll('.row-check:checked')].map((c) => c.value);
  const syncSelected = () => {
    const n = selected().length;
    const b = $('#eval-selected');
    b.disabled = !n;
    b.textContent = n ? `Оценить выбранные (${n})` : 'Оценить выбранные';
  };
  ctx.view.querySelectorAll('.row-check').forEach((c) => c.addEventListener('change', syncSelected));
  $('#check-all')?.addEventListener('change', (ev) => {
    ctx.view.querySelectorAll('.row-check').forEach((c) => (c.checked = ev.target.checked));
    syncSelected();
  });
  ctx.view.querySelectorAll('tbody tr').forEach((tr) =>
    tr.addEventListener('click', (ev) => {
      if (ev.target.closest('input, a')) return;
      location.hash = `#/c/${encodeURIComponent(tr.dataset.id)}`;
    }),
  );

  const start = async (body, btn) => {
    busy(btn, true, 'Запускаю…');
    try {
      const job = await api.startJob({ ...body, checklistId: $('#checklist-select').value, ...readMode($('#mode-select').value) });
      activeJob = job.id;
      toast(`Запущена оценка ${job.total} диалогов`, 'ok');
      pollJob(ctx);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy(btn, false);
    }
  };
  $('#eval-selected').addEventListener('click', (ev) => start({ conversationIds: selected() }, ev.currentTarget));
  $('#eval-missing').addEventListener('click', (ev) => start({ onlyMissing: true, group: filters.group || undefined }, ev.currentTarget));

  const setFilter = (key) => (ev) => {
    filters[key] = ev.target.value;
    rerender();
  };
  $('#f-status').addEventListener('change', setFilter('status'));
  $('#f-lang').addEventListener('change', setFilter('lang'));
  $('#f-channel').addEventListener('change', setFilter('channel'));
  $('#f-group')?.addEventListener('change', setFilter('group'));
  let t;
  $('#f-q').addEventListener('input', (ev) => {
    clearTimeout(t);
    t = setTimeout(() => {
      filters.q = ev.target.value;
      rerender().then(() => {
        const q = ctx.view.querySelector('#f-q');
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
      });
    }, 250);
  });
}

function pollJob(ctx) {
  clearTimeout(pollTimer);
  const tick = async () => {
    if (!activeJob || !ctx.isCurrent()) return;
    let job;
    try {
      job = await api.job(activeJob);
    } catch {
      activeJob = null;
      return;
    }
    const box = ctx.view.querySelector('#job-box');
    if (!box) return;
    const pct = Math.round(((job.done + job.failed) / job.total) * 100);
    box.innerHTML = `
      <div class="job">
        <div class="job-line">
          <b>${job.status === 'running' ? 'Идёт оценка' : 'Оценка завершена'}</b>
          <span>${job.done + job.failed} из ${job.total}${job.failed ? ` · ошибок ${job.failed}` : ''} · ${fmtUsd(job.costUsd)} · чек-лист «${esc(job.checklistName)}»</span>
        </div>
        <div class="progress"><span style="width:${pct}%"></span></div>
        ${job.errors.length ? `<details class="tiny"><summary>Ошибки</summary>${job.errors.map((e) => `<div>${esc(e.conversation_id)}: ${esc(e.error)}</div>`).join('')}</details>` : ''}
      </div>`;
    if (job.status === 'running') pollTimer = setTimeout(tick, 1500);
    else {
      activeJob = null;
      toast(`Оценка завершена: ${job.done} диалогов, ${fmtUsd(job.costUsd)}`, 'ok');
      setTimeout(() => ctx.isCurrent() && renderList(ctx), 600);
    }
  };
  tick();
}
