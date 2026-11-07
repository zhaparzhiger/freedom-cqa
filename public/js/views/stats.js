// Аналитика: средний балл, проблемные критерии, согласие ИИ с проверяющим, стоимость.
import { api } from '../api.js';
import { esc, fmt, fmtUsd, scoreTone, LANG, busy, toast } from '../ui.js';
import { state } from '../app.js';

export async function renderStats(ctx) {
  const s = await api.stats();
  if (!ctx.isCurrent()) return;
  const meta = state.meta || (await api.meta());
  const resolved = s.appeals.confirmed + s.appeals.changed;
  const agreement = resolved ? (s.appeals.confirmed / resolved) * 100 : null;
  const crit = s.criteria.filter((c) => c.evaluated);

  ctx.view.innerHTML = `
    <div class="page-head"><div><h1>Аналитика</h1><p class="muted">По последней оценке каждого диалога, с учётом решений по апелляциям.</p></div></div>
    <div class="kpis">
      ${kpi('Оценено диалогов', `${s.evaluated} <small>из ${s.conversations}</small>`)}
      ${kpi('Средний балл', s.averageTotal == null ? '—' : `<span class="${scoreTone(s.averageTotal)}-text">${fmt(s.averageTotal)}</span>`)}
      ${kpi('Грубые ошибки', `<span class="${s.grossErrors ? 'bad-text' : ''}">${s.grossErrors}</span>`)}
      ${kpi('Требует проверки человеком', `${s.needsReview} <small>критериев</small>`)}
      ${kpi('Согласие ИИ с проверяющим', agreement == null ? '—' : `${fmt(agreement, 0)}% <small>из ${resolved} апелляций</small>`)}
      ${kpi('Стоимость одной оценки', `${fmtUsd(s.cost.perEvaluationUsd)} <small>${s.cost.avgSeconds ?? '—'} с</small>`)}
    </div>

    <div class="stats-grid">
      <section class="panel">
        <h3>Проблемные критерии</h3>
        <p class="tiny muted">Доля диалогов, где критерий не выполнен (для шкал — ниже максимума). N/A не учитывается.</p>
        ${crit.length ? crit.map((c) => {
          const scored = c.ok + c.notOk;
          const pct = scored ? (c.notOk / scored) * 100 : 0;
          return `
          <div class="hbar">
            <div class="hbar-label">${esc(c.name)}</div>
            <div class="bar"><span class="${c.type === 'flag' ? 'bad' : pct > 40 ? 'bad' : pct > 20 ? 'mid' : 'good'}" style="width:${pct}%"></span></div>
            <div class="hbar-val">${c.type === 'flag' ? `${c.notOk} выявл.` : `${fmt(pct, 0)}%`} <span class="muted tiny">${c.na ? `N/A ${c.na}` : ''}</span></div>
          </div>`;
        }).join('') : '<p class="muted">Нет оценённых диалогов</p>'}
      </section>
      <section class="panel">
        <h3>Средний балл по языкам</h3>
        ${Object.entries(s.byLanguage).map(([lang, v]) => `
          <div class="hbar">
            <div class="hbar-label">${esc(LANG[lang] || lang)} <span class="muted tiny">${v.count}</span></div>
            <div class="bar"><span class="${scoreTone(v.average)}" style="width:${v.average}%"></span></div>
            <div class="hbar-val">${fmt(v.average)}</div>
          </div>`).join('') || '<p class="muted">Нет данных</p>'}
        <h3>Апелляции</h3>
        <p>Всего ${s.appeals.total} · открыто ${s.appeals.open} · подтверждено ${s.appeals.confirmed} · изменено ${s.appeals.changed}</p>
        <h3>Обучение на решениях проверяющих</h3>
        <div id="learning"><p class="muted tiny">Загружаю…</p></div>
        <h3>Модель</h3>
        <p class="tiny">${esc(meta.model)} · ${esc(meta.backend)} · цена ${meta.priceInputPerM}$ / ${meta.priceOutputPerM}$ за 1 млн токенов (вход / выход).<br>
        Всего оценок: ${s.cost.evaluations}, потрачено ${fmtUsd(s.cost.totalUsd)}.</p>
      </section>
    </div>`;
  ctx.view.insertAdjacentHTML('beforeend', '<section class="panel parity" id="parity"><h3>Языковая честность</h3><p class="muted tiny">Загружаю…</p></section>');
  renderLearning(ctx).catch(() => {});
  renderParity(ctx).catch(() => {});
}

async function renderParity(ctx) {
  const box = ctx.view.querySelector('#parity');
  if (!box) return;
  const st = await api.parity();
  const run = st.running || st.runs[0];
  // Два вида перекоса: систематический сдвиг (в среднем мягче или строже) и нестабильность (разброс по диалогам выше шума).
  const verdict = (s, noiseAbs) => {
    if (s.lang.startsWith('RU') || s.meanDelta == null || noiseAbs == null) return '';
    const tags = [];
    if (Math.abs(s.meanDelta) > noiseAbs + 1.5) tags.push(`<span class="tag bad">в среднем ${s.meanDelta > 0 ? 'мягче' : 'строже'} на ${fmt(Math.abs(s.meanDelta))}</span>`);
    if (s.meanAbsDelta > Math.max(2 * noiseAbs, noiseAbs + 2)) tags.push(`<span class="tag bad">разброс в ${fmt(s.meanAbsDelta / Math.max(noiseAbs, 0.1), 1)} раза выше шума</span>`);
    return tags.join(' ') || '<span class="tag good">в пределах шума модели</span>';
  };
  let body = '';
  if (run?.status === 'running') {
    body = `<p><span class="spinner"></span> Идёт тест: ${run.done} из ${run.total} диалогов · ${fmtUsd(run.costUsd)}</p>`;
    setTimeout(() => ctx.isCurrent() && renderParity(ctx), 3000);
  } else if (run) {
    const noise = run.summary.find((s) => s.lang.startsWith('RU'))?.meanAbsDelta ?? null;
    body = `
      <div class="parity-cards">
        ${run.summary.map((s) => `
          <div class="kpi panel">
            <div class="kpi-label">${s.lang.startsWith('RU') ? 'Шум: тот же RU-диалог повторно' : `Перевод на ${s.lang === 'KZ' ? 'казахский' : 'английский'}`}</div>
            <div class="kpi-value">${s.meanDelta == null ? '—' : `${s.meanDelta > 0 ? '+' : ''}${fmt(s.meanDelta)}`} <small>средний сдвиг балла</small></div>
            <div class="tiny">|Δ| ${fmt(s.meanAbsDelta)} · совпадение критериев ${fmt(s.agreement)}%</div>
            ${verdict(s, noise)}
          </div>`).join('')}
      </div>
      <details class="tiny"><summary>По диалогам (${run.rows.length})</summary>
        <table class="table impact-table"><thead><tr><th>Диалог</th><th class="num">RU</th>${run.summary.map((s) => `<th class="num">${esc(s.lang)}</th>`).join('')}</tr></thead><tbody>
        ${run.rows.map((r) => r.error ? `<tr><td>${esc(r.conversationId)}</td><td colspan="4" class="bad-text">${esc(r.error)}</td></tr>` : `<tr><td><a href="#/c/${encodeURIComponent(r.conversationId)}">${esc(r.conversationId)}</a></td><td class="num">${fmt(r.ru)}</td>${r.variants.map((v) => `<td class="num" title="${esc(v.diff.join('; ') || 'все критерии совпали')}">${fmt(v.total)} <span class="${v.delta < 0 ? 'bad-text' : v.delta > 0 ? 'good-text' : 'muted'}">(${v.delta > 0 ? '+' : ''}${fmt(v.delta)})</span></td>`).join('')}</tr>`).join('')}
        </tbody></table>
      </details>
      <p class="tiny muted">${esc(run.checklist)} · ${esc(run.model)} · ${fmtUsd(run.costUsd)} · ${new Date(run.createdAt).toLocaleString('ru-RU')}</p>`;
  }
  box.innerHTML = `
    <h3>Языковая честность</h3>
    <p class="tiny muted">Одинаково ли ИИ оценивает один и тот же разговор на разных языках? Русские диалоги переводятся на казахский и английский реплика в реплику — работа оператора не меняется. Повторная оценка русского оригинала показывает шум модели: всё, что выше шума, — предвзятость к языку.</p>
    ${body}
    <div class="row-actions"><button class="btn small" id="parity-run" type="button" ${run?.status === 'running' ? 'disabled' : ''}>${run ? 'Повторить тест' : 'Запустить тест'} (8 диалогов × 3 версии)</button></div>`;
  box.querySelector('#parity-run').addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Запускаю…');
    try {
      await api.startParity({ n: 8 });
      renderParity(ctx);
    } catch (err) {
      toast(err.message, 'error');
      busy(e.currentTarget, false);
    }
  });
}

async function renderLearning(ctx) {
  const box = ctx.view.querySelector('#learning');
  if (!box) return;
  const l = await api.learning();
  const curve = l.curve;
  const W = 300;
  const H = 70;
  const pts = curve.map((p, i) => `${curve.length === 1 ? W / 2 : (i / (curve.length - 1)) * W},${H - (p.agreement / 100) * H}`).join(' ');
  const r = l.lastReplay;
  box.innerHTML = `
    <p class="tiny muted">Каждое решение по апелляции становится прецедентом: агент этого критерия видит его в следующих оценках (кроме оценок того же диалога). ${l.enabled ? '' : '<b>Сейчас выключено (USE_PRECEDENTS=0).</b>'}</p>
    ${curve.length ? `
      <div class="tiny">Согласие ИИ с проверяющим по мере накопления решений: <b>${fmt(curve[curve.length - 1].agreement)}%</b> после ${curve.length} апелляций</div>
      <svg class="curve" viewBox="-4 -4 ${W + 8} ${H + 8}" preserveAspectRatio="none" role="img" aria-label="Кривая согласия ИИ с проверяющим">
        <line x1="0" y1="${H}" x2="${W}" y2="${H}" class="curve-axis"/>
        <polyline points="${pts}" class="curve-line"/>
        ${curve.map((p, i) => `<circle cx="${curve.length === 1 ? W / 2 : (i / (curve.length - 1)) * W}" cy="${H - (p.agreement / 100) * H}" r="3" class="${p.action === 'confirm' ? 'curve-ok' : 'curve-fix'}"><title>#${p.n}: ${p.action === 'confirm' ? 'ИИ прав' : 'исправлено'} · ${p.agreement}%</title></circle>`).join('')}
      </svg>` : '<p class="muted tiny">Апелляций пока нет.</p>'}
    <div class="row-actions" style="margin-top:8px">
      <button class="btn small" id="replay" type="button">Проверить, усвоил ли ИИ исправления</button>
    </div>
    <div id="replay-out">${r ? replayHtml(r) : ''}</div>`;
  box.querySelector('#replay').addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Перепроверяю…');
    try {
      const res = await api.replay();
      box.querySelector('#replay-out').innerHTML = replayHtml(res);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(e.currentTarget, false);
    }
  });
}

const replayHtml = (r) => `
  <div class="replay"><b>ИИ усвоил ${r.learned} из ${r.total} исправлений</b> <span class="tiny muted">${new Date(r.at).toLocaleString('ru-RU')}</span>
  ${r.details.map((d) => `<div class="tiny">${d.learned ? '✓' : '✗'} ${esc(d.conversationId)} · ${esc(d.criterionName)}: было «${esc(d.before)}», проверяющий «${esc(d.reviewer)}», теперь ИИ «${esc(d.now)}»</div>`).join('')}</div>`;

const kpi = (label, value) => `<div class="kpi panel"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div></div>`;
