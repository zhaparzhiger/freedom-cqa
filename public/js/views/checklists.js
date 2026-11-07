// Чек-листы: разделы, критерии (тип, вес, N/A и условие, правило, ступени шкалы, уточнение для ИИ, код выгрузки),
// общие правила, версии; превью влияния изменений до сохранения и «Сохранить и применить».
import { api } from '../api.js';
import { esc, toast, busy, fmtDate, fmt, fmtUsd, icon, chev, plural } from '../ui.js';
import { loadConversations } from '../data.js';
import { painted, keepScroll, swap } from '../shell.js';

// коды критериев из приложения к гайду «Как сдать результаты»
const DEFAULT_CODES = { c01: 'contact', c02: 'discovery', c03: 'identification', c04: 'consultation', c05: 'empathy', c06: 'dialogue', c07: 'closure', c08: 'critical' };
const TYPES = [
  ['yesno', 'Да / Нет'],
  ['scale', 'Шкала баллов'],
  ['flag', 'Флаг (без баллов)'],
];

let selectedId = null;
let draft = null; // редактируемая копия выбранного чек-листа
let saved = null; // сохранённая версия — для сравнения
let editOpen = null; // раскрытый критерий
let fresh = null; // только что добавленный критерий
let impact = null; // последний расчёт влияния
let C = null;

const dirty = () => Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved));

export async function renderChecklists(ctx) {
  const [{ checklists, activeId }, convs] = await Promise.all([api.checklists(), loadConversations().catch(() => [])]);
  if (!ctx.isCurrent()) return;
  if (!checklists.some((c) => c.id === selectedId)) selectedId = activeId;
  const current = checklists.find((c) => c.id === selectedId);
  if (!draft || draft.id !== selectedId || !dirty()) {
    draft = structuredClone(current);
    saved = structuredClone(current);
    if (impact && impact.checklistId !== selectedId) impact = null;
  }
  C = { ctx, checklists, activeId, convs };
  draw();
}

function draw() {
  const { ctx, checklists, activeId, convs } = C;
  const isDirty = dirty();
  const scored = draft.criteria.filter((c) => c.type !== 'flag');
  const sumW = scored.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const evaluated = convs.filter((c) => c.evaluation);
  const outdated = evaluated.filter((c) => c.evaluation.checklistId !== draft.id || c.evaluation.checklistVersion !== saved.version).length;
  const notEvaluated = convs.length - evaluated.length;
  let rows = '';
  const groups = [...draft.sections.map((s) => ({ ...s })), { id: '', name: 'Без раздела' }];
  for (const s of groups) {
    const cs = draft.criteria.filter((c) => (c.section || '') === s.id || (s.id === '' && c.section && !draft.sections.some((x) => x.id === c.section)));
    if (!cs.length) continue;
    rows += `<div class="sec-row"><span>${esc(s.name)}</span><b>${cs.every((c) => c.type === 'flag') ? 'без баллов' : `вес ${cs.filter((c) => c.type !== 'flag').reduce((a, c) => a + (Number(c.weight) || 0), 0)}`}</b></div>${cs.map((c) => editHtml(c)).join('')}`;
  }
  ctx.view.innerHTML = `<div class="page-anim">
    <header class="head">
      <div><h1>Чек-листы</h1><p>Критерии, веса и правила оценки — это настройка. Промпт для ИИ собирается из неё автоматически; каждое сохранение — новая версия.</p></div>
      <div class="acts">
        <button type="button" class="btn quiet" id="revert" ${isDirty ? '' : 'disabled'}>Отменить</button>
        <button type="button" class="btn" id="impact" ${isDirty ? '' : 'disabled'} title="Показать, как изменения повлияют на уже оценённые диалоги — до сохранения">${icon('eye')}Оценить влияние</button>
        <button type="button" class="btn primary" id="save" ${isDirty ? '' : 'disabled'}>${icon('save')}Сохранить версию</button>
      </div>
    </header>
    <div id="impact-box">${impact ? impactHtml(impact) : ''}</div>
    <div class="cl">
      <div class="cl-main">
        <div class="sheet">
          <div class="sheet-b cl-name">
            <label class="fld"><span>Название чек-листа</span><input class="input" id="cl-name" value="${esc(draft.name)}"></label>
            <p class="muted small">Версия ${saved.version}${isDirty ? ' · есть несохранённые правки' : ''} · обновлён ${fmtDate(saved.updatedAt)}. Прошлые оценки хранят тот чек-лист, по которому были сделаны.</p>
          </div>
          ${rows}
          <div class="sheet-b add-row"><button type="button" class="btn quiet sm" id="add-crit">${icon('plus')}Добавить критерий</button></div>
        </div>
        <section class="sheet">
          <div class="sheet-h"><div><h2>Общие правила</h2><p>Применяются ко всем критериям и передаются ИИ вместе с чек-листом. Их изменение требует полной переоценки.</p></div></div>
          <div class="sheet-b"><textarea class="textarea" id="cl-rules" rows="7" aria-label="Общие правила">${esc(draft.generalRules || '')}</textarea></div>
        </section>
      </div>
      <aside class="side">
        <section class="sheet"><div class="sheet-b">
          <span class="cap">Версия v${saved.version}${draft.id === activeId ? ' · активный' : ''}${isDirty ? ' · есть правки' : ''}</span>
          <p>${outdated || notEvaluated ? `${outdated ? `${outdated} ${plural(outdated, 'диалог оценён', 'диалога оценены', 'диалогов оценены')} не по этой версии` : ''}${outdated && notEvaluated ? ', ' : ''}${notEvaluated ? `${notEvaluated} не ${plural(notEvaluated, 'оценён', 'оценены', 'оценены')}` : ''}.` : 'Все диалоги оценены по этой версии.'}</p>
          <button type="button" class="btn" id="apply" ${outdated || notEvaluated ? '' : 'disabled'} title="Оценить диалоги этим чек-листом: только неоценённые и оценённые прошлой версией">${icon('refresh')}Применить к диалогам</button>
          ${draft.id !== activeId ? `<button type="button" class="btn quiet sm" id="activate">${icon('check')}Сделать активным</button>` : ''}
        </div></section>
        <section class="sheet"><div class="sheet-b">
          <span class="cap">Веса · сумма ${sumW}</span>
          <div class="wbar">${scored.map((c) => `<i style="flex:${Number(c.weight) || 0}" title="${esc(`${c.name} · ${c.weight}`)}"></i>`).join('')}</div>
          <p>${sumW === 100 ? 'Итог в шкале 0–100.' : 'Сумма не 100 — итог всё равно нормируется к 100.'} Вес N/A делится между применимыми критериями. Флаги баллов не дают, а отмечают грубую ошибку отдельно.</p>
        </div></section>
        <section class="sheet"><div class="sheet-b">
          <span class="cap">Разделы</span>
          <div class="sec-edit">${draft.sections.map((s, i) => `<div class="sec-line"><input class="input" data-section="${i}" value="${esc(s.name)}" aria-label="Раздел ${i + 1}"><button type="button" class="icon-btn" data-del-section="${i}" title="Удалить раздел" aria-label="Удалить раздел">${icon('x')}</button></div>`).join('')}</div>
          <button type="button" class="btn quiet sm" id="add-section">${icon('plus')}Раздел</button>
        </div></section>
        <section class="sheet"><div class="sheet-b">
          <span class="cap">Все чек-листы</span>
          <div class="cl-list">${checklists.map((c) => `<button type="button" class="cl-item${c.id === selectedId ? ' on' : ''}" data-select="${c.id}"><b>${esc(c.name)}</b><small>v${c.version} · ${c.criteria.length} ${plural(c.criteria.length, 'критерий', 'критерия', 'критериев')} · ${fmtDate(c.updatedAt)}</small>${c.id === activeId ? '<span class="tag ok">активный</span>' : ''}</button>`).join('')}</div>
          <div class="acts"><button type="button" class="btn quiet sm" id="clone">${icon('copy')}Копия</button>${draft.id !== activeId ? `<button type="button" class="btn quiet sm danger" id="delete">${icon('trash')}Удалить</button>` : ''}</div>
        </div></section>
      </aside>
    </div>
  </div>`;
  bind();
  painted(ctx.view, `checklists:${draft.id}`);
}

function typeSummary(c) {
  const t = c.type === 'scale' ? `шкала ${[...(c.scale || [])].map((s) => s.value).sort((a, b) => a - b).join('/')}` : c.type === 'flag' ? 'флаг' : 'да / нет';
  return `${t}${c.naAllowed && c.type !== 'flag' ? ' · N/A' : ''}`;
}

function editHtml(c) {
  const i = draft.criteria.indexOf(c);
  const on = editOpen === c.id || fresh === c.id;
  const head = `<button type="button" class="edit-h" data-toggle="${esc(c.id)}" aria-expanded="${on}"><span class="cr-code">C${i + 1}</span><span class="cr-name" data-hname>${esc(c.name)}</span><span class="muted small">${typeSummary(c)}</span><span class="w" data-hw>${c.type === 'flag' ? '—' : esc(c.weight)}</span>${chev}</button>`;
  if (!on) return `<div class="edit${fresh === c.id ? ' fresh' : ''}" data-i="${i}">${head}</div>`;
  const flag = c.type === 'flag';
  return `<div class="edit on${fresh === c.id ? ' fresh' : ''}" data-i="${i}">${head}
    <div class="edit-b">
      <label class="fld full"><span>Название <code>${esc(c.id)}</code></span><input class="input name" data-f="name" value="${esc(c.name)}"></label>
      <label class="fld"><span>Тип ответа</span><select class="select" data-f="type">${TYPES.map(([v, l]) => `<option value="${v}" ${v === c.type ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="fld"><span>Раздел</span><select class="select" data-f="section"><option value="">—</option>${draft.sections.map((s) => `<option value="${s.id}" ${s.id === c.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label class="fld"><span>Вес</span><input class="input" type="number" min="0" step="1" data-f="weight" value="${flag ? 0 : esc(c.weight)}" ${flag ? 'disabled' : ''}></label>
      <label class="fld full"><span>${c.type === 'scale' ? 'Что оценивается' : flag ? 'Когда флаг поднимается' : 'Правило «Да»'}</span><textarea class="textarea" rows="2" data-f="rule">${esc(c.rule)}</textarea></label>
      ${c.type === 'scale' ? `<div class="fld full steps-edit"><span>Ступени шкалы — верхняя даёт полный вес</span>
        ${c.scale.map((s, j) => `<div class="step"><input class="input" type="number" min="0" data-scale-v="${j}" value="${esc(s.value)}" aria-label="Баллы ступени"><input class="input" data-scale-l="${j}" value="${esc(s.label)}" placeholder="Описание ступени" aria-label="Описание ступени"><button type="button" class="icon-btn" data-scale-del="${j}" aria-label="Удалить ступень">${icon('x')}</button></div>`).join('')}
        <button type="button" class="btn quiet sm" data-scale-add>${icon('plus')}Ступень</button></div>` : ''}
      <div class="opts full"><label><input type="checkbox" data-f="naAllowed" ${c.naAllowed && !flag ? 'checked' : ''} ${flag ? 'disabled' : ''}> Допускается N/A</label></div>
      ${c.naAllowed && !flag ? `<label class="fld full"><span>Когда ставится N/A</span><input class="input" data-f="naCondition" value="${esc(c.naCondition || '')}"></label>` : ''}
      <label class="fld full"><span>Уточнение для ИИ — как трактовать пограничные случаи (необязательно)</span><textarea class="textarea" rows="2" data-f="hint">${esc(c.hint || '')}</textarea></label>
      <label class="fld"><span>Код для results.json</span><input class="input" data-f="code" value="${esc(c.code || DEFAULT_CODES[c.id] || '')}" placeholder="например, closure" list="codes"></label>
      <datalist id="codes">${Object.values(DEFAULT_CODES).map((v) => `<option value="${v}">`).join('')}</datalist>
      <div class="opts full move">
        <button type="button" class="btn quiet sm" data-move="-1" ${i ? '' : 'disabled'}>${icon('up')}Выше</button>
        <button type="button" class="btn quiet sm" data-move="1" ${i < draft.criteria.length - 1 ? '' : 'disabled'}>${icon('down')}Ниже</button>
        <button type="button" class="btn quiet sm danger" data-del style="margin-left:auto">${icon('trash')}Удалить критерий</button>
      </div>
    </div>
  </div>`;
}

// ── превью влияния ──────────────────────────────────────────────────
function impactHtml(job) {
  const d = job.diff;
  const name = (id) => `<b>${esc(id)}</b> ${esc(draft.criteria.find((c) => c.id === id)?.name || '')}`;
  const changes = [
    d.added.length ? `новые: ${d.added.map(name).join(', ')}` : '',
    d.changed.length ? `изменён текст или правило: ${d.changed.map(name).join(', ')}` : '',
    d.weightOnly.length ? `только вес: ${d.weightOnly.map(name).join(', ')} — пересчёт без ИИ` : '',
    d.removed.length ? `удалены: ${d.removed.map(esc).join(', ')}` : '',
  ].filter(Boolean);
  const head = `<p class="imp-diff">${changes.length ? `Изменения: ${changes.join(' · ')}` : 'Изменений в критериях нет'}</p>`;
  if (job.summary?.needsFull)
    return `<section class="impact-panel"><h2>Изменены общие правила</h2><p>Они влияют на все критерии, поэтому превью недоступно — нужна полная переоценка. Сохраните версию и нажмите «Применить к диалогам».</p>${head}</section>`;
  if (job.status === 'running') {
    const pct = job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 100;
    return `<section class="impact-panel"><h2><span class="spinner"></span> Считаю влияние…</h2><p>${job.done} из ${job.total} диалогов · ${fmtUsd(job.costUsd)}</p><div class="prog"><i style="width:${pct}%"></i></div>${head}</section>`;
  }
  const s = job.summary;
  const dl = s.avgAfter != null && s.avgBefore != null ? s.avgAfter - s.avgBefore : 0;
  const recomputed = d.added.length + d.changed.length;
  const top = job.rows.filter((r) => r.delta).slice(0, 8);
  return `<section class="impact-panel">
    <div class="imp-grid">
      <div class="impact"><span class="cap">Средний балл</span><div class="nums"><s>${fmt(s.avgBefore)}</s><span class="big">${fmt(s.avgAfter)}</span><span class="d${dl < 0 ? ' neg' : ''}">${dl >= 0 ? '+' : '−'}${fmt(Math.abs(dl))}</span></div></div>
      <div class="imp-k"><span class="cap">Затронет</span><b>${s.affected} <small>из ${job.total}</small></b></div>
      <div class="imp-k"><span class="cap">Хуже / лучше / как было</span><b><span class="neg">${s.worse}</span> / <span class="pos">${s.better}</span> / ${s.same}</b></div>
      <div class="imp-k"><span class="cap">Стоимость и время</span><b>${fmtUsd(job.costUsd)} <small>${s.seconds} с · ${job.calls} ${plural(job.calls, 'вызов', 'вызова', 'вызовов')}</small></b></div>
    </div>
    ${head}
    <p>${recomputed ? `ИИ перепроверил только изменённые критерии (${recomputed}) в каждом диалоге; остальные взяты из прошлых оценок вместе с решениями по апелляциям.` : 'ИИ не понадобился: изменились только веса, баллы пересчитаны кодом.'}${s.grossNew || s.grossGone ? ` Грубые ошибки: новых ${s.grossNew}, снято ${s.grossGone}.` : ''}</p>
    ${top.length ? `<div class="imp-top">${top.map((r) => `<a href="#/c/${encodeURIComponent(r.conversationId)}"><span>${esc(r.conversationId)}</span><span>${fmt(r.before)} → ${fmt(r.after)}</span><b class="${r.delta < 0 ? 'neg' : 'pos'}">${r.delta > 0 ? '+' : ''}${fmt(r.delta)}</b></a>`).join('')}</div>` : ''}
    <div class="acts"><button type="button" class="btn lime" id="apply-impact">${icon('check')}Сохранить и применить${job.done ? ` к ${job.done} ${plural(job.done, 'диалогу', 'диалогам', 'диалогам')}` : ''}</button><span class="small">Посчитанные оценки запишутся сразу, без повторных вызовов ИИ.</span></div>
  </section>`;
}

// ── события ──────────────────────────────────────────────────────────
function bind() {
  const { ctx } = C;
  const $ = (s) => ctx.view.querySelector(s);
  const redraw = () => keepScroll(draw);
  // ввод текста не перерисовывает экран (иначе пропадёт фокус); перерисовка — только при смене структуры
  const touch = (structural = false) => {
    if (structural) return redraw();
    const d = dirty();
    ['#revert', '#impact', '#save'].forEach((s) => ($(s).disabled = !d));
  };

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
  ctx.view.querySelectorAll('[data-section]').forEach((inp) => inp.addEventListener('change', () => redraw()));
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

  ctx.view.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.toggle;
      editOpen = editOpen === id ? null : id;
      if (fresh === id && editOpen === null) fresh = null;
      swap(redraw);
    }),
  );

  ctx.view.querySelectorAll('.edit.on').forEach((box) => {
    const c = draft.criteria[Number(box.dataset.i)];
    box.querySelectorAll('[data-f]').forEach((inp) => {
      const f = inp.dataset.f;
      const structural = ['type', 'naAllowed', 'section'].includes(f);
      inp.addEventListener(structural || inp.tagName === 'SELECT' ? 'change' : 'input', () => {
        if (f === 'naAllowed') c.naAllowed = inp.checked;
        else if (f === 'weight') c.weight = Number(inp.value);
        else c[f] = inp.value;
        if (f === 'type') {
          if (c.type === 'scale' && !c.scale?.length) c.scale = [{ value: 10, label: 'Полностью выполнено' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Не выполнено' }];
          if (c.type !== 'scale') c.scale = [];
          if (c.type === 'flag') {
            c.weight = 0;
            c.naAllowed = false;
          }
        }
        if (f === 'name') box.querySelector('[data-hname]').textContent = c.name;
        if (f === 'weight') box.querySelector('[data-hw]').textContent = c.weight;
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
    box.querySelectorAll('[data-scale-v]').forEach((inp) =>
      inp.addEventListener('input', () => {
        c.scale[Number(inp.dataset.scaleV)].value = Number(inp.value);
        touch();
      }),
    );
    box.querySelectorAll('[data-scale-l]').forEach((inp) =>
      inp.addEventListener('input', () => {
        c.scale[Number(inp.dataset.scaleL)].label = inp.value;
        touch();
      }),
    );
    box.querySelectorAll('[data-scale-del]').forEach((b) =>
      b.addEventListener('click', () => {
        c.scale.splice(Number(b.dataset.scaleDel), 1);
        touch(true);
      }),
    );
    box.querySelector('[data-scale-add]')?.addEventListener('click', () => {
      c.scale.push({ value: 0, label: '' });
      touch(true);
    });
  });

  $('#add-crit').addEventListener('click', () => {
    const nums = draft.criteria.map((c) => Number(String(c.id).replace(/^c/, ''))).filter(Number.isInteger);
    const id = `c${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
    draft.criteria.push({ id, section: draft.sections[0]?.id || '', name: 'Новый критерий', type: 'yesno', weight: 10, naAllowed: false, naCondition: '', rule: 'Да — ', hint: '', scale: [], code: '' });
    fresh = id;
    editOpen = id;
    touch(true);
    setTimeout(() => ctx.view.querySelector(`.edit.on [data-f="name"]`)?.select(), 0);
  });

  $('#revert').addEventListener('click', () => {
    draft = structuredClone(saved);
    fresh = null;
    impact = null;
    redraw();
  });

  $('#save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Сохраняю…');
    try {
      const res = await api.saveChecklist(draft.id, draft);
      draft = structuredClone(res);
      saved = structuredClone(res);
      fresh = null;
      impact = null;
      toast(`Чек-лист сохранён, версия ${res.version}`, 'ok');
      renderChecklists(ctx);
    } catch (err) {
      toast(err.message, 'error');
      busy(btn, false);
    }
  });

  // превью влияния: пересчитываются только изменённые критерии, остальное — из прошлых оценок
  $('#impact').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Считаю…');
    const box = $('#impact-box');
    try {
      let job = await api.impact(draft.id, draft);
      job.checklistId = draft.id;
      while (job.status === 'running') {
        box.innerHTML = impactHtml(job);
        await new Promise((r) => setTimeout(r, 1200));
        if (!ctx.isCurrent()) return;
        job = { ...(await api.impactJob(job.id)), checklistId: draft.id };
      }
      impact = job;
      redraw();
      ctx.view.querySelector('#impact-box')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      toast(`Влияние не посчитано: ${err.message}`, 'error');
      busy(btn, false);
    }
  });

  $('#apply-impact')?.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    busy(btn, true, 'Применяю…');
    try {
      const r = await api.applyImpact(draft.id, draft, impact.id);
      draft = structuredClone(r.checklist);
      saved = structuredClone(r.checklist);
      impact = null;
      fresh = null;
      toast(r.applied ? `Чек-лист v${r.checklist.version} сохранён и применён к ${r.applied} ${plural(r.applied, 'диалогу', 'диалогам', 'диалогам')} без повторных вызовов ИИ` : `Чек-лист v${r.checklist.version} сохранён`, 'ok');
      renderChecklists(ctx);
    } catch (err) {
      toast(err.message, 'error');
      busy(btn, false);
    }
  });

  $('#apply').addEventListener('click', async (e) => {
    if (dirty()) return toast('Сначала сохраните изменения', 'error');
    if (!confirm('Оценить диалоги этим чек-листом? Будут оценены неоценённые и оценённые прошлой версией — это вызовы модели и расходы.')) return;
    const btn = e.currentTarget;
    busy(btn, true, 'Запускаю…');
    try {
      if (draft.id !== C.activeId) await api.activateChecklist(draft.id);
      const job = await api.startJob({ checklistId: draft.id, onlyMissing: true });
      toast(`Чек-лист применяется к ${job.total} ${plural(job.total, 'диалогу', 'диалогам', 'диалогам')}`, 'ok');
      location.hash = '#/';
    } catch (err) {
      toast(err.message, 'error');
      busy(btn, false);
    }
  });

  $('#activate')?.addEventListener('click', async () => {
    try {
      await api.activateChecklist(draft.id);
      toast('Чек-лист сделан активным', 'ok');
      renderChecklists(ctx);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  ctx.view.querySelectorAll('[data-select]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.select === selectedId) return;
      if (dirty() && !confirm('Есть несохранённые изменения. Перейти без сохранения?')) return;
      selectedId = b.dataset.select;
      draft = null;
      impact = null;
      editOpen = null;
      renderChecklists(ctx);
    }),
  );
  $('#clone').addEventListener('click', async () => {
    if (dirty()) return toast('Сначала сохраните изменения', 'error');
    try {
      const cl = await api.createChecklist({ cloneFrom: draft.id });
      selectedId = cl.id;
      draft = null;
      toast('Создана копия чек-листа', 'ok');
      renderChecklists(ctx);
    } catch (err) {
      toast(err.message, 'error');
    }
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
