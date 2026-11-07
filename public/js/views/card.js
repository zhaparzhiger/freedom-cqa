// Карточка диалога: итог и шкала, водопад баллов, критерии с обоснованием, ход проверки,
// тренировка для оператора, транскрипт с метками и плеером записи, апелляции.
import { api } from '../api.js';
import { esc, fmt, fmtDate, fmtDay, fmtUsd, toast, busy, answerLabel, answerOptions, stateTag, band, verdict, icon, chev, role, LANG, CHANNEL, modeSelect, readMode, modeOf, modeLabel, plural } from '../ui.js';
import { loadDetail, evalModel, topicOf, messages, durationOf, forgetDetail } from '../data.js';
import { roleName, formatSec } from '../transcript.js';
import { timeline, scaleBar, drawWaterfall, reduced } from '../viz.js';
import { painted, keepScroll, swap, refreshCounts } from '../shell.js';

let S = null; // состояние открытой карточки

export async function renderCard(ctx, id) {
  const [data, { checklists, activeId }] = await Promise.all([loadDetail(id), api.checklists()]);
  if (!ctx.isCurrent()) return;
  const evId = ctx.query.get('ev');
  let ev = data.current;
  if (evId && evId !== ev?.id) ev = await api.evaluation(evId);
  if (!ctx.isCurrent()) return;
  const same = S && S.id === id;
  S = {
    ctx,
    id,
    data,
    conv: data.conversation,
    ev,
    model: evalModel(ev),
    msgs: messages(data.conversation),
    checklists,
    activeId,
    open: ctx.query.get('crit') || (same ? S.open : null),
    appealing: same ? S.appealing : null,
    isCall: data.conversation.channel === 'voice call',
  };
  draw();
  const focus = ctx.query.get('crit');
  if (focus) setTimeout(() => ctx.view.querySelector(`#crit-${CSS.escape(focus)}`)?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' }), 80);
}

const reload = async () => {
  forgetDetail(S.id);
  await renderCard(S.ctx, S.id);
  refreshCounts();
};

// ── разметка ─────────────────────────────────────────────────────────
function draw() {
  const { ctx, conv, ev, model, msgs, checklists, activeId } = S;
  const topic = topicOf(conv, ev);
  ctx.view.innerHTML = `<div class="page-anim" id="card-root">
    <a class="crumb" href="#/">${icon('left')}Диалоги</a>
    <header class="conv-h">
      <h1>${esc(topic)}</h1>
      <div class="meta">${esc(conv.conversation_id)} · ${CHANNEL[conv.channel] || esc(conv.channel)} · ${esc(LANG[conv.language] || conv.language || '—')} · набор ${esc(conv.group)}${ev ? ` · чек-лист «${esc(ev.checklist.name)}» v${ev.checklistVersion} · ${fmtDay(ev.createdAt)}` : ''}</div>
    </header>
    <form class="conv-tools" id="eval-form">
      <select class="select" name="checklist" aria-label="Чек-лист">${checklists.map((c) => `<option value="${c.id}" ${c.id === (ev?.checklistId || activeId) ? 'selected' : ''}>${esc(c.name)} · v${c.version}</option>`).join('')}</select>
      ${modeSelect('card-mode', ev ? modeOf(ev) : 'agents')}
      <button class="btn primary" type="submit">${icon(ev ? 'refresh' : 'spark')}${ev ? 'Оценить заново' : 'Оценить диалог'}</button>
      ${S.data.evaluations.length > 1 ? `<label class="hist-sel">История оценок<select class="select" id="ev-history">${S.data.evaluations.slice().reverse().map((h) => `<option value="${h.id}" ${h.id === ev?.id ? 'selected' : ''}>${fmtDate(h.createdAt)} · ${fmt(h.total)} · ${esc(h.checklist)}</option>`).join('')}</select></label>` : ''}
    </form>
    <div class="conv">
      <div id="conv-left">${leftHtml()}</div>
      ${chatHtml()}
    </div>
  </div>`;
  bindAll();
  // итог «докручивается» вместе с построением водопада
  painted(ctx.view, `card:${S.id}:${ev?.id || ''}`, { rollDelay: (el) => (el.dataset.sync === 'wf' ? (model?.rows.length || 0) * 70 + 100 : 0) });
}

function leftHtml() {
  const { ev, model } = S;
  if (!ev) return `<section class="score score-empty"><div><span class="cap">Итоговый балл</span><div class="total">—</div><p class="score-hint">Диалог ещё не оценён. Выберите чек-лист и режим выше и нажмите «Оценить диалог» — оценка занимает 5–30 секунд.</p></div></section>`;
  return scoreHtml() + breakdownHtml() + trainingHtml() + processHtml(ev, model);
}

function scoreHtml() {
  const { model } = S;
  const fin = model.final;
  const review = S.ev.items.filter((i) => i.needsReview).length;
  return `<section class="score" data-field="ripple" data-origin=".total">
    <div>
      <span class="cap">${model.changed ? 'Финальный балл после пересмотра' : 'Итоговый балл'}</span>
      ${model.changed ? `<span class="was" title="Исходная оценка ИИ">${fmt(model.original.total)}</span>` : ''}
      <div class="total roll" data-roll="${fmt(fin.total)}" data-key="t:${esc(S.ev.id)}" data-sync="wf">${fmt(fin.total)}</div>
      <div class="verdict">${icon(fin.total != null && fin.total >= 75 ? 'check' : 'alert')}${verdict(fin.total)}</div>
      ${fin.total != null ? scaleBar(fin.total) : ''}
    </div>
    <div class="secs">${fin.sections.map((s) => `<div><span>${esc(s.name)}</span><b>${s.percent == null ? 'N/A' : `${fmt(s.points, 1)}<small> / ${fmt(s.max, 1)}</small>`}</b></div>`).join('')}</div>
    ${fin.total == null ? '<div class="crit-note info">Нет применимых критериев с весом — итог не рассчитывается.</div>' : ''}
    ${model.flags.length ? `<div class="crit-note">${icon('alert')}Грубая ошибка: ${model.flags.map((f) => esc(f.c.name)).join(', ')} — отмечена отдельно от итога</div>` : ''}
    ${review ? `<div class="crit-note warn">${icon('eye')}Требует проверки человеком: ${review} ${plural(review, 'критерий', 'критерия', 'критериев')}</div>` : ''}
    ${model.openAppeals ? `<div class="crit-note appeal">${icon('flag')}Открытых апелляций: ${model.openAppeals}</div>` : ''}
  </section>`;
}

function breakdownHtml() {
  const { model } = S;
  const na = model.rows.filter((r) => r.c.type !== 'flag' && r.finalAnswer === 'na');
  let crit = '';
  const sections = [...model.cl.sections, { id: '', name: 'Без раздела' }];
  for (const s of sections) {
    const rows = model.rows.filter((r) => (r.c.section || '') === s.id || (s.id === '' && r.c.section && !model.cl.sections.some((x) => x.id === r.c.section)));
    if (!rows.length) continue;
    const sec = model.final.sections.find((x) => x.sectionId === s.id);
    crit += `<div class="sec-row"><span>${esc(s.name)}</span><b>${sec ? (sec.percent == null ? 'N/A' : `${fmt(sec.points, 1)} из ${fmt(sec.max, 1)}`) : rows.every((r) => r.c.type === 'flag') ? 'без баллов' : ''}</b></div>${rows.map(critHtml).join('')}`;
  }
  return `<section class="sheet" id="breakdown">
    <div class="sheet-h"><div><h2>Из чего сложился итог</h2><p>${na.length ? `N/A: ${na.map((r) => r.code).join(', ')} — вес распределён между остальными` : 'Все критерии применимы'}</p></div></div>
    <div class="sheet-b wf"><div class="chart" id="wfChart"></div><div class="legend"><span><i style="background:var(--green)"></i>набрано</span><span><i style="background:rgba(214,90,64,.16);outline:1.2px dashed var(--red);outline-offset:-1.2px"></i>потеряно</span><span><i style="background:var(--na-soft);outline:1px dashed var(--line-2);outline-offset:-1px"></i>не применимо</span><span><i style="background:var(--forest)"></i>итог</span></div></div>
    ${crit}
  </section>`;
}

function ptsHtml(r) {
  const cls = r.state === 'v' ? 'c-ok' : r.state === 'x' ? 'c-mid' : r.state === 'c' ? 'c-low' : 'c-na';
  if (r.c.type === 'flag') return `<span class="cr-pts ${cls}">—<small> без баллов</small></span>`;
  if (r.finalAnswer === 'na' || !r.score?.effectiveWeight) return `<span class="cr-pts c-na">—<small> / 0</small></span>`;
  return `<span class="cr-pts ${cls}">${fmt(r.score.effectivePoints, 1)}<small> / ${fmt(r.score.effectiveWeight, 1)}</small></span>`;
}

function critHtml(r) {
  const on = S.open === r.c.id;
  const it = r.item;
  const notes = [];
  if (it?.evidenceIssues?.length || it?.needsReview) notes.push('<small>требует проверки человеком</small>');
  if (r.openAppeal) notes.push('<small class="ap-note">апелляция на рассмотрении</small>');
  else if (r.changed) notes.push('<small class="ap-note">изменено проверяющим</small>');
  const hasEv = (it?.evidence || []).some((i) => i < S.msgs.length);
  let h = `<div class="cr ${r.state}${on ? ' on' : ''}" id="crit-${esc(r.c.id)}" data-crit="${esc(r.c.id)}"${hasEv ? ' data-has-evidence' : ''} style="view-transition-name:cr-${esc(r.c.id)}">
    <button type="button" class="cr-h" data-act="open" data-crit="${esc(r.c.id)}" aria-expanded="${on}">
      <span class="cr-code">${r.code}</span>
      <span class="cr-name">${esc(r.c.name)}${notes.join('')}</span>
      <span class="tag ${stateTag(r.state)}">${r.changed ? `<s>${esc(answerLabel(r.c, r.aiAnswer))}</s> → ` : ''}${esc(answerLabel(r.c, r.finalAnswer))}</span>
      ${ptsHtml(r)}${chev}
    </button>`;
  if (!on) return `${h}</div>`;
  h += '<div class="cr-b">';
  if (!it) {
    h += '<p class="why muted">Критерий не оценён в этой оценке (добавлен в чек-лист позже). Запустите оценку заново.</p>';
    return `${h}</div></div>`;
  }
  const na = r.finalAnswer === 'na';
  h += `<p class="why">${na ? `<b>Не применимо${r.c.naCondition ? `: ${esc(r.c.naCondition.replace(/\.$/, ''))}` : ''}.</b> ` : ''}${esc(it.explanation)}</p>`;
  for (const i of it.evidence || []) {
    const m = S.msgs[i];
    if (!m) continue;
    const verified = !(it.evidenceIssues?.length || it.invalidEvidence?.includes(i));
    h += `<button type="button" class="quote" data-jump="${i}">«${esc(m.text)}»<small>${icon(verified ? 'check' : 'alert')}${verified ? 'Реплика сверена с транскриптом' : 'Доказательство не прошло проверку'} · #${i} · ${esc(roleName(m.speaker))}${m.label ? `, ${esc(m.label)}` : ''}</small></button>`;
  }
  if (it.checkedRange && !na) {
    const [a, b] = it.checkedRange;
    h += `<p class="why small">Проверенный участок: <a href="#" data-jump="${a}" data-to="${b}">#${a} — #${b}${S.msgs[a]?.label ? ` (${esc(S.msgs[a].label)} — ${esc(S.msgs[b]?.label || '')})` : ''}</a>${r.state === 'x' && !(it.evidence || []).length ? '. Нужное действие не найдено.' : ''}</p>`;
  }
  const facts = [];
  if (r.c.type === 'flag') facts.push('<span>Флаг <b>без баллов</b></span>');
  else {
    facts.push(`<span>Вес <b>${r.c.weight}${na ? ' → 0' : r.score?.effectiveWeight != null && r.score.effectiveWeight !== r.c.weight ? ` → ${fmt(r.score.effectiveWeight)}` : ''}</b>${!na && r.score?.effectiveWeight !== r.c.weight ? ' после N/A' : ''}</span>`);
    if (!na && r.score?.effectivePoints != null) facts.push(`<span>Баллы <b>${fmt(r.score.effectivePoints)} из ${fmt(r.score.effectiveWeight)}</b></span>`);
  }
  if (it.confidence != null) facts.push(`<span>Уверенность <b${it.confidence < 0.6 ? ' class="c-mid"' : ''}>${Math.round(it.confidence * 100)}%</b></span>`);
  if (it.votes?.length > 1) facts.push(`<span>Голоса прогонов <b>${it.votes.map((v) => esc(answerLabel(r.c, v))).join(' / ')}</b></span>`);
  h += `<div class="facts">${facts.join('')}</div>`;
  if (it.advice) h += `<div class="coach"><span class="cap">Совет оператору</span>${esc(it.advice)}</div>`;
  if (it.revision) h += `<div class="note-box mid"><b>Пересмотрено агентом-уточнителем:</b> ${esc(answerLabel(r.c, it.revision.from))} → ${esc(answerLabel(r.c, it.revision.to))}. Замечание агента-проверяющего: ${esc(it.revision.reason)}</div>`;
  else if (it.verifier?.verdict === 'ok') h += `<p class="verified">${icon('shield')}Подтверждено агентом-проверяющим</p>`;
  else if (it.verifier?.verdict === 'doubt') h += `<div class="note-box mid">Агент-проверяющий сомневался («${esc(it.verifier.issue)}»), уточнитель оставил оценку.</div>`;
  if (it.evidenceIssues?.length) h += `<div class="review-flag">${icon('alert')}⚠ Требует проверки человеком: доказательство не прошло проверку — ${esc(it.evidenceIssues.join('; '))}</div>`;
  else if (it.needsReview) h += `<div class="review-flag">${icon('alert')}⚠ Требует проверки человеком: ИИ не уверен${it.confidence != null ? ` (уверенность ${Math.round(it.confidence * 100)}%)` : ''}${it.votes?.length > 1 ? `, голоса прогонов: ${it.votes.map((v) => esc(answerLabel(r.c, v))).join(' / ')}` : ''}.</div>`;
  if (it.analysis) h += `<details class="more analysis"><summary>Ход рассуждения ИИ${chev}</summary><p>${esc(it.analysis)}</p></details>`;
  for (const a of r.appeals) h += appealHistHtml(a, r);
  const isReviewer = role.get() === 'reviewer';
  if (S.appealing === r.c.id) {
    h += `<form class="appeal-form" data-appeal-form="${esc(r.c.id)}">
      <textarea class="textarea" name="comment" required placeholder="Почему оценка неверна? Сошлитесь на реплику, например #12" aria-label="Комментарий к апелляции"></textarea>
      <label class="lbl">Ожидаемая оценка (необязательно)<select class="select" name="proposed"><option value="">— не указывать —</option>${answerOptions(r.c).filter(([v]) => v !== r.finalAnswer).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
      <div class="acts"><button class="btn primary sm" type="submit">Отправить проверяющему</button><button class="btn quiet sm" type="button" data-act="appeal-cancel">Отмена</button></div>
    </form>`;
  } else {
    const acts = [];
    if (!isReviewer && !r.openAppeal) acts.push(`<button type="button" class="btn sm" data-act="appeal" data-crit="${esc(r.c.id)}">${icon('flag')}Оспорить оценку</button>`);
    if (isReviewer && r.openAppeal) acts.push(`<a class="btn sm primary" href="#/appeals/${esc(r.openAppeal.id)}">${icon('flag')}Решить апелляцию</a>`);
    if (S.isCall && S.conv.audio_url && (it.evidence || []).length) acts.push(`<button type="button" class="btn quiet sm" data-seek="${it.evidence[0]}">${icon('play')}Прослушать</button>`);
    if (!isReviewer && r.openAppeal) acts.push('<span class="muted small">Апелляция ждёт решения проверяющего.</span>');
    if (acts.length) h += `<div class="acts">${acts.join('')}</div>`;
  }
  return `${h}</div></div>`;
}

function appealHistHtml(a, r) {
  const proposed = a.proposedAnswer ? ` · ожидаемая оценка: <b>${esc(answerLabel(r.c, a.proposedAnswer))}</b>` : '';
  let res;
  if (a.status === 'open') res = `<a href="#/appeals/${esc(a.id)}">на рассмотрении</a>`;
  else {
    const d = a.decision;
    res = `${d.action === 'change' ? `оценка изменена: ${esc(answerLabel(r.c, r.aiAnswer))} → <b>${esc(answerLabel(r.c, d.answer))}</b>` : 'оценка подтверждена'} · ${esc(d.reviewer)}, ${fmtDate(d.decidedAt)}<div class="muted">Причина: ${esc(d.reason)}</div>`;
  }
  return `<div class="hist${a.status === 'open' ? ' open' : ''}"><b>Апелляция</b> · ${esc(a.author)}, ${fmtDate(a.createdAt)}${proposed}: «${esc(a.comment)}» — ${res}</div>`;
}

const ENDING_RU = {
  operator_farewell: 'оператор попрощался',
  operator_closed_without_farewell: 'оператор закрыл чат без прощания',
  client_left: 'клиент ушёл',
  connection_lost: 'связь прервалась',
  call_ended: 'звонок завершён',
  other: 'другое',
};
const RISK_RU = { rude: 'грубость', insult: 'оскорбление', personal_service: 'личная услуга', disclosure: 'раскрытие данных', other: 'другое' };
const sec = (ms) => `${((ms || 0) / 1000).toFixed(1)} с`;
const ref = (i) => (i == null ? '' : `<button type="button" class="ref" data-jump="${i}">#${i}</button>`);

/** Ход проверки: трасса мультиагентного конвейера и параметры оценки. */
function processHtml(ev, model) {
  const crit = (id) => ev.checklist.criteria.find((c) => c.id === id);
  const metaFacts = `<div class="facts meta-facts">
      <span>Модель <b>${esc(ev.model)}</b></span>
      <span>Режим <b>${modeLabel(ev)}</b></span>
      <span>Время <b>${(ev.durationMs / 1000).toFixed(1)} с</b></span>
      <span>Стоимость <b>${fmtUsd(ev.costUsd)}</b></span>
      <span>Вызовов <b>${ev.usage?.calls ?? '—'}</b></span>
      <span>Токенов <b>${ev.usage ? (ev.usage.input + ev.usage.output).toLocaleString('ru-RU') : '—'}</b></span>
      <span>Оценено <b>${fmtDate(ev.createdAt)}</b></span>
    </div>`;
  let pipe = '';
  if (ev.pipeline) {
    const steps = ev.pipeline.steps || [];
    const map = ev.pipeline.dialogMap;
    const context = steps.find((s) => s.agent === 'context');
    const agents = steps.filter((s) => s.agent === 'criterion');
    const validator = steps.find((s) => s.agent === 'validator');
    const verifier = steps.find((s) => s.agent === 'verifier');
    const rejudges = steps.filter((s) => s.agent === 'rejudge');
    const notes = Object.entries(validator?.notes || {});
    const parallelMs = Math.max(0, ...agents.map((a) => a.ms || 0));
    pipe = `<ol class="pipe">
      <li><div class="pipe-head"><span class="pipe-n">1</span><b>Агент контекста</b><span class="muted">${sec(context?.ms)} · ${context?.tokens || 0} ток.</span></div>
        ${map ? `<div class="pipe-body">
          <div><span class="muted">Запросы клиента:</span> ${(map.client_requests || []).map((r) => `${ref(r.msg)} ${esc(r.request)}`).join('; ') || '—'}</div>
          <div><span class="muted">Первая реплика оператора:</span> ${ref(map.operator_first_msg)} ${esc(map.operator_first_text || '—')}</div>
          <div><span class="muted">Подтверждение личности:</span> ${(map.identity_events || []).map((e) => `${ref(e.msg)} ${esc(e.event)}`).join('; ') || 'нет'}</div>
          <div><span class="muted">Недовольство клиента:</span> ${(map.client_dissatisfaction || []).map((e) => `${ref(e.msg)} «${esc(e.quote)}»`).join('; ') || 'нет'}</div>
          <div><span class="muted">Рискованные фразы:</span> ${(map.risky_operator_phrases || []).map((e) => `${ref(e.msg)} ${RISK_RU[e.kind] || esc(e.kind)}: «${esc(e.quote)}»`).join('; ') || 'нет'}</div>
          ${map.ending ? `<div><span class="muted">Завершение:</span> ${esc(ENDING_RU[map.ending.how] || map.ending.how)} ${ref(map.ending.last_operator_msg)}</div>` : ''}
        </div>` : ''}</li>
      <li><div class="pipe-head"><span class="pipe-n">2</span><b>Агенты критериев</b><span class="muted">${agents.length} параллельно · ${sec(parallelMs)}</span></div>
        <div class="pipe-chips">${agents.map((a) => {
          const c = crit(a.criterionId);
          const r = model.rows.find((x) => x.c.id === a.criterionId);
          return a.error
            ? `<span class="tag bad" title="${esc(a.error)}">${esc(r?.code || a.criterionId)} ошибка</span>`
            : `<button type="button" class="tag ${stateTag(r ? (c ? r.state : 'na') : 'na')} pchip" data-act="open" data-crit="${esc(a.criterionId)}" data-keep="1" title="${esc(c?.name)} · уверенность ${Math.round((a.confidence || 0) * 100)}% · ${sec(a.ms)}">${esc(r?.code || a.criterionId)} ${esc(answerLabel(c, a.answer))}</button>`;
        }).join('')}</div></li>
      <li><div class="pipe-head"><span class="pipe-n">3</span><b>Валидатор правил</b><span class="muted">код, без ИИ</span></div>
        <div class="pipe-body">${notes.length ? notes.map(([id, n]) => `<div>${esc(id)}: ${esc(n.join('; '))}</div>`).join('') : 'Нарушений формальных правил нет: N/A только где разрешён, доказательства на месте.'}</div></li>
      <li><div class="pipe-head"><span class="pipe-n">4</span><b>Агент-проверяющий</b><span class="muted">${sec(verifier?.ms)} · ${verifier?.tokens || 0} ток.</span></div>
        <div class="pipe-body">${verifier?.error ? `<span class="c-mid">Проверяющий: ${esc(verifier.error)} — оценка сохранена без перекрёстной проверки.</span>`
          : verifier?.doubts?.length ? verifier.doubts.map((id) => `<div><b>${esc(id)}</b>: ${esc(verifier.checks[id]?.issue)} <span class="muted">(предлагает «${esc(answerLabel(crit(id), verifier.checks[id]?.suggested_answer))}»)</span></div>`).join('')
          : 'Противоречий между вердиктами не найдено.'}</div></li>
      <li><div class="pipe-head"><span class="pipe-n">5</span><b>Агент-уточнитель</b><span class="muted">${rejudges.length ? `пересмотр ${rejudges.length}` : 'не потребовался'}</span></div>
        ${rejudges.length ? `<div class="pipe-body">${rejudges.map((r) => {
          const c = crit(r.criterionId);
          if (r.error) return `<div>${esc(r.criterionId)}: ошибка — ${esc(r.error)}</div>`;
          return `<div><b>${esc(r.criterionId)}</b>: ${r.from === r.to ? `оставил «${esc(answerLabel(c, r.to))}» — довод проверяющего не подтвердился` : `изменил «${esc(answerLabel(c, r.from))}» → «${esc(answerLabel(c, r.to))}»`}</div>`;
        }).join('')}</div>` : ''}</li>
    </ol>`;
  }
  return `<section class="sheet process">
    <details ${ev.pipeline ? 'open' : ''}>
      <summary class="sheet-h"><div><h2>Ход проверки</h2><p>${ev.pipeline ? `мультиагентный конвейер · ${ev.usage?.calls ?? '—'} вызовов модели` : modeLabel(ev)} · ${fmtUsd(ev.costUsd)}</p></div>${chev}</summary>
      ${ev.summary ? `<p class="proc-sum">${esc(ev.summary)}</p>` : ''}
      ${pipe}
      <div class="sheet-b proc-meta">${metaFacts}
        <button type="button" class="btn quiet sm" id="show-raw" ${ev.rawAvailable === false ? 'disabled title="Ответ модели не сохранён"' : ''}>${icon('code')}Ответ модели (JSON)</button>
        <pre class="raw" id="raw" hidden></pre>
      </div>
    </details>
  </section>`;
}

const trainUrl = (token) => `${location.origin}/train/${token}`;
function trainingHtml() {
  const trainings = S.data.trainings || [];
  const isCurrent = S.ev.id === S.data.current?.id;
  return `<section class="sheet train-box">
    <div class="sheet-h"><div><h2>Тренировка для оператора</h2><p>ИИ сыграет этого клиента, коуч подскажет по ходу, итог сравнится с этим диалогом</p></div>
      <button type="button" class="btn sm ${trainings.length ? '' : 'primary'}" id="make-training" ${isCurrent ? '' : 'disabled title="Тренировка создаётся по последней оценке"'}>${icon('cap')}${trainings.length ? 'Новая ссылка' : 'Создать ссылку'}</button></div>
    ${trainings.length ? `<ul class="train-list">${trainings.map((t) => {
      const best = t.attempts.filter((a) => a.total != null).sort((a, b) => b.total - a.total)[0];
      return `<li><div class="train-link"><input class="input" readonly value="${esc(trainUrl(t.token))}" aria-label="Ссылка на тренировку"><button type="button" class="btn sm" data-copy="${esc(trainUrl(t.token))}">${icon('copy')}Копировать</button><a class="btn sm quiet" href="/train/${esc(t.token)}" target="_blank" rel="noopener">Открыть</a></div>
        <p class="small muted">${esc(t.title)} · ${fmtDate(t.createdAt)} · попыток ${t.attempts.length}${best ? ` · лучший результат <b class="c-${band(best.total)}">${fmt(best.total)}</b> (в диалоге ${fmt(t.originalTotal)})` : ''}</p></li>`;
    }).join('')}</ul>` : ''}
  </section>`;
}

// ── транскрипт и запись ─────────────────────────────────────────────
function chatHtml() {
  const { msgs, model, conv, isCall } = S;
  return `<section class="sheet chat" id="chat">
    <div class="sheet-h"><div><h2>Разговор</h2><p>${msgs.length} реплик · бот и система — контекст, оценивается только оператор</p></div></div>
    ${model ? timeline(msgs, model) : ''}
    ${isCall && conv.audio_url ? playerHtml() : ''}
    <div class="msgs" data-scroll-box data-keep-scroll>${msgs.map(msgHtml).join('')}</div>
  </section>`;
}

function playerHtml() {
  const { msgs } = S;
  const dur = durationOf(msgs);
  // полоса из реплик: высота — сколько сказано в этом отрезке разговора
  const N = 60;
  const bins = Array(N).fill(0);
  msgs.forEach((m, i) => {
    if (m.speaker === 'system') return;
    const next = msgs[i + 1]?.offsetSec ?? dur;
    const a = Math.floor((m.offsetSec / dur) * N);
    const b = Math.max(a, Math.min(N - 1, Math.floor((next / dur) * N)));
    for (let k = a; k <= b && k < N; k++) bins[k] += (m.text || '').length / (b - a + 1);
  });
  const max = Math.max(1, ...bins);
  return `<div class="player">
    <button type="button" class="pb" id="pb" aria-label="Слушать">${icon('play')}</button>
    <div class="wv" id="wv" title="Перемотать" role="slider" aria-label="Перемотка записи" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">${bins.map((v) => `<i style="height:${Math.round(14 + (v / max) * 86)}%"></i>`).join('')}</div>
    <span class="tm" id="ptime">00:00 / ${formatSec(dur)}</span>
    <div class="facts"><label>Скорость <select class="select sm" id="audio-rate"><option>0.75</option><option selected>1</option><option>1.25</option><option>1.5</option><option>2</option></select></label><a href="${esc(S.conv.audio_url)}" target="_blank" rel="noopener">Плеер организаторов ↗</a><span>Время реплики — от начала разговора; на паузах записи возможен сдвиг.</span></div>
    <audio id="audio" preload="none" src="${api.audioUrl(S.conv.conversation_id)}"></audio>
  </div>`;
}

function msgHtml(m) {
  return `<div class="msg ${esc(m.speaker)}" id="m-${m.index}" data-index="${m.index}"><small><span>${esc(roleName(m.speaker))}</span><span>#${m.index}</span><span title="${esc(m.timestamp)}">${esc(m.label)}</span></small>${esc(m.text)}${S.isCall && S.conv.audio_url ? `<button type="button" class="seek" data-seek="${m.index}" aria-label="Слушать с этого места">${icon('play')}</button>` : ''}</div>`;
}

/** Подсветка реплик открытого критерия: доказательства и проверенный участок. */
function syncHighlights() {
  const root = S.ctx.view;
  root.querySelectorAll('.msg.lit, .msg.span').forEach((m) => m.classList.remove('lit', 'bad', 'span'));
  const r = S.open && S.model?.rows.find((x) => x.c.id === S.open);
  if (!r?.item) return;
  for (const i of r.item.evidence || []) root.querySelector(`#m-${i}`)?.classList.add('lit', ...(r.state === 'v' ? [] : ['bad']));
  if (r.item.checkedRange && r.finalAnswer !== 'na') for (let i = r.item.checkedRange[0]; i <= r.item.checkedRange[1]; i++) root.querySelector(`#m-${i}`)?.classList.add('span');
}

/** Переход к реплике: прокрутка внутри транскрипта (на узком экране — страницы), вспышка, перемотка записи. */
export function jump(from, to = from) {
  const root = S?.ctx.view;
  const l = root?.querySelector(`#m-${from}`);
  if (!l) return;
  root.querySelectorAll('.msg.hl').forEach((m) => m.classList.remove('hl'));
  for (let i = Number(from); i <= Number(to); i++) root.querySelector(`#m-${i}`)?.classList.add('hl');
  const box = l.closest('[data-scroll-box]');
  const chat = root.querySelector('#chat');
  const sticky = chat && getComputedStyle(chat).position === 'sticky';
  if (box && sticky) box.scrollTo({ top: l.offsetTop - box.clientHeight / 3, behavior: reduced() ? 'auto' : 'smooth' });
  else {
    if (box) box.scrollTo({ top: l.offsetTop - box.clientHeight / 3 });
    l.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
  }
  l.classList.remove('flash');
  void l.offsetWidth;
  l.classList.add('flash');
  setTimeout(() => l.classList.remove('flash'), 1600);
  const audio = root.querySelector('#audio');
  const m = S.msgs[Number(from)];
  if (audio && m?.offsetSec != null && audio.readyState > 0) audio.currentTime = m.offsetSec;
}

// ── события ──────────────────────────────────────────────────────────
function redrawLeft() {
  keepScroll(() => {
    S.ctx.view.querySelector('#conv-left').innerHTML = leftHtml();
    bindLeft();
    syncHighlights();
    painted(S.ctx.view, `card:${S.id}:${S.ev?.id || ''}`);
  });
}

function toggle(id, keep) {
  S.open = S.open === id && !keep ? null : id;
  S.appealing = null;
  swap(redrawLeft);
  const r = S.open && S.model.rows.find((x) => x.c.id === S.open);
  const i = r?.item ? (r.item.evidence?.[0] ?? (r.finalAnswer !== 'na' ? r.item.checkedRange?.[0] : null)) : null;
  if (i != null) setTimeout(() => jump(i, r.item.evidence?.length ? i : r.item.checkedRange?.[1]), 80);
}

function bindAll() {
  const root = S.ctx.view.querySelector('#card-root');
  const $ = (s) => root.querySelector(s);
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act], [data-jump], [data-seek], [data-copy]');
    if (!el || !root.contains(el)) return;
    if (el.dataset.jump != null) {
      e.preventDefault();
      return jump(el.dataset.jump, el.dataset.to);
    }
    if (el.dataset.seek != null) return seek(Number(el.dataset.seek));
    if (el.dataset.copy != null) return copy(el);
    const act = el.dataset.act;
    if (act === 'open') toggle(el.dataset.crit, el.dataset.keep != null);
    else if (act === 'appeal') {
      S.appealing = el.dataset.crit;
      S.open = el.dataset.crit;
      redrawLeft();
      $('[data-appeal-form] textarea')?.focus();
    } else if (act === 'appeal-cancel') {
      S.appealing = null;
      redrawLeft();
    }
  });

  $('#eval-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.submitter;
    busy(btn, true, 'ИИ оценивает…');
    try {
      const res = await api.evaluate(S.id, f.get('checklist'), readMode(f.get('mode')));
      toast(`Оценка готова: ${fmt(res.result?.finalScore.total ?? res.score.total)} баллов`, 'ok');
      if (S.ctx.query.get('ev')) location.hash = `#/c/${encodeURIComponent(S.id)}`;
      else reload();
    } catch (err) {
      toast(`Оценка не выполнена: ${err.message}`, 'error');
      busy(btn, false);
    }
  });
  $('#ev-history')?.addEventListener('change', (e) => {
    location.hash = `#/c/${encodeURIComponent(S.id)}?ev=${e.target.value}`;
  });

  // запись звонка
  const audio = $('#audio');
  if (audio) {
    const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationOf(S.msgs));
    const pb = $('#pb');
    pb.addEventListener('click', () => (audio.paused ? play() : audio.pause()));
    audio.addEventListener('play', () => (pb.innerHTML = icon('pause'), pb.setAttribute('aria-label', 'Пауза')));
    audio.addEventListener('pause', () => (pb.innerHTML = icon('play'), pb.setAttribute('aria-label', 'Слушать')));
    audio.addEventListener('timeupdate', () => {
      const p = audio.currentTime / dur();
      root.querySelectorAll('#wv i').forEach((b, i, a) => b.classList.toggle('on', i / a.length <= p));
      $('#wv').setAttribute('aria-valuenow', String(Math.round(p * 100)));
      $('#ptime').textContent = `${formatSec(audio.currentTime)} / ${formatSec(dur())}`;
      let cur = -1;
      S.msgs.forEach((m, i) => m.offsetSec <= audio.currentTime && (cur = i));
      root.querySelectorAll('.msg.playing').forEach((n) => n.id !== `m-${cur}` && n.classList.remove('playing'));
      if (!audio.paused) root.querySelector(`#m-${cur}`)?.classList.add('playing');
    });
    audio.addEventListener('error', () => toast('Запись не загрузилась — откройте плеер организаторов', 'error'));
    $('#wv').addEventListener('click', (e) => {
      const rc = e.currentTarget.getBoundingClientRect();
      const t = ((e.clientX - rc.left) / rc.width) * dur();
      audio.currentTime = t;
      play();
    });
    $('#audio-rate').addEventListener('change', (e) => (audio.playbackRate = Number(e.target.value)));
  }
  bindLeft();
  syncHighlights();
}

function play() {
  const audio = S.ctx.view.querySelector('#audio');
  audio?.play().catch(() => toast('Не удалось воспроизвести запись — откройте плеер организаторов', 'error'));
}
function seek(i) {
  const audio = S.ctx.view.querySelector('#audio');
  const m = S.msgs[i];
  if (!audio || !m) return;
  jump(i);
  const go = () => {
    audio.currentTime = Math.max(0, m.offsetSec);
    play();
  };
  if (audio.readyState > 0) go();
  else {
    audio.addEventListener('loadedmetadata', go, { once: true });
    audio.load();
  }
}
async function copy(b) {
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    toast('Ссылка скопирована — отправьте её оператору', 'ok');
  } catch {
    b.previousElementSibling?.select();
  }
}

function bindLeft() {
  const root = S.ctx.view.querySelector('#conv-left');
  const $ = (s) => root.querySelector(s);
  if (!S.ev) return;
  // водопад строится после вставки (нужны размеры)
  requestAnimationFrame(() => {
    S._built = drawWaterfall($('#wfChart'), S.model, S.open);
  });

  $('#show-raw')?.addEventListener('click', async (e) => {
    const pre = $('#raw');
    if (!pre.hidden) return (pre.hidden = true);
    const btn = e.currentTarget;
    busy(btn, true, 'Загружаю…');
    try {
      const { raw } = await api.raw(S.ev.id);
      pre.textContent = raw.length
        ? raw.map((r) => {
            try {
              return JSON.stringify(JSON.parse(r), null, 2);
            } catch {
              return String(r);
            }
          }).join('\n\n— следующий вызов —\n\n')
        : 'Ответ модели не сохранён.';
      pre.hidden = false;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });

  $('#make-training')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'ИИ готовит сценарий…');
    try {
      const t = await api.createTraining(S.ev.id);
      await navigator.clipboard?.writeText(trainUrl(t.token)).catch(() => {});
      toast(`Ссылка на тренировку скопирована: ошибок к разбору — ${t.mistakes}`, 'ok');
      reload();
    } catch (err) {
      toast(`Тренировка не создана: ${err.message}`, 'error');
      busy(btn, false);
    }
  });

  root.querySelectorAll('[data-appeal-form]').forEach((form) =>
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      busy(e.submitter, true, 'Отправляю…');
      try {
        await api.createAppeal({ evaluationId: S.ev.id, criterionId: form.dataset.appealForm, comment: f.get('comment'), proposedAnswer: f.get('proposed') || null });
        toast('Апелляция подана и ждёт решения проверяющего', 'ok');
        S.appealing = null;
        reload();
      } catch (err) {
        toast(err.message, 'error');
        busy(e.submitter, false);
      }
    }),
  );
}

let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    const box = S?.ctx.view.querySelector('#wfChart');
    if (box && S.ctx.isCurrent()) drawWaterfall(box, S.model, S.open);
  }, 120);
});
