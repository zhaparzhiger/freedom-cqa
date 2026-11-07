// Настройка чек-листов: критерии, веса, тип ответа, N/A, шкалы, разделы, общие правила.
import { api } from '../api.js';
import { esc, toast, busy, fmtDate, fmt, fmtUsd } from '../ui.js';

// коды критериев из приложения к гайду «Как сдать результаты»
const DEFAULT_CODES = { c01: 'contact', c02: 'discovery', c03: 'identification', c04: 'consultation', c05: 'empathy', c06: 'dialogue', c07: 'closure', c08: 'critical' };

let selectedId = null;
let draft = null; // редактируемая копия выбранного чек-листа
let dirty = false;

const TYPES = [
  ['yesno', 'Да / Нет'],
  ['scale', 'Шкала баллов'],
  ['flag', 'Флаг (без баллов)'],
];

export async function renderChecklists(ctx) {
  const { checklists, activeId } = await api.checklists();
  if (!ctx.isCurrent()) return;
  if (!checklists.some((c) => c.id === selectedId)) selectedId = activeId;
  const current = checklists.find((c) => c.id === selectedId);
  if (!draft || draft.id !== selectedId || !dirty) {
    draft = structuredClone(current);
    dirty = false;
  }
  draw(ctx, checklists, activeId);
}

function draw(ctx, checklists, activeId) {
  const weightSum = draft.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Чек-листы</h1>
        <p class="muted">Критерии, веса и правила оценки. Промпт для ИИ собирается из этих настроек автоматически.</p>
      </div>
    </div>
    <div class="cl-layout">
      <aside class="cl-list">
        ${checklists.map((c) => `
          <button type="button" class="cl-item ${c.id === selectedId ? 'active' : ''}" data-select="${c.id}">
            <b>${esc(c.name)}</b>
            <span class="tiny muted">v${c.version} · ${c.criteria.length} критериев · ${fmtDate(c.updatedAt)}</span>
            ${c.id === activeId ? '<span class="tag good">Активный</span>' : ''}
          </button>`).join('')}
      </aside>

      <section class="cl-editor panel">
        <div class="cl-toolbar">
          <label class="field grow"><span>Название</span><input id="cl-name" value="${esc(draft.name)}"></label>
          <div class="row-actions">
            ${draft.id !== activeId ? '<button type="button" class="btn small" id="activate">Сделать активным</button>' : ''}
            <button type="button" class="btn small ghost" id="clone">Копия</button>
            ${draft.id !== activeId ? '<button type="button" class="btn small ghost danger" id="delete">Удалить</button>' : ''}
          </div>
        </div>
        <p class="tiny muted">Версия ${draft.version}. При сохранении версия увеличится; прошлые оценки хранят тот чек-лист, по которому были сделаны.</p>

        <h3>Разделы</h3>
        <div class="sections-edit">
          ${draft.sections.map((s, i) => `
            <div class="row"><input data-section="${i}" value="${esc(s.name)}" aria-label="Раздел ${i + 1}">
            <button type="button" class="icon-btn" data-del-section="${i}" title="Удалить раздел" aria-label="Удалить раздел">✕</button></div>`).join('')}
          <button type="button" class="btn small ghost" id="add-section">+ Раздел</button>
        </div>

        <h3>Критерии <span class="muted tiny">сумма весов: ${weightSum}${weightSum !== 100 ? ' (итог всё равно нормируется к 100)' : ''}</span></h3>
        <div class="crit-edit-list">
          ${draft.criteria.map((c, i) => criterionEditor(c, i)).join('')}
        </div>
        <button type="button" class="btn ghost" id="add-crit">+ Добавить критерий</button>

        <h3>Общие правила</h3>
        <label class="field"><span>Правила, которые применяются ко всем критериям (передаются ИИ вместе с чек-листом)</span>
          <textarea id="cl-rules" rows="6">${esc(draft.generalRules || '')}</textarea></label>

        <div class="save-bar ${dirty ? 'dirty' : ''}">
          <span class="muted">${dirty ? 'Есть несохранённые изменения' : 'Изменений нет'}</span>
          <div class="row-actions">
            <button type="button" class="btn ghost" id="reset" ${dirty ? '' : 'hidden'}>Отменить</button>
            <button type="button" class="btn" id="impact" ${dirty ? '' : 'disabled'} title="Показать, как изменения повлияют на уже оценённые диалоги">Оценить влияние</button>
            <button type="button" class="btn primary" id="save" ${dirty ? '' : 'disabled'}>Сохранить чек-лист</button>
            <button type="button" class="btn" id="apply" title="Оценить все диалоги этим чек-листом">Применить к диалогам</button>
          </div>
        </div>
        <div id="impact-box"></div>
      </section>
    </div>`;
  bind(ctx, checklists, activeId);
}

function impactHtml(job) {
  const d = job.diff;
  const names = (ids) => ids.map((id) => `<b>${esc(id)}</b> ${esc(draft.criteria.find((c) => c.id === id)?.name || '')}`).join(', ');
  const changes = [
    d.added.length ? `новые: ${names(d.added)}` : '',
    d.changed.length ? `изменён текст или правило: ${names(d.changed)}` : '',
    d.weightOnly.length ? `только вес: ${names(d.weightOnly)} — пересчёт без ИИ` : '',
    d.removed.length ? `удалены: ${d.removed.map(esc).join(', ')}` : '',
  ].filter(Boolean);
  const head = `<div class="tiny">${changes.length ? `Изменения: ${changes.join(' · ')}` : 'Изменений в критериях нет'}</div>`;
  if (job.summary?.needsFull)
    return `<div class="impact panel"><b>Изменены общие правила</b><p class="muted">Они влияют на все критерии, поэтому нужна полная переоценка. Сохраните чек-лист и нажмите «Применить к диалогам».</p>${head}</div>`;
  if (job.status === 'running') {
    const pct = job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 100;
    return `<div class="impact panel"><b>Считаю влияние…</b> ${job.done} из ${job.total} диалогов · ${fmtUsd(job.costUsd)}${head}<div class="progress"><span style="width:${pct}%"></span></div></div>`;
  }
  const s = job.summary;
  const recomputed = d.added.length + d.changed.length;
  return `
    <div class="impact panel">
      <div class="impact-head">
        <div><div class="tiny muted">Затронет диалогов</div><div class="kpi-value">${s.affected} <small>из ${job.total}</small></div></div>
        <div><div class="tiny muted">Средний балл</div><div class="kpi-value">${fmt(s.avgBefore)} → <span class="${s.avgAfter < s.avgBefore ? 'bad-text' : s.avgAfter > s.avgBefore ? 'good-text' : ''}">${fmt(s.avgAfter)}</span></div></div>
        <div><div class="tiny muted">Хуже / лучше / без изменений</div><div class="kpi-value"><span class="bad-text">${s.worse}</span> / <span class="good-text">${s.better}</span> / ${s.same}</div></div>
        <div><div class="tiny muted">Стоимость и время</div><div class="kpi-value">${fmtUsd(job.costUsd)} <small>${s.seconds} с · ${job.calls} вызовов</small></div></div>
      </div>
      ${head}
      <p class="tiny muted">${recomputed ? `ИИ перепроверил только ${recomputed} изменённых критерия(ев) в каждом диалоге; остальные ${draft.criteria.length - recomputed} взяты из прошлых оценок вместе с решениями по апелляциям.` : 'ИИ не понадобился: изменились только веса, баллы пересчитаны кодом.'}
      ${s.grossNew || s.grossGone ? ` Грубые ошибки: новых ${s.grossNew}, снято ${s.grossGone}.` : ''}</p>
      ${job.rows.filter((r) => r.delta).length ? `<table class="table impact-table"><thead><tr><th>Диалог</th><th class="num">Было</th><th class="num">Стало</th><th class="num">Δ</th></tr></thead><tbody>
        ${job.rows.filter((r) => r.delta).slice(0, 8).map((r) => `<tr><td><a href="#/c/${encodeURIComponent(r.conversationId)}">${esc(r.conversationId)}</a></td><td class="num">${fmt(r.before)}</td><td class="num">${fmt(r.after)}</td><td class="num ${r.delta < 0 ? 'bad-text' : 'good-text'}">${r.delta > 0 ? '+' : ''}${fmt(r.delta)}</td></tr>`).join('')}
      </tbody></table>` : ''}
      <div class="row-actions" style="margin-top:12px">
        <button type="button" class="btn primary" id="apply-impact">Сохранить и применить${job.done ? ` к ${job.done} диалогам` : ''}</button>
        <span class="tiny muted">Посчитанные оценки запишутся сразу, без повторных вызовов ИИ.</span>
      </div>
    </div>`;
}

function criterionEditor(c, i) {
  return `
    <div class="crit-edit" data-i="${i}">
      <div class="crit-edit-head">
        <span class="crit-id">${esc(c.id || 'новый')}</span>
        <input class="grow" data-f="name" value="${esc(c.name)}" placeholder="Название критерия" aria-label="Название критерия">
        <button type="button" class="icon-btn" data-move="-1" title="Выше" aria-label="Выше">↑</button>
        <button type="button" class="icon-btn" data-move="1" title="Ниже" aria-label="Ниже">↓</button>
        <button type="button" class="icon-btn danger" data-del title="Удалить критерий" aria-label="Удалить критерий">✕</button>
      </div>
      <div class="crit-edit-grid">
        <label class="field"><span>Раздел</span>
          <select data-f="section"><option value="">—</option>${draft.sections.map((s) => `<option value="${s.id}" ${s.id === c.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Тип ответа</span>
          <select data-f="type">${TYPES.map(([v, l]) => `<option value="${v}" ${v === c.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field narrow"><span>Вес</span>
          <input type="number" min="0" step="1" data-f="weight" value="${c.weight}" ${c.type === 'flag' ? 'disabled' : ''}></label>
        <label class="check-field ${c.type === 'flag' ? 'disabled' : ''}"><input type="checkbox" data-f="naAllowed" ${c.naAllowed ? 'checked' : ''} ${c.type === 'flag' ? 'disabled' : ''}> Разрешён N/A</label>
      </div>
      <label class="field narrow-wide"><span>Код для выгрузки results.json <span class="muted">(contact, discovery, identification, consultation, empathy, dialogue, closure, critical)</span></span>
        <input data-f="code" value="${esc(c.code || DEFAULT_CODES[c.id] || '')}" placeholder="например, closure"></label>
      ${c.naAllowed && c.type !== 'flag' ? `<label class="field"><span>Когда ставится N/A</span><input data-f="naCondition" value="${esc(c.naCondition)}"></label>` : ''}
      <label class="field"><span>${c.type === 'scale' ? 'Что оценивается' : 'Правило «Да»'}</span><textarea rows="2" data-f="rule">${esc(c.rule)}</textarea></label>
      ${c.type === 'scale' ? `
        <div class="scale-edit">
          <span class="tiny muted">Ступени шкалы (верхняя ступень даёт полный вес)</span>
          ${c.scale.map((s, j) => `
            <div class="row">
              <input type="number" min="0" class="narrow" data-scale-v="${j}" value="${s.value}" aria-label="Баллы ступени">
              <input class="grow" data-scale-l="${j}" value="${esc(s.label)}" placeholder="Описание ступени" aria-label="Описание ступени">
              <button type="button" class="icon-btn" data-scale-del="${j}" aria-label="Удалить ступень">✕</button>
            </div>`).join('')}
          <button type="button" class="btn small ghost" data-scale-add>+ Ступень</button>
        </div>` : ''}
      <label class="field"><span>Уточнение для ИИ <span class="muted">(необязательно: как трактовать пограничные случаи)</span></span><textarea rows="2" data-f="hint">${esc(c.hint || '')}</textarea></label>
    </div>`;
}

function bind(ctx, checklists, activeId) {
  const $ = (s) => ctx.view.querySelector(s);
  const redraw = () => draw(ctx, checklists, activeId);
  // Ввод текста не перерисовывает страницу (иначе пропадёт фокус); перерисовка — только при смене структуры.
  const touch = (rerender = false) => {
    dirty = true;
    if (rerender) return redraw();
    const bar = $('.save-bar');
    bar.classList.add('dirty');
    bar.querySelector('.muted').textContent = 'Есть несохранённые изменения';
    $('#save').disabled = false;
    $('#impact').disabled = false;
    $('#reset').hidden = false;
  };

  // превью влияния: пересчитываются только изменённые критерии, остальное — из прошлых оценок
  $('#impact').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Считаю…');
    try {
      let job = await api.impact(draft.id, draft);
      const box = $('#impact-box');
      while (job.status === 'running') {
        box.innerHTML = impactHtml(job);
        await new Promise((r) => setTimeout(r, 1200));
        if (!ctx.isCurrent()) return;
        job = await api.impactJob(job.id);
      }
      box.innerHTML = impactHtml(job);
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      box.querySelector('#apply-impact')?.addEventListener('click', async (ev) => {
        busy(ev.currentTarget, true, 'Применяю…');
        try {
          const r = await api.applyImpact(draft.id, draft, job.id);
          dirty = false;
          draft = structuredClone(r.checklist);
          toast(r.applied ? `Чек-лист v${r.checklist.version} сохранён и применён к ${r.applied} диалогам без повторных вызовов ИИ` : `Чек-лист v${r.checklist.version} сохранён`, 'ok');
          renderChecklists(ctx);
        } catch (err) {
          toast(err.message, 'error');
          busy(ev.currentTarget, false);
        }
      });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });

  ctx.view.querySelectorAll('[data-select]').forEach((b) =>
    b.addEventListener('click', () => {
      if (dirty && !confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
      selectedId = b.dataset.select;
      dirty = false;
      draft = null;
      renderChecklists(ctx);
    }),
  );

  $('#cl-name').addEventListener('input', (e) => {
    draft.name = e.target.value;
    touch();
  });
  $('#cl-rules').addEventListener('input', (e) => {
    draft.generalRules = e.target.value;
    touch();
  });

  ctx.view.querySelectorAll('[data-section]').forEach((inp) =>
    inp.addEventListener('input', () => {
      draft.sections[Number(inp.dataset.section)].name = inp.value;
      touch();
    }),
  );
  ctx.view.querySelectorAll('[data-del-section]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = draft.sections[Number(b.dataset.delSection)];
      draft.sections.splice(Number(b.dataset.delSection), 1);
      draft.criteria.forEach((c) => c.section === s.id && (c.section = ''));
      touch(true);
    }),
  );
  $('#add-section').addEventListener('click', () => {
    const n = draft.sections.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/\D/g, '')) || 0), 0) + 1;
    draft.sections.push({ id: `s${n}`, name: 'Новый раздел' });
    touch(true);
  });

  ctx.view.querySelectorAll('.crit-edit').forEach((box) => {
    const c = draft.criteria[Number(box.dataset.i)];
    box.querySelectorAll('[data-f]').forEach((inp) => {
      const f = inp.dataset.f;
      const structural = ['type', 'naAllowed'].includes(f);
      inp.addEventListener(structural || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
        if (f === 'naAllowed') c.naAllowed = inp.checked;
        else if (f === 'weight') c.weight = Number(inp.value);
        else c[f] = inp.value;
        if (f === 'type') {
          if (c.type === 'scale' && !c.scale?.length) c.scale = [{ value: 10, label: 'Полностью выполнено' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Не выполнено' }];
          if (c.type === 'flag') {
            c.weight = 0;
            c.naAllowed = false;
          }
        }
        touch(structural);
      });
    });
    box.querySelector('[data-del]').addEventListener('click', () => {
      if (!confirm(`Удалить критерий «${c.name}»?`)) return;
      draft.criteria.splice(Number(box.dataset.i), 1);
      touch(true);
    });
    box.querySelectorAll('[data-move]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(box.dataset.i);
        const j = i + Number(b.dataset.move);
        if (j < 0 || j >= draft.criteria.length) return;
        [draft.criteria[i], draft.criteria[j]] = [draft.criteria[j], draft.criteria[i]];
        touch(true);
      }),
    );
    box.querySelectorAll('[data-scale-v]').forEach((inp) => inp.addEventListener('input', () => {
      c.scale[Number(inp.dataset.scaleV)].value = Number(inp.value);
      touch();
    }));
    box.querySelectorAll('[data-scale-l]').forEach((inp) => inp.addEventListener('input', () => {
      c.scale[Number(inp.dataset.scaleL)].label = inp.value;
      touch();
    }));
    box.querySelectorAll('[data-scale-del]').forEach((b) => b.addEventListener('click', () => {
      c.scale.splice(Number(b.dataset.scaleDel), 1);
      touch(true);
    }));
    box.querySelector('[data-scale-add]')?.addEventListener('click', () => {
      c.scale.push({ value: 0, label: '' });
      touch(true);
    });
  });

  $('#add-crit').addEventListener('click', () => {
    const nums = draft.criteria.map((c) => Number(String(c.id).replace(/^c/, ''))).filter(Number.isInteger);
    const id = `c${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
    draft.criteria.push({ id, section: draft.sections[0]?.id || '', name: 'Новый критерий', type: 'yesno', weight: 10, naAllowed: false, naCondition: '', rule: 'Да — ', hint: '', scale: [] });
    touch(true);
    setTimeout(() => ctx.view.querySelector(`.crit-edit[data-i="${draft.criteria.length - 1}"] [data-f="name"]`)?.select(), 0);
  });

  $('#reset')?.addEventListener('click', () => {
    dirty = false;
    draft = null;
    renderChecklists(ctx);
  });

  $('#save').addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Сохраняю…');
    try {
      const saved = await api.saveChecklist(draft.id, draft);
      draft = structuredClone(saved);
      dirty = false;
      toast(`Чек-лист сохранён, версия ${saved.version}`, 'ok');
      renderChecklists(ctx);
    } catch (err) {
      toast(err.message, 'error');
      busy(e.currentTarget, false);
    }
  });

  $('#apply').addEventListener('click', async (e) => {
    if (dirty) return toast('Сначала сохраните изменения', 'error');
    busy(e.currentTarget, true, 'Запускаю…');
    try {
      if (draft.id !== activeId) await api.activateChecklist(draft.id);
      const job = await api.startJob({ checklistId: draft.id, onlyMissing: true });
      toast(`Чек-лист применяется к ${job.total} диалогам`, 'ok');
      location.hash = '#/';
    } catch (err) {
      toast(err.message, 'error');
      busy(e.currentTarget, false);
    }
  });

  $('#activate')?.addEventListener('click', async () => {
    await api.activateChecklist(draft.id);
    toast('Чек-лист сделан активным', 'ok');
    renderChecklists(ctx);
  });
  $('#clone').addEventListener('click', async () => {
    if (dirty) return toast('Сначала сохраните изменения', 'error');
    const cl = await api.createChecklist({ cloneFrom: draft.id });
    selectedId = cl.id;
    draft = null;
    toast('Создана копия чек-листа', 'ok');
    renderChecklists(ctx);
  });
  $('#delete')?.addEventListener('click', async () => {
    if (!confirm(`Удалить чек-лист «${draft.name}»? Прошлые оценки по нему сохранятся.`)) return;
    try {
      await api.deleteChecklist(draft.id);
      selectedId = null;
      draft = null;
      toast('Чек-лист удалён', 'ok');
      renderChecklists(ctx);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
