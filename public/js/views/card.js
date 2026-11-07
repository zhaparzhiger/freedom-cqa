// Карточка диалога: транскрипт + результат оценки + апелляции и решения проверяющего.
import { api } from '../api.js';
import { esc, fmt, fmtDate, fmtUsd, toast, busy, answerLabel, answerTone, answerOptions, scoreTone, role, LANG, CHANNEL, modeSelect, readMode, modeLabel } from '../ui.js';
import { normalizeTranscript, roleName } from '../transcript.js';
import { refreshAppealsBadge } from '../app.js';

export async function renderCard(ctx, id) {
  const [data, { checklists, activeId }] = await Promise.all([api.conversation(id), api.checklists()]);
  if (!ctx.isCurrent()) return;
  const evId = ctx.query.get('ev');
  let ev = data.current;
  if (evId && evId !== ev?.id) ev = await api.evaluation(evId);
  draw(ctx, data, ev, checklists, activeId);
}

function draw(ctx, data, ev, checklists, activeId) {
  const conv = data.conversation;
  const msgs = normalizeTranscript(conv);
  const isCall = conv.channel === 'voice call';
  const isReviewer = role.get() === 'reviewer';

  ctx.view.innerHTML = `
    <div class="card-head">
      <a class="back" href="#/">← Все диалоги</a>
      <div class="card-title">
        <h1>${esc(conv.conversation_id)}</h1>
        <span class="tag">${CHANNEL[conv.channel] || esc(conv.channel)}</span>
        <span class="tag">${LANG[conv.language] || esc(conv.language)}</span>
        <span class="tag muted-tag">набор ${esc(conv.group)}</span>
      </div>
      <form class="inline-form reeval" id="eval-form">
        <select name="checklist" aria-label="Чек-лист">
          ${checklists.map((c) => `<option value="${c.id}" ${c.id === (ev?.checklistId || activeId) ? 'selected' : ''}>${esc(c.name)} · v${c.version}</option>`).join('')}
        </select>
        ${modeSelect('card-mode', ev ? (ev.mode === 'agents' ? 'agents' : ev.votes > 1 ? 'single3' : 'single') : 'agents')}
        <button class="btn primary" type="submit">${ev ? 'Оценить заново' : 'Оценить диалог'}</button>
      </form>
    </div>

    <div class="card-tabs" role="tablist">
      <button type="button" class="active" data-tab="result">Оценка</button>
      <button type="button" data-tab="transcript">Транскрипт (${msgs.length})</button>
    </div>

    <div class="card-grid" data-show="result">
      <section class="transcript-col" aria-label="Транскрипт">
        ${isCall && conv.audio_url ? audioHtml(conv) : ''}
        <div class="transcript" id="transcript">
          ${msgs.map((m) => msgHtml(m, isCall)).join('')}
        </div>
      </section>
      <section class="result-col" aria-label="Результат оценки">
        ${ev ? resultHtml(ev, data.evaluations, isReviewer, data.trainings || []) : emptyResult()}
      </section>
    </div>
  `;
  bind(ctx, data, ev, msgs);
}

function audioHtml(conv) {
  return `
    <div class="audio">
      <audio id="audio" controls preload="none" src="${api.audioUrl(conv.conversation_id)}"></audio>
      <div class="audio-row">
        <label class="tiny muted">Скорость
          <select id="audio-rate"><option>0.75</option><option selected>1</option><option>1.25</option><option>1.5</option><option>2</option></select>
        </label>
        <a class="tiny" href="${esc(conv.audio_url)}" target="_blank" rel="noopener">Открыть плеер организаторов ↗</a>
      </div>
      <p class="tiny muted">Клик по времени реплики перематывает запись. Время отсчитывается от начала разговора; на паузах записи возможен сдвиг.</p>
    </div>`;
}

function msgHtml(m, isCall) {
  return `
    <div class="msg msg-${esc(m.speaker)}" id="m-${m.index}" data-index="${m.index}">
      <div class="msg-meta">
        <span class="msg-idx">#${m.index}</span>
        <span class="msg-role">${esc(roleName(m.speaker))}</span>
        ${isCall ? `<button type="button" class="msg-time seek" data-sec="${m.offsetSec}" title="${esc(m.timestamp)}">▶ ${esc(m.label)}</button>` : `<span class="msg-time" title="${esc(m.timestamp)}">${esc(m.label)}</span>`}
      </div>
      <div class="msg-text">${esc(m.text)}</div>
    </div>`;
}

function emptyResult() {
  return `
    <div class="empty small">
      <h2>Диалог ещё не оценён</h2>
      <p>Выберите чек-лист и нажмите «Оценить диалог». Оценка занимает 5–15 секунд.</p>
    </div>`;
}

const trainUrl = (token) => `${location.origin}/train/${token}`;

function trainingHtml(trainings) {
  return `
    <section class="panel train-box">
      <div class="pipe-head"><b>Тренировка для оператора</b><span class="muted tiny">ИИ сыграет этого клиента, коуч подскажет, итог сравнится с этим диалогом</span></div>
      ${trainings.map((t) => {
        const best = t.attempts.filter((a) => a.total != null).sort((a, b) => b.total - a.total)[0];
        return `
        <div class="train-link">
          <input readonly value="${esc(trainUrl(t.token))}" aria-label="Ссылка на тренировку">
          <button type="button" class="btn small" data-copy="${esc(trainUrl(t.token))}">Копировать</button>
          <a class="btn small ghost" href="/train/${esc(t.token)}" target="_blank" rel="noopener">Открыть</a>
        </div>
        <div class="tiny muted">${esc(t.title)} · ${fmtDate(t.createdAt)} · попыток ${t.attempts.length}${best ? ` · лучший результат <b class="${scoreTone(best.total)}-text">${fmt(best.total)}</b> (было ${fmt(t.originalTotal)})` : ''}</div>`;
      }).join('')}
      <button type="button" class="btn small ${trainings.length ? 'ghost' : 'primary'}" id="make-training" style="margin-top:10px">${trainings.length ? 'Новая ссылка' : 'Создать ссылку на тренировку'}</button>
    </section>`;
}

function resultHtml(ev, history, isReviewer, trainings) {
  const r = ev.result;
  const fs = r.finalScore;
  const changed = r.changed.length > 0;
  const crit = ev.checklist.criteria;
  const review = ev.items.filter((i) => i.needsReview).length;
  return `
    <div class="score-card">
      <div class="score-main">
        <div class="score-big ${scoreTone(fs.total)}">${fs.total == null ? '—' : fmt(fs.total)}<small>/100</small></div>
        <div>
          <div class="score-label">${changed ? 'Финальный балл после пересмотра' : 'Итоговый балл'}</div>
          ${changed ? `<div class="muted">Исходная оценка ИИ: <s>${fmt(r.originalScore.total)}</s> → ${fmt(fs.total)}</div>` : ''}
          ${fs.total == null ? '<div class="muted">Нет применимых критериев с весом — итог не рассчитывается</div>' : ''}
          <div class="score-flags">
            ${fs.grossError ? '<span class="tag bad big">⚠ Грубая ошибка</span>' : '<span class="tag good">Грубых ошибок нет</span>'}
            ${review ? `<span class="tag mid" title="Доказательство не прошло проверку, агенты разошлись или уверенность низкая">⚠ Требует проверки человеком: ${review}</span>` : ''}
            ${r.openAppeals ? `<span class="tag warn">Открытых апелляций: ${r.openAppeals}</span>` : ''}
          </div>
        </div>
      </div>
      ${fs.sections.length ? `<div class="sections">${fs.sections.map((s) => `
        <div class="section-bar">
          <div class="section-name">${esc(s.name)}</div>
          <div class="bar"><span class="${scoreTone(s.percent)}" style="width:${s.percent ?? 0}%"></span></div>
          <div class="section-val">${s.percent == null ? 'N/A' : `${fmt(s.points)} из ${fmt(s.max)}`}</div>
        </div>`).join('')}</div>` : ''}
      ${ev.summary ? `<p class="summary">${esc(ev.summary)}</p>` : ''}
      <div class="ev-meta tiny muted">
        Чек-лист «${esc(ev.checklist.name)}» v${ev.checklistVersion} · ${esc(ev.model)} · ${modeLabel(ev)} ·
        ${(ev.durationMs / 1000).toFixed(1)} с · ${fmtUsd(ev.costUsd)} · ${ev.usage.calls} вызовов, ${(ev.usage.input + ev.usage.output).toLocaleString('ru-RU')} токенов · ${fmtDate(ev.createdAt)}
        ${history.length > 1 ? `<br>История оценок: <select id="ev-history">${history.slice().reverse().map((h) => `<option value="${h.id}" ${h.id === ev.id ? 'selected' : ''}>${fmtDate(h.createdAt)} · ${fmt(h.total)} · ${esc(h.checklist)}</option>`).join('')}</select>` : ''}
        · <button type="button" class="linkish" id="show-raw">Ответ модели (JSON)</button>
      </div>
      <pre class="raw" id="raw" hidden></pre>
    </div>
    ${trainingHtml(trainings)}
    ${ev.pipeline ? pipelineHtml(ev) : ''}

    <div class="criteria">
      ${crit.map((c) => criterionHtml(c, ev, r, isReviewer)).join('')}
    </div>`;
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
const ref = (i) => (i == null ? '' : `<button type="button" class="ev-chip" data-goto="${i}">#${i}</button>`);

/** Трасса мультиагентного конвейера: кто что решил, сколько времени и токенов ушло. */
function pipelineHtml(ev) {
  const steps = ev.pipeline.steps;
  const map = ev.pipeline.dialogMap;
  const crit = (id) => ev.checklist.criteria.find((c) => c.id === id);
  const context = steps.find((s) => s.agent === 'context');
  const agents = steps.filter((s) => s.agent === 'criterion');
  const validator = steps.find((s) => s.agent === 'validator');
  const verifier = steps.find((s) => s.agent === 'verifier');
  const rejudges = steps.filter((s) => s.agent === 'rejudge');
  const notes = Object.entries(validator?.notes || {});
  const parallelMs = Math.max(0, ...agents.map((a) => a.ms || 0));
  return `
    <details class="pipeline panel" open>
      <summary><b>Ход проверки</b> <span class="muted tiny">мультиагентный конвейер · ${ev.usage.calls} вызовов модели</span></summary>
      <ol class="pipe">
        <li>
          <div class="pipe-head"><span class="pipe-n">1</span><b>Агент контекста</b><span class="muted tiny">${sec(context?.ms)} · ${context?.tokens || 0} ток.</span></div>
          <div class="pipe-body tiny">
            ${map ? `
              <div><span class="muted">Запросы клиента:</span> ${map.client_requests.map((r) => `${ref(r.msg)} ${esc(r.request)}`).join('; ') || '—'}</div>
              <div><span class="muted">Первая реплика оператора:</span> ${ref(map.operator_first_msg)} ${esc(map.operator_first_text || '—')}</div>
              <div><span class="muted">Подтверждение личности:</span> ${map.identity_events.map((e) => `${ref(e.msg)} ${esc(e.event)}`).join('; ') || 'нет'}</div>
              <div><span class="muted">Недовольство клиента:</span> ${map.client_dissatisfaction.map((e) => `${ref(e.msg)} «${esc(e.quote)}»`).join('; ') || 'нет'}</div>
              <div><span class="muted">Рискованные фразы:</span> ${map.risky_operator_phrases.map((e) => `${ref(e.msg)} ${RISK_RU[e.kind] || esc(e.kind)}: «${esc(e.quote)}»`).join('; ') || 'нет'}</div>
              <div><span class="muted">Завершение:</span> ${esc(ENDING_RU[map.ending.how] || map.ending.how)} ${ref(map.ending.last_operator_msg)}</div>` : ''}
          </div>
        </li>
        <li>
          <div class="pipe-head"><span class="pipe-n">2</span><b>Агенты критериев</b><span class="muted tiny">${agents.length} параллельно · ${sec(parallelMs)}</span></div>
          <div class="pipe-chips">
            ${agents.map((a) => {
              const c = crit(a.criterionId);
              return a.error
                ? `<span class="pchip bad" title="${esc(a.error)}">${esc(a.criterionId)} ошибка</span>`
                : `<span class="pchip ${answerTone(c, a.answer)}" title="${esc(c?.name)} · уверенность ${Math.round((a.confidence || 0) * 100)}% · ${sec(a.ms)}">${esc(a.criterionId)} ${esc(answerLabel(c, a.answer))}</span>`;
            }).join('')}
          </div>
        </li>
        <li>
          <div class="pipe-head"><span class="pipe-n">3</span><b>Валидатор правил</b><span class="muted tiny">код, без ИИ</span></div>
          <div class="pipe-body tiny">${notes.length ? notes.map(([id, n]) => `<div>${esc(id)}: ${esc(n.join('; '))}</div>`).join('') : 'Нарушений формальных правил нет: N/A только где разрешён, доказательства на месте.'}</div>
        </li>
        <li>
          <div class="pipe-head"><span class="pipe-n">4</span><b>Агент-проверяющий</b><span class="muted tiny">${sec(verifier?.ms)} · ${verifier?.tokens || 0} ток.</span></div>
          <div class="pipe-body tiny">${verifier?.doubts?.length
            ? verifier.doubts.map((id) => `<div><b>${esc(id)}</b>: ${esc(verifier.checks[id]?.issue)} <span class="muted">(предлагает «${esc(answerLabel(crit(id), verifier.checks[id]?.suggested_answer))}»)</span></div>`).join('')
            : 'Противоречий между вердиктами не найдено.'}</div>
        </li>
        <li>
          <div class="pipe-head"><span class="pipe-n">5</span><b>Агент-уточнитель</b><span class="muted tiny">${rejudges.length ? `пересмотр ${rejudges.length}` : 'не потребовался'}</span></div>
          ${rejudges.length ? `<div class="pipe-body tiny">${rejudges.map((r) => {
            const c = crit(r.criterionId);
            if (r.error) return `<div>${esc(r.criterionId)}: ошибка — ${esc(r.error)}</div>`;
            return `<div><b>${esc(r.criterionId)}</b>: ${r.from === r.to ? `оставил «${esc(answerLabel(c, r.to))}» — довод проверяющего не подтвердился` : `изменил «${esc(answerLabel(c, r.from))}» → «${esc(answerLabel(c, r.to))}»`}</div>`;
          }).join('')}</div>` : ''}
        </li>
      </ol>
    </details>`;
}

function evidenceHtml(item) {
  const parts = [];
  if (item?.evidence?.length) parts.push(item.evidence.map((i) => `<button type="button" class="ev-chip" data-goto="${i}">#${i}</button>`).join(''));
  if (item?.checkedRange) parts.push(`<button type="button" class="ev-chip range" data-goto="${item.checkedRange[0]}" data-to="${item.checkedRange[1]}">проверен участок #${item.checkedRange[0]}–#${item.checkedRange[1]}</button>`);
  return parts.length ? `<div class="evidence"><span class="tiny muted">Основание:</span> ${parts.join(' ')}</div>` : '';
}

function criterionHtml(c, ev, r, isReviewer) {
  const item = ev.items.find((i) => i.criterionId === c.id);
  const row = r.finalScore.rows.find((x) => x.criterionId === c.id);
  const finalAnswer = r.finalAnswers[c.id];
  const appeals = r.appeals.filter((a) => a.criterionId === c.id);
  const open = appeals.find((a) => a.status === 'open');
  const changedHere = item && finalAnswer !== item.answer;
  const section = ev.checklist.sections.find((s) => s.id === c.section);

  let points = '';
  if (c.type === 'flag') points = '<span class="muted">без баллов</span>';
  else if (finalAnswer === 'na') points = `<span class="muted">вес ${c.weight} перераспределён</span>`;
  else if (row?.effectivePoints != null)
    points = `<b>${fmt(row.effectivePoints)}</b> <span class="muted">из ${fmt(row.effectiveWeight)}</span>${row.effectiveWeight !== c.weight ? `<div class="tiny muted">вес ${c.weight} → ${fmt(row.effectiveWeight)} после N/A</div>` : ''}`;

  return `
    <article class="crit ${open ? 'has-appeal' : ''}" id="crit-${c.id}" data-crit="${c.id}">
      <header class="crit-head">
        <div class="crit-name">
          <span class="crit-id">${esc(c.id)}</span> ${esc(c.name)}
          ${section ? `<div class="tiny muted">${esc(section.name)}</div>` : ''}
        </div>
        <div class="crit-score">
          ${changedHere ? `<span class="answer na"><s>${esc(answerLabel(c, item.answer))}</s></span>` : ''}
          <span class="answer ${answerTone(c, finalAnswer)}">${esc(answerLabel(c, finalAnswer))}</span>
          <div class="crit-points">${points}</div>
        </div>
      </header>
      ${item ? `
        <p class="crit-expl">${esc(item.explanation)}</p>
        ${evidenceHtml(item)}
        ${item.advice ? `<p class="advice"><b>Совет оператору:</b> ${esc(item.advice)}</p>` : ''}
        ${item.revision ? `<p class="revision"><b>Пересмотрено агентом-уточнителем:</b> ${esc(answerLabel(c, item.revision.from))} → ${esc(answerLabel(c, item.revision.to))}. Замечание проверяющего: ${esc(item.revision.reason)}</p>` : ''}
        ${!item.revision && item.verifier?.verdict === 'ok' ? '<p class="tiny verified">✓ Подтверждено агентом-проверяющим</p>' : ''}
        ${!item.revision && item.verifier?.verdict === 'doubt' ? `<p class="tiny warn-text">Проверяющий сомневался («${esc(item.verifier.issue)}»), уточнитель оставил оценку.</p>` : ''}
        ${item.evidenceIssues?.length ? `<p class="review-flag">⚠ Требует проверки человеком: доказательство не прошло проверку — ${esc(item.evidenceIssues.join('; '))}</p>` : ''}
        ${item.needsReview && !item.evidenceIssues?.length ? `<p class="tiny warn-text">ИИ не уверен: уверенность ${fmt(item.confidence * 100, 0)}%${item.votes?.length > 1 ? `, голоса прогонов: ${item.votes.map((v) => esc(answerLabel(c, v))).join(' / ')}` : ''}. Рекомендуется ручная проверка.</p>` : ''}
        <details class="analysis"><summary>Ход рассуждения ИИ</summary><p>${esc(item.analysis)}</p></details>
      ` : '<p class="muted">Критерий не оценён в этой оценке (добавлен позже). Запустите оценку заново.</p>'}
      ${appeals.map((a) => appealHtml(a, c, item, isReviewer)).join('')}
      ${item && !open && !isReviewer ? `
        <div class="appeal-actions">
          <button type="button" class="btn small ghost" data-appeal="${c.id}">Оспорить оценку</button>
        </div>
        <form class="appeal-form" data-appeal-form="${c.id}" hidden>
          <label class="field"><span>Комментарий к апелляции</span>
            <textarea name="comment" rows="3" required placeholder="Почему оценка неверна? Сошлитесь на реплику, например #12"></textarea></label>
          <label class="field"><span>Ожидаемая оценка (необязательно)</span>
            <select name="proposed"><option value="">— не указывать —</option>${answerOptions(c).filter(([v]) => v !== finalAnswer).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
          <div class="row-actions">
            <button class="btn small primary" type="submit">Подать апелляцию</button>
            <button class="btn small ghost" type="button" data-cancel>Отмена</button>
          </div>
        </form>` : ''}
    </article>`;
}

function appealHtml(a, c, item, isReviewer) {
  const proposed = a.proposedAnswer ? ` · ожидаемая оценка: <b>${esc(answerLabel(c, a.proposedAnswer))}</b>` : '';
  let body = `
    <div class="appeal-line"><b>Апелляция</b> · ${esc(a.author)} · ${fmtDate(a.createdAt)}${proposed}</div>
    <p class="appeal-comment">«${esc(a.comment)}»</p>`;
  if (a.status === 'resolved') {
    const d = a.decision;
    body += `
      <div class="decision ${d.action}">
        <b>${d.action === 'change' ? `Оценка изменена: ${esc(answerLabel(c, item?.answer))} → ${esc(answerLabel(c, d.answer))}` : 'Оценка подтверждена'}</b>
        · ${esc(d.reviewer)} · ${fmtDate(d.decidedAt)}
        <div>Причина: ${esc(d.reason)}</div>
      </div>`;
  } else if (isReviewer) {
    body += `
      <form class="decision-form" data-decide="${a.id}">
        <div class="seg">
          <label><input type="radio" name="action" value="confirm" checked> Подтвердить оценку ИИ</label>
          <label><input type="radio" name="action" value="change"> Изменить оценку</label>
        </div>
        <label class="field change-only" hidden><span>Новая оценка</span>
          <select name="answer">${answerOptions(c).filter(([v]) => v !== item?.answer).map(([v, l]) => `<option value="${v}" ${v === a.proposedAnswer ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="field"><span>Причина решения</span>
          <textarea name="reason" rows="2" required placeholder="Например: в реплике #9 оператор назвал имя"></textarea></label>
        <button class="btn small primary" type="submit">Сохранить решение</button>
      </form>`;
  } else {
    body += '<p class="tiny muted">На рассмотрении. Решение принимает проверяющий (переключите роль вверху).</p>';
  }
  return `<div class="appeal ${a.status}">${body}</div>`;
}

function bind(ctx, data, ev, msgs) {
  const $ = (s) => ctx.view.querySelector(s);
  const conv = data.conversation;
  const reload = () => renderCard(ctx, conv.conversation_id);

  // вкладки на узком экране
  ctx.view.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      ctx.view.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $('.card-grid').dataset.show = b.dataset.tab;
    }),
  );

  $('#eval-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.submitter;
    busy(btn, true, 'ИИ оценивает…');
    try {
      const res = await api.evaluate(conv.conversation_id, f.get('checklist'), readMode(f.get('mode')));
      toast(`Оценка готова: ${fmt(res.score.total)} баллов`, 'ok');
      if (ctx.query.get('ev')) location.hash = `#/c/${encodeURIComponent(conv.conversation_id)}`;
      else reload();
    } catch (err) {
      toast(err.message, 'error');
      busy(btn, false);
    }
  });

  $('#ev-history')?.addEventListener('change', (e) => {
    location.hash = `#/c/${encodeURIComponent(conv.conversation_id)}?ev=${e.target.value}`;
  });

  $('#show-raw')?.addEventListener('click', async () => {
    const pre = $('#raw');
    if (!pre.hidden) return (pre.hidden = true);
    const { raw } = await api.raw(ev.id);
    pre.textContent = raw.map((r) => JSON.stringify(JSON.parse(r), null, 2)).join('\n\n— следующий прогон —\n\n');
    pre.hidden = false;
  });

  // тренировка: ссылка для оператора
  $('#make-training')?.addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'ИИ готовит сценарий…');
    try {
      const t = await api.createTraining(ev.id);
      await navigator.clipboard?.writeText(trainUrl(t.token)).catch(() => {});
      toast(`Ссылка на тренировку скопирована: ошибок к разбору — ${t.mistakes}`, 'ok');
      reload();
    } catch (err) {
      toast(err.message, 'error');
      busy(e.currentTarget, false);
    }
  });
  ctx.view.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Ссылка скопирована — отправьте её оператору', 'ok');
      } catch {
        b.previousElementSibling.select();
      }
    }),
  );

  // переход к реплике
  const audio = $('#audio');
  const goTo = (from, to = from) => {
    ctx.view.querySelectorAll('.msg.hl').forEach((m) => m.classList.remove('hl'));
    for (let i = Number(from); i <= Number(to); i++) ctx.view.querySelector(`#m-${i}`)?.classList.add('hl');
    const target = ctx.view.querySelector(`#m-${from}`);
    if (!target) return;
    if (getComputedStyle($('.card-grid')).display !== 'grid' && $('.card-grid').dataset.show !== 'transcript') {
      ctx.view.querySelector('[data-tab="transcript"]').click();
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const msg = msgs[Number(from)];
    if (audio && msg?.offsetSec != null) audio.currentTime = msg.offsetSec;
  };
  ctx.view.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => goTo(b.dataset.goto, b.dataset.to)));
  ctx.view.querySelectorAll('.seek').forEach((b) =>
    b.addEventListener('click', () => {
      if (!audio) return;
      audio.currentTime = Number(b.dataset.sec) || 0;
      audio.play().catch(() => toast('Не удалось воспроизвести запись — откройте плеер организаторов', 'error'));
    }),
  );
  $('#audio-rate')?.addEventListener('change', (e) => (audio.playbackRate = Number(e.target.value)));
  audio?.addEventListener('error', () => toast('Запись не загрузилась — попробуйте плеер организаторов', 'error'));

  // подсветка реплик выбранного критерия
  ctx.view.querySelectorAll('.crit').forEach((card) =>
    card.addEventListener('mouseenter', () => {
      const item = ev?.items.find((i) => i.criterionId === card.dataset.crit);
      ctx.view.querySelectorAll('.msg.soft').forEach((m) => m.classList.remove('soft'));
      (item?.evidence || []).forEach((i) => ctx.view.querySelector(`#m-${i}`)?.classList.add('soft'));
    }),
  );

  // апелляции
  ctx.view.querySelectorAll('[data-appeal]').forEach((b) =>
    b.addEventListener('click', () => {
      const form = ctx.view.querySelector(`[data-appeal-form="${b.dataset.appeal}"]`);
      form.hidden = false;
      b.parentElement.hidden = true;
      form.querySelector('textarea').focus();
    }),
  );
  ctx.view.querySelectorAll('[data-appeal-form]').forEach((form) => {
    form.querySelector('[data-cancel]').addEventListener('click', () => {
      form.hidden = true;
      form.previousElementSibling.hidden = false;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      busy(e.submitter, true, 'Сохраняю…');
      try {
        await api.createAppeal({ evaluationId: ev.id, criterionId: form.dataset.appealForm, comment: f.get('comment'), proposedAnswer: f.get('proposed') || null });
        toast('Апелляция подана и ждёт решения проверяющего', 'ok');
        refreshAppealsBadge();
        reload();
      } catch (err) {
        toast(err.message, 'error');
        busy(e.submitter, false);
      }
    });
  });
  ctx.view.querySelectorAll('[data-decide]').forEach((form) => {
    const toggle = () => (form.querySelector('.change-only').hidden = form.querySelector('[name=action]:checked').value !== 'change');
    form.querySelectorAll('[name=action]').forEach((r) => r.addEventListener('change', toggle));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      busy(e.submitter, true, 'Сохраняю…');
      try {
        const res = await api.decide(form.dataset.decide, { action: f.get('action'), answer: f.get('answer'), reason: f.get('reason') });
        const t = res.evaluation.result.finalScore.total;
        toast(f.get('action') === 'change' ? `Оценка изменена. Новый итог: ${fmt(t)}` : 'Оценка подтверждена', 'ok');
        refreshAppealsBadge();
        reload();
      } catch (err) {
        toast(err.message, 'error');
        busy(e.submitter, false);
      }
    });
  });

  // переход к критерию из очереди апелляций: #/c/<id>?crit=c01
  const focus = ctx.query.get('crit');
  if (focus) setTimeout(() => ctx.view.querySelector(`#crit-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}
