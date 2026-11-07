// Визуальные компоненты макета на реальных данных: отпечаток диалога, шкала итога, водопад баллов,
// «табло» итога, бегунки сегментов и меню, сигнальные поля из точек.
import { esc, fmt, answerLabel, hash } from './ui.js';
import { durationOf } from './data.js';

export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── отпечаток: реплики оператора — над осью, клиента — под осью, бот и система — точки;
      метки критериев стоят на реплике, которой критерий подтверждён или проверен ── */
export function fingerprint(msgs, model, { W = 300, H = 64 } = {}) {
  const n = msgs.length;
  const mid = H / 2;
  const dur = durationOf(msgs);
  const xAt = (i) => 10 + ((msgs[i]?.offsetSec ?? 0) / dur) * (W - 20);
  const bw = Math.max(3, Math.min(16, ((W - 20) / Math.max(1, n)) * 0.62));
  let bars = '';
  msgs.forEach((x, i) => {
    const len = Math.min(1, (x.text || '').length / 110);
    const h = 7 + len * 22;
    const cx = xAt(i);
    const k = Math.min(i, 24);
    if (x.speaker === 'operator') bars += `<rect class="fp-op" style="--k:${k}" x="${(cx - bw / 2).toFixed(1)}" y="${(mid - 2 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 2).toFixed(1)}"/>`;
    else if (x.speaker === 'client') bars += `<rect class="fp-cl" style="--k:${k}" x="${(cx - bw / 2).toFixed(1)}" y="${(mid + 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 2).toFixed(1)}"/>`;
    else bars += `<circle class="fp-ctx" style="--k:${k}" cx="${cx.toFixed(1)}" cy="${mid}" r="1.8"/>`;
  });
  let pips = '';
  if (model)
    for (const r of model.rows) {
      if (r.pip == null || r.state === 'na' || r.pip >= n) continue;
      pips += `<circle class="fp-pip ${r.state}" cx="${xAt(r.pip).toFixed(1)}" cy="${mid}" r="${r.state === 'v' ? 4 : 5.5}"><title>${esc(`${r.code} · ${r.c.name} · ${answerLabel(r.c, r.finalAnswer)}`)}</title></circle>`;
    }
  return `<svg class="fp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Ход разговора: ${n} реплик"><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="fp-axis"/>${bars}${pips}</svg>`;
}

/** Лента над транскриптом: отпечаток + кликабельные метки критериев. */
export function timeline(msgs, model) {
  const dur = durationOf(msgs);
  const at = (i) => (10 + ((msgs[i]?.offsetSec ?? 0) / dur) * 280) / 3;
  const pips = model.rows
    .filter((r) => r.state !== 'na' && r.pip != null && r.pip < msgs.length)
    .map((r) => {
      const label = `${r.code} · ${r.c.name} · ${answerLabel(r.c, r.finalAnswer)}`;
      return `<button type="button" class="tl-pip ${r.state}" data-act="open" data-crit="${esc(r.c.id)}" data-keep="1" style="left:${at(r.pip).toFixed(2)}%" aria-label="${esc(label)} — открыть критерий" title="${esc(label)}"></button>`;
    })
    .join('');
  return `<div class="tl"><div class="tl-h"><span>Ход разговора</span><span class="tl-k"><i class="v"></i>выполнено<i class="x"></i>потеря<i class="c"></i>грубая</span></div><div class="tl-fp">${fingerprint(msgs, null)}${pips}</div></div>`;
}

/** Шкала итога: красная зона до 60, янтарная до 80, зелёная выше; лаймовая метка на итоге. */
export const scaleBar = (v) =>
  `<div class="scale" style="--v:${Math.max(0, Math.min(100, v ?? 0))}" aria-hidden="true"><div class="sc-z"><i></i><i></i><i></i></div><b></b><span style="left:0">0</span><span style="left:60%">60</span><span style="left:80%">80</span><span style="left:100%">100</span></div>`;

/* ── водопад: столбик на каждый критерий с весом, от 0 до итога ── */
const built = new Set();
export function drawWaterfall(box, model, openId) {
  if (!box || !model) return false;
  const rows = model.rows.filter((r) => r.c.type !== 'flag');
  const tot = model.final.total;
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (!W || !H) return false;
  const pl = 28, pr = 4, pt = 22, pb = 28;
  const cw = W - pl - pr, ch = H - pt - pb;
  const n = rows.length + 1;
  const slot = cw / n;
  const bw = Math.min(40, slot * 0.58);
  const tight = slot < 44;
  const y = (v) => pt + ch - (v / 100) * ch;
  const x = (i) => pl + slot * i + (slot - bw) / 2;
  const sumAll = rows.reduce((a, r) => a + (Number(r.c.weight) || 0), 0) || 1;
  const g = `<g class="grid">${[0, 50, 100].map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}</g>`;
  let cum = 0;
  let bars = '';
  rows.forEach((r, i) => {
    const on = openId === r.c.id ? ' on' : '';
    const dl = `style="--d:${i * 70}ms"`;
    const hit = `<rect class="hit" x="${pl + slot * i}" y="${pt}" width="${slot}" height="${ch + pb}" rx="6"/>`;
    const lab = `<text class="code" x="${x(i) + bw / 2}" y="${H - 8}">${r.code}</text>`;
    if (r.finalAnswer == null) {
      bars += `<g class="bar${on}" ${dl} data-act="open" data-crit="${esc(r.c.id)}"><title>${esc(`${r.c.name}: не оценён`)}</title>${hit}${lab}</g>`;
      return;
    }
    if (r.finalAnswer === 'na' || !r.score?.effectiveWeight) {
      const hg = ((Number(r.c.weight) || 0) / sumAll) * 100;
      bars += `<g class="bar${on}" ${dl} data-act="open" data-crit="${esc(r.c.id)}"><title>${esc(`${r.c.name}: не применимо, вес ${r.c.weight} распределён между остальными`)}</title>${hit}<rect class="na" x="${x(i)}" y="${y(cum + hg)}" width="${bw}" height="${Math.max(0, y(cum) - y(cum + hg))}" rx="4"/><text x="${x(i) + bw / 2}" y="${y(cum + hg) - 6}">N/A</text>${lab}</g>`;
      return;
    }
    const pts = r.score.effectivePoints;
    const eff = r.score.effectiveWeight;
    const top = cum + pts;
    const lost = eff - pts;
    const gh = y(top) - y(top + lost);
    const lossLab = lost > 0.05 ? `<text class="loss" x="${x(i) + bw / 2}" y="${tight || gh <= 18 ? y(top + lost) - (tight ? 6 : 20) : y(top + lost) + gh / 2 + 4}">−${fmt(lost, 1)}</text>` : '';
    const gainLab = tight && lost > 0.05 ? '' : `<text x="${x(i) + bw / 2}" y="${y(top + Math.max(lost, 0)) - 6}">${pts > 0.05 ? `+${fmt(pts, 1)}` : '0'}</text>`;
    bars += `<g class="bar${on}" ${dl} data-act="open" data-crit="${esc(r.c.id)}"><title>${esc(`${r.c.name}: ${fmt(pts)} из ${fmt(eff)}`)}</title>${hit}${lost > 0.05 ? `<rect class="lost" x="${x(i)}" y="${y(top + lost)}" width="${bw}" height="${gh}" rx="4"/>` : ''}${pts > 0.05 ? `<rect class="${r.state}" x="${x(i)}" y="${y(top)}" width="${bw}" height="${Math.max(2, y(cum) - y(top))}" rx="4"/>` : `<rect class="c" x="${x(i)}" y="${y(cum) - 2}" width="${bw}" height="3" rx="1.5"/>`}${gainLab}${lossLab}${lab}</g>`;
    if (i < rows.length - 1) bars += `<line class="link" style="--d:${i * 70 + 200}ms" x1="${x(i) + bw}" x2="${x(i + 1)}" y1="${y(top)}" y2="${y(top)}"/>`;
    cum = top;
  });
  const ti = rows.length;
  if (tot != null) bars += `<g class="totalbar" style="--d:${ti * 70 + 100}ms"><rect x="${x(ti)}" y="${y(tot)}" width="${bw}" height="${y(0) - y(tot)}" rx="4"/>${tight ? '' : `<text x="${x(ti) + bw / 2}" y="${y(tot) - 6}">${fmt(tot, 1)}</text>`}<text x="${x(ti) + bw / 2}" y="${H - 8}" style="font-weight:600">Итог</text></g>`;
  const key = `${model.ev.id}:${tot}`;
  const build = !built.has(key) && !reduced();
  built.add(key);
  box.innerHTML = `<svg class="${tight ? 'tight ' : ''}${build ? 'build' : ''}" width="${W}" height="${H}" role="img" aria-label="Вклад каждого критерия в итоговый балл">${g}${bars}</svg>`;
  return build;
}

/* ── «табло»: цифры итога прокручиваются до значения ── */
const seen = {};
const DIG = '0123456789'.split('').map((x) => `<span>${x}</span>`).join('');
export function roll(el, delay = 0) {
  const to = el.dataset.roll;
  const key = el.dataset.key;
  const from = key in seen ? seen[key] : to.replace(/\d/g, '0');
  seen[key] = to;
  if (from === to || reduced()) return;
  const f = from.padStart(to.length, '0').slice(-to.length);
  el.setAttribute('aria-label', to);
  el.innerHTML = to
    .split('')
    .map((ch, i) => (/\d/.test(ch) ? `<span class="dg" aria-hidden="true"><span class="col" style="transform:translateY(${-(/\d/.test(f[i]) ? +f[i] : 0) * 10}%)">${DIG}</span></span>` : `<span class="sep" aria-hidden="true">${esc(ch)}</span>`))
    .join('');
  el.classList.add('rolling');
  void el.offsetWidth;
  const cols = Array.from(el.querySelectorAll('.col'));
  let k = 0;
  to.split('').forEach((ch) => {
    if (!/\d/.test(ch)) return;
    const c = cols[k];
    c.style.transitionDelay = `${delay + (cols.length - 1 - k) * 60}ms`;
    c.style.transform = `translateY(${-+ch * 10}%)`;
    k++;
  });
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.textContent = to;
    el.classList.remove('rolling');
    el.classList.add('landed');
    setTimeout(() => el.classList.remove('landed'), 700);
  }, delay + 1200 + cols.length * 60);
}
export const seedRoll = (key, value) => (seen[key] = value);
export function rollAll(root, delayFor = () => 0) {
  root.querySelectorAll('.roll[data-roll]').forEach((el) => {
    if (el.closest('li.later')) return;
    roll(el, delayFor(el));
  });
}

/* ── бегунок в сегментных переключателях и подсветка пункта меню ── */
const segPos = {};
export function placeSegs(root = document) {
  root.querySelectorAll('.seg').forEach((seg, n) => {
    const key = (seg.getAttribute('aria-label') || '') + n;
    const btn = seg.querySelector('button[aria-pressed="true"]');
    let ind = seg.querySelector('.seg-ind');
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'seg-ind';
      ind.setAttribute('aria-hidden', 'true');
      seg.prepend(ind);
      seg.classList.add('has-ind');
    }
    if (!btn) {
      ind.style.opacity = '0';
      return;
    }
    ind.style.opacity = '';
    const x = btn.offsetLeft;
    const w = btn.offsetWidth;
    const p = segPos[key];
    if (p && !reduced() && (p.x !== x || p.w !== w)) {
      ind.style.transition = 'none';
      ind.style.transform = `translateX(${p.x}px)`;
      ind.style.width = `${p.w}px`;
      void ind.offsetWidth;
      ind.style.transition = '';
    }
    ind.style.transform = `translateX(${x}px)`;
    ind.style.width = `${w}px`;
    segPos[key] = { x, w };
  });
}
let indPos = null;
export function placeInd() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const a = nav.querySelector('a[aria-current="page"]');
  let ind = nav.querySelector('.ind');
  if (!ind) {
    ind = document.createElement('span');
    ind.className = 'ind';
    ind.setAttribute('aria-hidden', 'true');
    nav.prepend(ind);
  }
  if (!a) {
    ind.style.opacity = '0';
    return;
  }
  ind.style.opacity = '';
  const x = a.offsetLeft;
  const w = a.offsetWidth;
  if (indPos && !reduced()) {
    ind.style.transition = 'none';
    ind.style.transform = `translateX(${indPos.x}px)`;
    ind.style.width = `${indPos.w}px`;
    void ind.offsetWidth;
    ind.style.transition = '';
  }
  ind.style.transform = `translateX(${x}px)`;
  ind.style.width = `${w}px`;
  indPos = { x, w };
}

/* ── сигнальные поля: точечные матрицы в лесных панелях (декор, без данных).
      lane — спектр голоса снизу слева; nav — полоска в шапке; ripple — кольца от итога; burst — вспышка после решения ── */
const FIELDS = new Set();
let fieldRaf = 0;
let fieldLast = 0;
const GRID = { nav: 8, ripple: 13, burst: 12 };
const refit = (fl) => {
  sizeField(fl);
  drawField(fl, reduced() ? 0 : performance.now());
};
export function kickNav() {
  FIELDS.forEach((fl) => fl.mode === 'nav' && (fl.kick = performance.now()));
}
export function mountFields() {
  FIELDS.forEach((fl) => {
    if (!document.contains(fl.el)) FIELDS.delete(fl);
    else if (fl.mode === 'nav') refit(fl);
  });
  document.querySelectorAll('[data-field]').forEach((el) => {
    if (el._field) return;
    const cv = document.createElement('canvas');
    cv.className = 'field';
    cv.setAttribute('aria-hidden', 'true');
    el.prepend(cv);
    const now = performance.now();
    const fl = { el, cv, mode: el.dataset.field, seed: (hash(location.hash + el.dataset.field) % 628) / 100, mx: -1e3, my: -1e3, t0: now, kick: now };
    el._field = fl;
    FIELDS.add(fl);
    el.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      fl.mx = e.clientX - r.left;
      fl.my = e.clientY - r.top;
      if (reduced()) drawField(fl, 0);
    });
    el.addEventListener('pointerleave', () => {
      fl.mx = fl.my = -1e3;
      if (reduced()) drawField(fl, 0);
    });
    sizeField(fl);
    drawField(fl, reduced() ? 0 : performance.now());
  });
  if (!fieldRaf && FIELDS.size && !reduced()) fieldRaf = requestAnimationFrame(tickFields);
}
function tickFields(t) {
  fieldRaf = 0;
  if (!FIELDS.size) return;
  if (t - fieldLast > 40) {
    fieldLast = t;
    FIELDS.forEach((fl) => {
      if (!document.contains(fl.el)) {
        FIELDS.delete(fl);
        return;
      }
      const r = fl.el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) drawField(fl, t);
    });
  }
  if (FIELDS.size) fieldRaf = requestAnimationFrame(tickFields);
}
function sizeField(fl) {
  const r = fl.el.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  fl.w = r.width;
  fl.h = r.height;
  fl.dpr = dpr;
  fl.cv.width = Math.round(r.width * dpr);
  fl.cv.height = Math.round(r.height * dpr);
  if (fl.mode === 'nav') {
    const n = document.getElementById('nav').getBoundingClientRect();
    const e = fl.el.querySelector('.top-end').getBoundingClientRect();
    fl.a = n.right - r.left + 20;
    fl.b = e.left - r.left - 20;
    if (Math.abs(n.top - e.top) > 20) fl.b = fl.a;
  }
  const o = fl.el.dataset.origin && fl.el.querySelector(fl.el.dataset.origin);
  if (o) {
    const q = o.getBoundingClientRect();
    fl.ox = q.left + q.width / 2 - r.left;
    fl.oy = q.top + q.height / 2 - r.top;
    fl.r0 = Math.min(q.width, q.height) * 0.35;
  } else {
    fl.ox = fl.w * 0.2;
    fl.oy = fl.h * 0.5;
    fl.r0 = 30;
  }
}
function drawField(fl, t) {
  const { w, h, dpr } = fl;
  if (!w || !h) return;
  const ctx = fl.cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const S = GRID[fl.mode] || 14;
  const cols = Math.floor(w / S);
  const rows = Math.floor(h / S);
  const ox = (w - cols * S) / 2 + S / 2;
  const oy = (h - rows * S) / 2 + S / 2;
  if (fl.mode === 'nav') return drawStrip(fl, ctx, t, S, cols, rows, ox, oy);
  if (fl.mode === 'ripple' || fl.mode === 'burst') return drawRings(fl, ctx, t, S, cols, rows, ox, oy);
  const sec = t / 1000;
  const call = fl.mode === 'call';
  const mid = (rows - 1) / 2;
  const env = call ? 0.55 + 0.45 * Math.abs(Math.sin(sec * 1.9)) : 0.8 + 0.2 * Math.sin(sec * 0.7);
  for (let i = 0; i < cols; i++) {
    const u = i / cols;
    const x = ox + i * S;
    const phrase = 0.5 + 0.5 * Math.sin(u * 7.3 + sec * 0.9 + fl.seed) * Math.cos(u * 2.1 - sec * 0.45);
    const syll = 0.5 + 0.5 * Math.sin(u * 31 + sec * 3.1 + fl.seed * 3);
    const amp = (phrase * 0.7 + syll * 0.3) * env;
    const xf = call ? Math.min(1, Math.max(0, (Math.abs(x - w / 2) - w * 0.2) / (w * 0.22))) : Math.min(1, Math.max(0, 1 - (x - w * 0.38) / (w * 0.2)));
    if (xf <= 0) {
      for (let j = 0; j < rows; j++) dot(ctx, x, oy + j * S, 1, 0.05);
      continue;
    }
    const lit = call ? amp * mid * 0.95 : amp * rows * 0.42;
    for (let j = 0; j < rows; j++) {
      const yy = oy + j * S;
      const d = call ? Math.abs(j - mid) : rows - 1 - j;
      const on = d < lit;
      const top = on && d > lit - 1.2;
      const dm = Math.hypot(x - fl.mx, yy - fl.my);
      const near = dm < 90 ? 1 - dm / 90 : 0;
      if (on) dot(ctx, x, yy, top ? 2.3 : 1.8, (top ? 1 : 0.5 + 0.35 * (1 - d / Math.max(1, lit))) * xf + near * 0.4, true);
      else dot(ctx, x, yy, 1 + near * 1.1, 0.05 + near * 0.5 * xf + near * 0.15, near > 0.2);
    }
  }
}
function drawStrip(fl, ctx, t, S, cols, rows, ox, oy) {
  if (fl.b - fl.a < 72) return;
  const sec = t / 1000;
  const mid = (rows - 1) / 2;
  const kick = 1 + 1.5 * Math.exp(-Math.max(0, t - fl.kick) / 420);
  for (let i = 0; i < cols; i++) {
    const x = ox + i * S;
    if (x < fl.a || x > fl.b) continue;
    const xf = Math.min(1, (x - fl.a) / 56, (fl.b - x) / 56);
    const u = (x - fl.a) / (fl.b - fl.a);
    const amp = (0.5 + 0.5 * Math.sin(u * 8.5 + sec * 1.5 + fl.seed)) * (0.55 + 0.45 * Math.sin(u * 27 - sec * 2.3)) * 0.62 * kick;
    const lit = Math.min(mid + 0.5, amp * mid);
    for (let j = 0; j < rows; j++) {
      const yy = oy + j * S;
      const d = Math.abs(j - mid);
      const dm = Math.hypot(x - fl.mx, yy - fl.my);
      const near = dm < 64 ? 1 - dm / 64 : 0;
      if (d < lit) dot(ctx, x, yy, 1.35, (0.3 + 0.32 * (1 - d / Math.max(0.5, lit))) * xf + near * 0.3, true);
      else dot(ctx, x, yy, 0.9 + near * 0.6, (0.05 + near * 0.35) * xf, near > 0.25);
    }
  }
}
function drawRings(fl, ctx, t, S, cols, rows, ox, oy) {
  const burst = fl.mode === 'burst';
  const sec = Math.max(0, (t - fl.t0) / 1000);
  const env = burst ? (t ? Math.max(0, 1 - sec / 2.6) : 0) : 1;
  const reach = Math.max(fl.w, fl.h) * (burst ? 1 : 0.75);
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const x = ox + i * S;
      const yy = oy + j * S;
      const d = Math.hypot(x - fl.ox, yy - fl.oy);
      const ph = burst ? d / 46 - sec * 2.2 : d / 54 - sec * 0.7;
      let v = env && (!burst || (ph <= 0 && ph > -3)) ? Math.pow(Math.max(0, Math.cos(ph * 6.2832)), burst ? 3 : 2) : 0;
      v *= Math.max(0, 1 - d / reach) * Math.min(1, Math.max(0, (d - fl.r0) / 36)) * env;
      const dm = Math.hypot(x - fl.mx, yy - fl.my);
      const near = dm < 80 ? 1 - dm / 80 : 0;
      if (v > 0.06) dot(ctx, x, yy, 1.1 + v * 1.1, v * (burst ? 1 : 0.8) + near * 0.3, true);
      else dot(ctx, x, yy, 1 + near, 0.05 + near * 0.4, near > 0.25);
    }
}
function dot(ctx, x, y, r, a, lime) {
  ctx.fillStyle = lime ? `rgba(211,238,106,${Math.min(1, a).toFixed(3)})` : `rgba(236,243,238,${Math.min(1, a).toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 6.2832);
  ctx.fill();
}
window.addEventListener('resize', () => FIELDS.forEach(refit));

/* ── точечная сетка страницы оживает под указателем ── */
export function bgGrid() {
  if (reduced() || !window.matchMedia('(pointer: fine)').matches) return;
  const cv = document.createElement('canvas');
  cv.className = 'bgf';
  cv.setAttribute('aria-hidden', 'true');
  document.body.prepend(cv);
  document.body.classList.add('has-bgf');
  const S = 14, H = 640, R = 140;
  let base, w = 0, dpr = 1, gx = 0, px = -1e3, py = -1e3, tx = -1e3, ty = -1e3, k = 0, tk = 0, raf = 0;
  const draw = () => {
    const c = cv.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, cv.width, cv.height);
    if (!base?.width || !base.height) return; // окно ещё без размера (скрытая вкладка, перезагрузка)
    c.drawImage(base, 0, 0);
    if (k < 0.01) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const i0 = Math.max(0, Math.floor((px - R - gx) / S)), i1 = Math.ceil((px + R - gx) / S), j0 = Math.max(0, Math.floor((py - R - 6) / S)), j1 = Math.ceil((py + R - 6) / S);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const x = gx + i * S, y = 6 + j * S;
        if (x > w || y > H) continue;
        const d = Math.hypot(x - px, y - py);
        if (d > R) continue;
        const f = Math.pow(1 - d / R, 2) * k;
        c.clearRect(x - 2, y - 2, 4, 4);
        c.fillStyle = `rgba(30,125,54,${(0.14 + f * 0.5).toFixed(3)})`;
        c.beginPath();
        c.arc(x, y, 1 + f * 1.4, 0, 6.2832);
        c.fill();
      }
  };
  const size = () => {
    w = cv.clientWidth || document.documentElement.clientWidth;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    gx = (w % S) / 2 + S / 2;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(H * dpr);
    base = document.createElement('canvas');
    base.width = cv.width;
    base.height = cv.height;
    const b = base.getContext('2d');
    b.scale(dpr, dpr);
    b.fillStyle = 'rgba(18,48,31,.14)';
    for (let x = gx; x < w; x += S)
      for (let y = 6; y < H; y += S) {
        b.beginPath();
        b.arc(x, y, 1, 0, 6.2832);
        b.fill();
      }
    draw();
  };
  const loop = () => {
    raf = 0;
    px += (tx - px) * 0.22;
    py += (ty - py) * 0.22;
    k += (tk - k) * 0.14;
    draw();
    if (Math.abs(tx - px) > 0.4 || Math.abs(ty - py) > 0.4 || Math.abs(tk - k) > 0.01) raf = requestAnimationFrame(loop);
  };
  addEventListener(
    'pointermove',
    (e) => {
      const r = cv.getBoundingClientRect();
      tx = e.clientX - r.left;
      ty = e.clientY - r.top;
      if (k < 0.02) {
        px = tx;
        py = ty;
      }
      tk = ty < H + R ? 1 : 0;
      if (!raf) raf = requestAnimationFrame(loop);
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    tk = 0;
    if (!raf) raf = requestAnimationFrame(loop);
  });
  let lastW = -1;
  const fit = () => {
    if (cv.clientWidth !== lastW) {
      lastW = cv.clientWidth;
      size();
    }
  };
  if (window.ResizeObserver) new ResizeObserver(fit).observe(document.body);
  addEventListener('resize', fit);
  fit();
}
