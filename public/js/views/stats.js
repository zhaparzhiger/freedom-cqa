// Аналитика: слабое место команды, распределение оценок, язык × критерий, проблемные критерии,
// апелляции и обучение на решениях проверяющих, модель и стоимость, тест языковой честности.
import { api } from '../api.js';
import { esc, fmt, fmtUsd, band, icon, LANG, CHANNEL, busy, toast, plural, answerNorm } from '../ui.js';
import { loadConversations, cachedDetail, prefetch, topicOf } from '../data.js';
import { state, painted } from '../shell.js';
import { showFailing } from './list.js';

let loader = null;

export async function renderStats(ctx) {
  const [s, convs] = await Promise.all([api.stats(), loadConversations()]);
  if (!ctx.isCurrent()) return;
  const meta = state.meta || (await api.meta().catch(() => null));
  if (!ctx.isCurrent()) return;
  draw(ctx, s, convs, meta);
  loader?.stop();
  // таблица «язык × критерий» строится из карточек диалогов — догружаем их фоном
  if (convs.some((c) => c.evaluation && !cachedDetail(c))) {
    loader = prefetch(convs.filter((c) => c.evaluation), null);
    loader.done.then(() => {
      if (!ctx.isCurrent()) return;
      const box = ctx.view.querySelector('#heat');
      if (box) box.outerHTML = heatHtml(s, convs);
      const low = ctx.view.querySelector('#lowest');
      if (low) low.innerHTML = lowestHtml(convs);
    });
  }
  renderLearning(ctx).catch((e) => setErr(ctx, '#learning', e));
  renderParity(ctx).catch((e) => setErr(ctx, '#parity', e));
}

const setErr = (ctx, sel, e) => {
  const box = ctx.view.querySelector(sel);
  if (box) box.querySelector('.sheet-b').innerHTML = `<p class="muted">Не удалось загрузить: ${esc(e.message)}</p>`;
};

function draw(ctx, s, convs, meta) {
  const crit = s.criteria.filter((c) => c.evaluated && c.type !== 'flag');
  const failRate = (c) => (c.ok + c.notOk ? c.notOk / (c.ok + c.notOk) : 0);
  const weak = [...crit].sort((a, b) => failRate(b) - failRate(a))[0];
  const resolved = s.appeals.confirmed + s.appeals.changed;
  const agreement = resolved ? (s.appeals.confirmed / resolved) * 100 : null;
  const doneShare = weak ? Math.round((1 - failRate(weak)) * 100) : null;

  ctx.view.innerHTML = `<div class="page-anim">
    <section class="lane team" data-field="lane">
      <div class="lane-l">
        ${weak ? `<span class="cap lane-cap">Слабое место команды</span><h1>${esc(weak.name)}</h1>
        <p>Выполнено в <b class="roll" data-roll="${doneShare}" data-key="weak">${doneShare}</b>% диалогов (${weak.ok} из ${weak.ok + weak.notOk}, N/A не считаются). Разберите эти диалоги или отправьте операторам тренировку из карточки.</p>
        <a class="btn lime" href="#/" data-fail="${esc(weak.id)}">${icon('eye')}Показать диалоги с ошибкой</a>` : '<h1>Аналитика</h1><p>Оцените диалоги — здесь появятся слабые места.</p>'}
      </div>
      <div class="lane-r"><span class="cap">Ниже всех по итогу</span><div class="att" id="lowest">${lowestHtml(convs)}</div></div>
    </section>

    <div class="insights kpis">
      ${kpi('Оценено диалогов', `${s.evaluated}<small> из ${s.conversations}</small>`, 'по последней оценке каждого диалога, с учётом апелляций')}
      ${kpi('Средний балл', s.averageTotal == null ? '—' : `<span class="c-${band(s.averageTotal)}">${fmt(s.averageTotal)}</span>`, 'из 100, после решений проверяющих')}
      ${kpi('Грубые ошибки', `<span class="${s.grossErrors ? 'c-low' : ''}">${s.grossErrors}</span>`, `${plural(s.grossErrors, 'диалог', 'диалога', 'диалогов')} с флагом — отмечается отдельно от итога`)}
      ${kpi('Требует проверки человеком', `${s.needsReview}<small> ${plural(s.needsReview, 'критерий', 'критерия', 'критериев')}</small>`, 'доказательство не прошло проверку или ИИ не уверен')}
      ${kpi('Согласие ИИ с проверяющим', agreement == null ? '—' : `${fmt(agreement, 0)}%`, resolved ? `из ${resolved} ${plural(resolved, 'рассмотренной апелляции', 'рассмотренных апелляций', 'рассмотренных апелляций')}` : 'апелляций пока не рассматривали')}
      ${kpi('Стоимость одной оценки', fmtUsd(s.cost.perEvaluationUsd), `${s.cost.avgSeconds ?? '—'} с в среднем · всего ${fmtUsd(s.cost.totalUsd)} за ${s.cost.evaluations} ${plural(s.cost.evaluations, 'оценку', 'оценки', 'оценок')}`)}
    </div>

    ${spread(convs)}
    ${heatHtml(s, convs)}

    <div class="two">
      <section class="sheet">
        <div class="sheet-h"><div><h2>Проблемные критерии</h2><p>Доля диалогов, где критерий не выполнен (для шкал — ниже максимума). N/A не учитывается.</p></div></div>
        <div class="sheet-b hbars">${s.criteria.filter((c) => c.evaluated).map((c) => {
          const scored = c.ok + c.notOk;
          const pct = scored ? (c.notOk / scored) * 100 : 0;
          const cls = c.type === 'flag' ? (c.notOk ? 'low' : 'ok') : pct > 40 ? 'low' : pct > 20 ? 'mid' : 'ok';
          return `<button type="button" class="hbar" data-fail="${esc(c.id)}" title="Показать диалоги, где критерий не выполнен"><span class="hbar-l">${esc(c.name)}</span><i><em class="${cls}" style="width:${c.type === 'flag' ? (scored ? (c.notOk / scored) * 100 : 0) : pct}%"></em></i><b>${c.type === 'flag' ? `${c.notOk} выявл.` : `${fmt(pct, 0)}%`}${c.na ? `<small> · N/A ${c.na}</small>` : ''}</b></button>`;
        }).join('') || '<p class="muted">Нет оценённых диалогов.</p>'}</div>
      </section>
      <section class="sheet">
        <div class="sheet-h"><div><h2>Средний балл по языкам</h2><p>Тот же чек-лист для RU, KZ и EN.</p></div></div>
        <div class="sheet-b hbars">${Object.entries(s.byLanguage).map(([lang, v]) => `<div class="hbar"><span class="hbar-l">${esc(LANG[lang] || lang)} <small>${v.count}</small></span><i><em class="${band(v.average)}" style="width:${v.average ?? 0}%"></em></i><b>${fmt(v.average)}</b></div>`).join('') || '<p class="muted">Нет данных.</p>'}</div>
        <div class="sheet-h sub"><div><h2>Апелляции</h2></div></div>
        <div class="sheet-b"><div class="facts"><span>Всего <b>${s.appeals.total}</b></span><span>Открыто <b>${s.appeals.open}</b></span><span>Подтверждено <b>${s.appeals.confirmed}</b></span><span>Изменено <b>${s.appeals.changed}</b></span></div></div>
        <div class="sheet-h sub"><div><h2>Модель</h2></div></div>
        <div class="sheet-b"><p class="small">${meta ? `${esc(meta.model)} · ${esc(meta.backend)} · цена ${meta.priceInputPerM}$ / ${meta.priceOutputPerM}$ за 1 млн токенов (вход / выход) · режим по умолчанию: ${meta.mode === 'agents' ? 'мультиагентный конвейер' : 'один вызов'}` : 'Нет данных о модели'}.<br>Всего оценок: ${s.cost.evaluations}, потрачено ${fmtUsd(s.cost.totalUsd)}.</p></div>
      </section>
    </div>

    <section class="sheet" id="learning"><div class="sheet-h"><div><h2>Обучение на решениях проверяющих</h2><p>Каждое решение по апелляции становится прецедентом для агента этого критерия (кроме оценок того же диалога).</p></div></div><div class="sheet-b"><p class="muted"><span class="spinner"></span> Загружаю…</p></div></section>
    <section class="sheet" id="parity"><div class="sheet-h"><div><h2>Языковая честность</h2><p>Одинаково ли ИИ оценивает один и тот же разговор на разных языках?</p></div></div><div class="sheet-b"><p class="muted"><span class="spinner"></span> Загружаю…</p></div></section>
  </div>`;
  ctx.view.querySelectorAll('[data-fail]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showFailing(el.dataset.fail);
      location.hash = '#/';
    }),
  );
  painted(ctx.view, 'stats');
}

function lowestHtml(convs) {
  const lowest = convs.filter((c) => c.evaluation?.total != null).sort((a, b) => a.evaluation.total - b.evaluation.total).slice(0, 4);
  return (
    lowest
      .map((c) => {
        const d = cachedDetail(c);
        return `<a class="att-i" href="#/c/${encodeURIComponent(c.conversation_id)}"><b class="${c.evaluation.grossError ? 'c' : 'a'}">${fmt(c.evaluation.total, 1)}</b><span>${esc(d ? topicOf(d.conversation, d.current) : c.conversation_id)}<small>${esc(c.conversation_id)} · ${CHANNEL[c.channel] || ''} · ${esc(c.language)}${c.evaluation.grossError ? ' · грубая ошибка' : ''}</small></span>${icon('right')}</a>`;
      })
      .join('') || '<p class="att-none">Нет оценённых диалогов.</p>'
  );
}

const kpi = (label, value, note) => `<div class="sheet kpi"><span class="cap">${label}</span><b>${value}</b><p>${note}</p></div>`;

/* ── распределение оценок: столбик — 5 баллов, сегмент — один диалог ── */
function spread(convs) {
  const rs = convs.filter((c) => c.evaluation?.total != null);
  if (!rs.length) return '';
  const vs = rs.map((r) => r.evaluation.total).sort((x, y) => x - y);
  const med = vs.length % 2 ? vs[(vs.length - 1) / 2] : (vs[vs.length / 2 - 1] + vs[vs.length / 2]) / 2;
  const avg = vs.reduce((x, y) => x + y, 0) / vs.length;
  const STEP = 5;
  const lo = Math.min(60, Math.floor(vs[0] / 10) * 10);
  const nb = (100 - lo) / STEP;
  const bins = Array.from({ length: nb }, (_, i) => ({ a: lo + i * STEP, items: [] }));
  rs.forEach((r) => bins[Math.min(nb - 1, Math.max(0, Math.floor((r.evaluation.total - lo) / STEP)))].items.push(r));
  bins.forEach((x) => x.items.sort((p, q) => p.evaluation.total - q.evaluation.total));
  const zone = band;
  const pct = (v) => ((v - lo) / (100 - lo)) * 100;
  const pos = (v) => `${pct(v).toFixed(3)}%`;
  const maxN = Math.max(1, ...bins.map((x) => x.items.length));
  const cols = bins
    .map((bin, i) => {
      const side = i < nb * 0.4 ? ' at-l' : i >= nb * 0.6 ? ' at-r' : '';
      const segs = bin.items
        .map((r, n) => {
          const v = r.evaluation.total;
          const bad = r.evaluation.grossError;
          const d = cachedDetail(r);
          const topic = d ? topicOf(d.conversation, d.current) : r.conversation_id;
          return `<a class="d-t ${zone(v)}${bad ? ' crit' : ''}${side}" href="#/c/${encodeURIComponent(r.conversation_id)}" style="--n:${n}" aria-label="${esc(`${fmt(v)} — ${r.conversation_id}${bad ? ', грубая ошибка' : ''}`)}"><span class="d-tip" aria-hidden="true"><b class="c-${zone(v)}">${fmt(v, 1)}</b><span>${esc(topic)}<small>${esc(r.conversation_id)} · ${CHANNEL[r.channel] === 'Звонок' ? 'звонок' : 'чат'} · ${esc(r.language)}</small></span>${bad ? `<em>${icon('alert')}Грубая ошибка</em>` : ''}</span></a>`;
        })
        .join('');
      return `<div class="d-bin" style="--i:${i}">${segs}${bin.items.length ? `<span class="d-n">${bin.items.length}</span>` : ''}</div>`;
    })
    .join('');
  const zs = [['low', lo, 60, 'Требует разбора', 'ниже 60'], ['mid', 60, 80, 'Средний', '60–80'], ['ok', 80, 100, 'Хороший и сильный', '80 и выше']].filter((z) => z[2] > lo);
  const bandHtml = zs.map((z) => `<i class="${z[0]}" style="left:${pos(Math.max(lo, z[1]))};width:${(pct(z[2]) - pct(Math.max(lo, z[1]))).toFixed(3)}%"></i>`).join('');
  const zones = zs.map((z) => `<div class="${z[0]}" style="left:${pos(Math.max(lo, z[1]))};width:${(pct(z[2]) - pct(Math.max(lo, z[1]))).toFixed(3)}%"><b>${rs.filter((r) => zone(r.evaluation.total) === z[0]).length}</b><span>${z[3]}<small>${z[4]}</small></span></div>`).join('');
  const ticks = [];
  for (let t = lo; t <= 100; t += STEP) ticks.push(`<span class="${t % 10 ? 'minor' : ''}" style="left:${pos(t)}">${t % 10 ? '' : t}</span>`);
  const crit = rs.filter((r) => r.evaluation.grossError).length;
  return `<section class="sheet dist"><div class="sheet-h"><div><h2>Как распределились оценки</h2><p>Столбик — оценки в пределах 5 баллов, каждый сегмент — один диалог</p></div>
    <div class="d-sum"><span><b>${rs.length}</b>оценено</span><span><b>${fmt(med, 1)}</b>медиана</span><span><b>${fmt(avg, 1)}</b>среднее</span><span><b>${crit}</b>с грубой ошибкой</span></div></div>
    <div class="d-body"><div class="d-plot" style="--nb:${nb};--rows:${maxN};--sh:${Math.max(4, Math.min(16, Math.floor(300 / maxN) - 3))}px"><i class="d-div" style="left:${pos(60)}"></i><i class="d-div" style="left:${pos(80)}"></i>
      <div class="d-med${pct(med) > 62 ? ' flip' : ''}" style="left:${pos(med)}"><span>медиана ${fmt(med, 1)}</span></div><div class="d-bins">${cols}</div></div>
      <div class="d-band">${bandHtml}</div><div class="d-ax">${ticks.join('')}</div><div class="d-zones">${zones}</div>
      ${crit ? '<p class="d-note"><i></i>Сегмент в красной рамке — диалог с грубой ошибкой. Наведите на сегмент, чтобы увидеть диалог, нажмите, чтобы открыть.</p>' : ''}</div></section>`;
}

/* ── язык × критерий: доля выполнения по финальным ответам ── */
const heatCol = (v) => (v == null ? 'background:var(--na-soft);color:var(--na)' : v < 0.5 ? 'background:var(--red-soft);color:var(--red-ink)' : v < 0.75 ? 'background:var(--amber-soft);color:#6E4300' : v < 0.95 ? 'background:#DCEFDD;color:#155E27' : 'background:var(--green-ink);color:#fff');
function heatHtml(s, convs) {
  const evaluated = convs.filter((c) => c.evaluation);
  const details = evaluated.map((c) => cachedDetail(c)).filter(Boolean);
  const head = `<div class="sheet-h"><div><h2>Язык × критерий</h2><p>Доля выполнения критерия, %. Для флага — доля диалогов без грубой ошибки. N/A не учитывается.</p></div></div>`;
  if (details.length < evaluated.length) return `<section class="sheet heat" id="heat">${head}<div class="sheet-b"><p class="muted"><span class="spinner"></span> Собираю ответы по критериям: ${details.length} из ${evaluated.length}…</p></div></section>`;
  const criteria = s.criteria;
  const langs = [...new Set(details.map((d) => d.conversation.language || '—'))].sort();
  const cell = (list, cid) => {
    const vals = list
      .map((d) => {
        const c = d.current?.checklist.criteria.find((x) => x.id === cid);
        return c ? answerNorm(c, d.current.result.finalAnswers[cid]) : null;
      })
      .filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const rows = [['Все языки', details], ...langs.map((l) => [LANG[l] || l, details.filter((d) => (d.conversation.language || '—') === l), l])];
  const short = (n) => (n.length > 16 ? `${n.slice(0, 15).replace(/\s+\S*$/, '')}…` : n);
  return `<section class="sheet heat" id="heat">${head}<table><thead><tr><th>Язык</th>${criteria.map((c) => `<th title="${esc(c.name)}">${esc(short(c.name))}</th>`).join('')}<th>Средний балл</th></tr></thead><tbody>
    ${rows.map(([name, list, code], ri) => {
      const avg = code ? s.byLanguage[code]?.average : s.averageTotal;
      return `<tr><td class="op">${esc(name)} <small class="muted">${list.length}</small></td>${criteria.map((c, ci) => {
        const v = cell(list, c.id);
        return `<td><span class="c" style="--d:${ri + ci};${heatCol(v)}" title="${esc(c.name)}">${v == null ? 'N/A' : Math.round(v * 100)}</span></td>`;
      }).join('')}<td><b class="c-${band(avg)}">${fmt(avg, 1)}</b></td></tr>`;
    }).join('')}
  </tbody></table></section>`;
}

// ── обучение на решениях проверяющих ─────────────────────────────────
async function renderLearning(ctx) {
  const l = await api.learning();
  const box = ctx.view.querySelector('#learning .sheet-b');
  if (!box || !ctx.isCurrent()) return;
  const curve = l.curve;
  const W = 300;
  const H = 70;
  const xAt = (i) => (curve.length === 1 ? W / 2 : (i / (curve.length - 1)) * W);
  const pts = curve.map((p, i) => `${xAt(i)},${H - (p.agreement / 100) * H}`).join(' ');
  const r = l.lastReplay;
  box.innerHTML = `
    ${l.enabled ? '' : '<p class="note-box mid">Сейчас выключено (USE_PRECEDENTS=0).</p>'}
    ${curve.length ? `<p>Согласие ИИ с проверяющим по мере накопления решений: <b>${fmt(curve[curve.length - 1].agreement)}%</b> после ${curve.length} ${plural(curve.length, 'апелляции', 'апелляций', 'апелляций')}</p>
      <svg class="curve" viewBox="-4 -4 ${W + 8} ${H + 8}" preserveAspectRatio="none" role="img" aria-label="Кривая согласия ИИ с проверяющим">
        <line x1="0" y1="${H}" x2="${W}" y2="${H}" class="curve-axis"/><polyline points="${pts}" class="curve-line"/>
        ${curve.map((p, i) => `<circle cx="${xAt(i)}" cy="${H - (p.agreement / 100) * H}" r="3" class="${p.action === 'confirm' ? 'curve-ok' : 'curve-fix'}"><title>#${p.n}: ${p.action === 'confirm' ? 'ИИ прав' : 'исправлено'} · ${p.agreement}%</title></circle>`).join('')}
      </svg>
      <div class="legend"><span><i style="background:var(--green)"></i>ИИ прав (подтверждено)</span><span><i style="background:var(--amber-bar)"></i>исправлено проверяющим</span></div>` : '<p class="muted">Апелляций пока не рассматривали.</p>'}
    <div class="acts"><button class="btn sm" id="replay" type="button" title="Заново оценить исправленные критерии с прецедентами — вызывает модель">${icon('refresh')}Проверить, усвоил ли ИИ исправления</button></div>
    <div id="replay-out">${r ? replayHtml(r) : ''}</div>`;
  box.querySelector('#replay').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Перепроверяю…');
    try {
      const res = await api.replay();
      box.querySelector('#replay-out').innerHTML = replayHtml(res);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });
}
const replayHtml = (r) => `<div class="replay"><b>ИИ усвоил ${r.learned} из ${r.total} исправлений</b> <span class="muted small">${new Date(r.at).toLocaleString('ru-RU')}</span>
  ${r.details.map((d) => `<div class="small">${d.learned ? '✓' : '✗'} ${esc(d.conversationId)} · ${esc(d.criterionName)}: было «${esc(d.before)}», проверяющий «${esc(d.reviewer)}», теперь ИИ «${esc(d.now)}»</div>`).join('')}</div>`;

// ── тест языковой честности ─────────────────────────────────────────
async function renderParity(ctx) {
  const st = await api.parity();
  const box = ctx.view.querySelector('#parity .sheet-b');
  if (!box || !ctx.isCurrent()) return;
  const run = st.running || st.runs[0];
  // два вида перекоса: систематический сдвиг и разброс выше шума модели
  const verdictTags = (s, noiseAbs) => {
    if (s.lang.startsWith('RU') || s.meanDelta == null || noiseAbs == null) return '';
    const tags = [];
    if (Math.abs(s.meanDelta) > noiseAbs + 1.5) tags.push(`<span class="tag bad">в среднем ${s.meanDelta > 0 ? 'мягче' : 'строже'} на ${fmt(Math.abs(s.meanDelta))}</span>`);
    if (s.meanAbsDelta > Math.max(2 * noiseAbs, noiseAbs + 2)) tags.push(`<span class="tag bad">разброс в ${fmt(s.meanAbsDelta / Math.max(noiseAbs, 0.1), 1)} раза выше шума</span>`);
    return tags.join(' ') || '<span class="tag ok">в пределах шума модели</span>';
  };
  let body = '';
  if (run?.status === 'running') {
    body = `<p><span class="spinner"></span> Идёт тест: ${run.done} из ${run.total} диалогов · ${fmtUsd(run.costUsd)}</p>`;
    setTimeout(() => ctx.isCurrent() && renderParity(ctx).catch(() => {}), 3000);
  } else if (run) {
    const noise = run.summary.find((x) => x.lang.startsWith('RU'))?.meanAbsDelta ?? null;
    body = `<div class="parity-cards">${run.summary.map((x) => `<div class="pc"><span class="cap">${x.lang.startsWith('RU') ? 'Шум: тот же RU-диалог повторно' : `Перевод на ${x.lang === 'KZ' ? 'казахский' : 'английский'}`}</span><b>${x.meanDelta == null ? '—' : `${x.meanDelta > 0 ? '+' : ''}${fmt(x.meanDelta)}`}<small> средний сдвиг</small></b><p>|Δ| ${fmt(x.meanAbsDelta)} · совпадение критериев ${fmt(x.agreement)}%</p>${verdictTags(x, noise)}</div>`).join('')}</div>
      <details class="more"><summary>По диалогам (${run.rows.length})<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Диалог</th><th class="num">RU</th>${run.summary.map((x) => `<th class="num">${esc(x.lang)}</th>`).join('')}</tr></thead><tbody>
        ${run.rows.map((r) => (r.error ? `<tr><td>${esc(r.conversationId)}</td><td colspan="4" class="c-low">${esc(r.error)}</td></tr>` : `<tr><td><a href="#/c/${encodeURIComponent(r.conversationId)}">${esc(r.conversationId)}</a></td><td class="num">${fmt(r.ru)}</td>${r.variants.map((v) => `<td class="num" title="${esc(v.diff.join('; ') || 'все критерии совпали')}">${fmt(v.total)} <span class="${v.delta < 0 ? 'c-low' : v.delta > 0 ? 'c-ok' : 'muted'}">(${v.delta > 0 ? '+' : ''}${fmt(v.delta)})</span></td>`).join('')}</tr>`)).join('')}
        </tbody></table></div></details>
      <p class="muted small">${esc(run.checklist)} · ${esc(run.model)} · ${fmtUsd(run.costUsd)} · ${new Date(run.createdAt).toLocaleString('ru-RU')}</p>`;
  }
  box.innerHTML = `<p class="small">Русские диалоги переводятся на казахский и английский реплика в реплику — работа оператора не меняется. Повторная оценка русского оригинала показывает шум модели: всё, что выше шума, — предвзятость к языку.</p>
    ${body}
    <div class="acts"><button class="btn sm" id="parity-run" type="button" ${run?.status === 'running' ? 'disabled' : ''} title="Вызывает модель: перевод и оценка">${icon('globe')}${run ? 'Повторить тест' : 'Запустить тест'} (8 диалогов × 3 версии)</button></div>`;
  box.querySelector('#parity-run').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Запускаю…');
    try {
      await api.startParity({ n: 8 });
      renderParity(ctx);
    } catch (err) {
      toast(err.message, 'error');
      busy(btn, false);
    }
  });
}
