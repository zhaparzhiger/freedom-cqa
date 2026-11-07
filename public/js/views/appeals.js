// Апелляции: слева — позиция сотрудника, исходная оценка ИИ и фрагмент разговора, справа — решение проверяющего
// с превью «было → стало» (тот же scoring.js, что и на сервере).
import { api } from '../api.js';
import { esc, fmt, fmtDate, toast, busy, answerLabel, answerOptions, critState, icon, role } from '../ui.js';
import { loadDetail, messages, previewDecision, forgetDetail } from '../data.js';
import { roleName } from '../transcript.js';
import { computeScore } from '../scoring.js';
import { painted, keepScroll, refreshCounts } from '../shell.js';
import { seedRoll } from '../viz.js';

let tab = 'open';
const decisions = {}; // appeal id → { action, answer, reason }
let celebrate = null;
let P = null;

const TABS = [
  ['open', 'Открытые'],
  ['resolved', 'Рассмотренные'],
  ['all', 'Все'],
];

export async function renderAppeals(ctx, selId) {
  const list = await api.appeals(tab === 'all' ? '' : tab);
  if (!ctx.isCurrent()) return;
  list.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1));
  let sel = list.find((a) => a.id === selId) || null;
  if (!sel && selId) {
    // апелляция из другой вкладки — показываем всё
    const all = await api.appeals('');
    sel = all.find((a) => a.id === selId) || null;
    if (sel) {
      tab = 'all';
      list.splice(0, list.length, ...all.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1)));
    }
  }
  sel ||= list[0] || null;
  let ev = null;
  let conv = null;
  if (sel) {
    [ev, conv] = await Promise.all([api.evaluation(sel.evaluationId), loadDetail(sel.conversationId).then((d) => d.conversation).catch(() => null)]);
    if (!ctx.isCurrent()) return;
  }
  P = { ctx, list, sel, ev, conv };
  draw();
}

function draw() {
  const { ctx, list, sel } = P;
  const isReviewer = role.get() === 'reviewer';
  const tabs = list.length
    ? `<nav class="ap-tabs" aria-label="Список апелляций">${list.map((a) => `<a href="#/appeals/${esc(a.id)}"${sel?.id === a.id ? ' aria-current="true"' : ''}><span class="dot ${a.status === 'open' ? 'open' : a.decision?.action === 'change' ? 'changed' : ''}"></span><span><b>${esc(a.criterionName || a.criterionId)}</b><small>${esc(a.conversationId)} · ${esc(a.author)} · ${a.status === 'open' ? 'ждёт решения' : a.decision?.action === 'change' ? 'изменено' : 'подтверждено'}</small></span></a>`).join('')}</nav>`
    : '';
  ctx.view.innerHTML = `<div class="page-anim">
    <header class="head">
      <div><h1>Апелляции</h1><p>${isReviewer ? 'Сотрудник оспаривает оценку в карточке диалога. Вы решаете здесь — итог пересчитывается сам.' : 'Здесь видны поданные апелляции. Решения принимает проверяющий — переключите роль вверху.'}</p></div>
      <div class="acts"><div class="seg" role="group" aria-label="Статус апелляций">${TABS.map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join('')}</div></div>
    </header>
    ${tabs}
    ${sel ? caseHtml(isReviewer) : `<div class="sheet empty"><b>${tab === 'open' ? 'Открытых апелляций нет' : 'Апелляций нет'}</b>Апелляцию подают из карточки диалога кнопкой «Оспорить оценку».</div>`}
  </div>`;
  bind();
  painted(ctx.view, `appeals:${sel?.id || ''}`);
  if (celebrate) setTimeout(() => (celebrate = null), 0);
}

function caseHtml(isReviewer) {
  const { sel: a, ev, conv } = P;
  const c = ev?.checklist.criteria.find((x) => x.id === a.criterionId);
  if (!ev || !c) return '<div class="sheet empty"><b>Оценка или критерий не найдены</b>Возможно, диалог удалён.</div>';
  const item = ev.items.find((i) => i.criterionId === c.id);
  const aiAnswer = item?.answer;
  const msgs = conv ? messages(conv) : [];
  const idx = item?.evidence || [];
  const range = item?.checkedRange && aiAnswer !== 'na' ? item.checkedRange : null;
  // фрагмент: реплики-доказательства и проверенный участок с соседями; длинный участок — только опорные реплики
  const anchors = [...idx, ...(range || [])].filter((i) => i < msgs.length);
  const lo = anchors.length ? Math.min(...anchors) : 0;
  const hi = anchors.length ? Math.max(...anchors) : Math.min(3, msgs.length - 1);
  const from = Math.max(0, lo - 1);
  const to = Math.min(msgs.length - 1, hi + 1);
  const long = to - from > 14;
  const shown = msgs.slice(from, to + 1).filter((m) => !long || anchors.some((x) => Math.abs(m.index - x) <= 1));
  const frag = shown.map((m) => `<a class="msg ${esc(m.speaker)}${idx.includes(m.index) ? ` lit${critState(c, aiAnswer) === 'v' ? '' : ' bad'}` : range && m.index >= range[0] && m.index <= range[1] ? ' span' : ''}" href="#/c/${encodeURIComponent(a.conversationId)}?crit=${esc(c.id)}"><small><span>${esc(roleName(m.speaker))}</span><span>#${m.index}</span><span>${esc(m.label)}</span></small>${esc(m.text)}</a>`).join('');
  const ver = item?.verifier;
  const why = [];
  if (item?.analysis) why.push(`<p>${esc(item.analysis)}</p>`);
  if (item?.revision) why.push(`<p class="note-box mid"><b>Пересмотрено агентом-уточнителем:</b> ${esc(answerLabel(c, item.revision.from))} → ${esc(answerLabel(c, item.revision.to))}. ${esc(item.revision.reason)}</p>`);
  else if (ver?.verdict === 'ok') why.push(`<p class="verified">${icon('shield')}Агент-проверяющий подтвердил оценку</p>`);
  else if (ver?.verdict === 'doubt') why.push(`<p class="note-box mid">Агент-проверяющий сомневался: «${esc(ver.issue)}» (предлагал «${esc(answerLabel(c, ver.suggested_answer))}»).</p>`);
  if (item?.evidenceIssues?.length) why.push(`<p class="review-flag">⚠ Требует проверки человеком: ${esc(item.evidenceIssues.join('; '))}</p>`);
  else if (item?.needsReview) why.push('<p class="review-flag">⚠ Требует проверки человеком: ИИ не уверен в ответе.</p>');
  return `<div class="ap">
    <article class="sheet case">
      <div class="part"><span class="cap">Позиция сотрудника · ${esc(a.author)}</span><p class="claim">«${esc(a.comment)}»</p>
        <p>Диалог <a href="#/c/${encodeURIComponent(a.conversationId)}?crit=${esc(c.id)}">${esc(a.conversationId)}</a> · критерий «${esc(c.name)}» · ${fmtDate(a.createdAt)}${a.proposedAnswer ? ` · ожидаемая оценка: <b>${esc(answerLabel(c, a.proposedAnswer))}</b>` : ''}</p></div>
      <div class="part"><span class="cap">Исходная оценка ИИ</span><div class="orig"><b class="${{ v: 'c-ok', x: 'c-mid', c: 'c-low', na: 'c-na' }[critState(c, aiAnswer)]}">${esc(answerLabel(c, aiAnswer))}</b><p>${esc(item?.explanation || '')}${item?.confidence != null ? ` Уверенность модели ${Math.round(item.confidence * 100)}%.` : ''}</p></div></div>
      ${frag ? `<div class="part"><span class="cap">Фрагмент разговора</span><div class="frag">${frag}</div></div>` : ''}
      ${why.length ? `<div class="part"><span class="cap">Как ИИ пришёл к оценке</span><div class="why-ai">${why.join('')}</div></div>` : ''}
    </article>
    <aside class="decide"${celebrate === a.id ? ' data-field="burst" data-origin=".big"' : ''}>${decideHtml(a, c, ev, aiAnswer, isReviewer)}</aside>
  </div>`;
}

function decideHtml(a, c, ev, aiAnswer, isReviewer) {
  if (a.status === 'resolved') {
    const d = a.decision;
    const after = ev.result.finalScore.total;
    const before = d.action === 'change' ? computeScore(ev.checklist, { ...ev.result.finalAnswers, [c.id]: aiAnswer }).total : after;
    return `<h2>Решение проверяющего</h2><span class="stamp">${icon('check')}${d.action === 'change' ? 'Оценка изменена' : 'Оценка подтверждена'}</span>
      <div class="impact"><div class="nums">${before !== after ? `<s>${fmt(before)}</s>` : ''}<span class="big roll" data-roll="${fmt(after)}" data-key="pv:${esc(a.id)}">${fmt(after)}</span></div><p>${d.action === 'change' ? `${esc(answerLabel(c, aiAnswer))} → ${esc(answerLabel(c, d.answer))}` : `оставлено «${esc(answerLabel(c, aiAnswer))}»`} · итог диалога сейчас</p></div>
      <p class="reason">${esc(d.reason)}</p><p class="by">${esc(d.reviewer)}, ${fmtDate(d.decidedAt)} · <a href="#/c/${encodeURIComponent(a.conversationId)}?crit=${esc(c.id)}">открыть диалог</a></p>`;
  }
  if (!isReviewer) {
    return `<h2>Ждёт решения</h2><div class="impact"><div class="nums"><span class="big">${fmt(ev.result.finalScore.total)}</span></div><p>итог диалога сейчас</p></div>
      <p class="reason">Решение принимает проверяющий. Переключите роль вверху на «Проверяющий», чтобы подтвердить или изменить оценку.</p>
      <p class="by"><a href="#/c/${encodeURIComponent(a.conversationId)}?crit=${esc(c.id)}">открыть диалог</a></p>`;
  }
  const s = (decisions[a.id] ||= { action: 'confirm', answer: null, reason: '' });
  const pv = previewDecision(ev, c.id, s.action, s.answer);
  const dl = pv.after != null && pv.before != null ? pv.after - pv.before : 0;
  const vals = answerOptions(c).filter(([v]) => v !== aiAnswer);
  return `<form data-decide="${esc(a.id)}"><h2>Решение проверяющего</h2>
    <div class="impact"><div class="nums"><s>${fmt(pv.before)}</s><span class="big roll" data-roll="${fmt(pv.after)}" data-key="pv:${esc(a.id)}">${fmt(pv.after)}</span><span class="d${dl < 0 ? ' neg' : ''}">${dl >= 0 ? '+' : '−'}${fmt(Math.abs(dl))}</span></div><p>итог диалога после решения${pv.score.grossError !== ev.result.finalScore.grossError ? (pv.score.grossError ? ' · появится грубая ошибка' : ' · грубая ошибка снимется') : ''}</p></div>
    <div class="opts"><button type="button" class="btn sm" data-dec="confirm" aria-pressed="${s.action === 'confirm'}">Оставить «${esc(answerLabel(c, aiAnswer))}»</button></div>
    <span class="lbl-on">или изменить на</span>
    <div class="opts">${vals.map(([v, l]) => `<button type="button" class="btn sm" data-dec="change" data-v="${esc(v)}" aria-pressed="${s.action === 'change' && s.answer === v}" title="${esc(l)}">${esc(c.type === 'scale' ? `${v} из ${Math.max(...c.scale.map((x) => x.value))}` : v === 'na' ? 'Не применимо' : answerLabel(c, v))}</button>`).join('')}</div>
    ${a.proposedAnswer ? `<span class="lbl-on">Сотрудник ожидает: «${esc(answerLabel(c, a.proposedAnswer))}»</span>` : ''}
    <textarea class="textarea" name="reason" required placeholder="Причина решения — её увидит сотрудник. Например: в реплике #9 оператор назвал имя" aria-label="Причина решения">${esc(s.reason)}</textarea>
    <button class="btn primary wide" type="submit">Сохранить решение</button></form>`;
}

function bind() {
  const { ctx } = P;
  ctx.view.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      if (location.hash !== '#/appeals') location.hash = '#/appeals';
      else renderAppeals(ctx, null);
    }),
  );
  const form = ctx.view.querySelector('[data-decide]');
  if (!form) return;
  const id = form.dataset.decide;
  const s = decisions[id];
  form.reason.addEventListener('input', () => (s.reason = form.reason.value));
  form.querySelectorAll('[data-dec]').forEach((b) =>
    b.addEventListener('click', () => {
      s.reason = form.reason.value;
      s.action = b.dataset.dec;
      s.answer = s.action === 'change' ? b.dataset.v : null;
      keepScroll(draw);
    }),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = form.reason.value.trim();
    if (!reason) return toast('Укажите причину решения', 'error');
    busy(e.submitter, true, 'Сохраняю…');
    const before = P.ev.result.finalScore.total;
    try {
      const res = await api.decide(id, { action: s.action, answer: s.answer, reason });
      const after = res.evaluation.result.finalScore.total;
      toast(s.action === 'change' ? `Итог пересчитан: ${fmt(before)} → ${fmt(after)}` : 'Оценка подтверждена', 'ok');
      delete decisions[id];
      forgetDetail(P.sel.conversationId);
      celebrate = id;
      seedRoll(`pv:${id}`, fmt(before));
      if (tab === 'open') tab = 'all';
      await renderAppeals(ctx, id);
      refreshCounts();
    } catch (err) {
      toast(err.message, 'error');
      busy(e.submitter, false);
    }
  });
}

/** Показать все апелляции, включая рассмотренные (демонстрация). */
export function showAllAppeals() {
  tab = 'all';
}
