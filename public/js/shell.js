// Общая оболочка экранов: меню со счётчиками, анимация входа, перерисовка с сохранением прокрутки.
import { api } from './api.js';
import { logo } from './ui.js';
import { placeInd, placeSegs, mountFields, kickNav, rollAll } from './viz.js';

export const state = { meta: null, openAppeals: 0, notEvaluated: 0, route: 'list' };

const NAV = [
  ['list', 'Диалоги', '#/'],
  ['appeals', 'Апелляции', '#/appeals'],
  ['checklists', 'Чек-листы', '#/checklists'],
  ['stats', 'Аналитика', '#/stats'],
];

export function renderNav() {
  const mark = document.getElementById('brandMark');
  if (mark && !mark.firstChild) mark.innerHTML = logo();
  const counts = { list: state.notEvaluated, appeals: state.openAppeals };
  document.getElementById('nav').innerHTML = NAV.map(
    ([k, label, href]) =>
      `<a href="${href}" data-nav="${k}"${state.route === k ? ' aria-current="page"' : ''}>${label}${counts[k] ? `<span class="cnt" title="${k === 'list' ? 'Не оценены' : 'Ждут решения'}">${counts[k]}</span>` : ''}</a>`,
  ).join('');
  placeInd();
}

/** Счётчики в меню: открытые апелляции и неоценённые диалоги. */
export async function refreshCounts(convs) {
  try {
    const [open, list] = await Promise.all([api.appeals('open'), convs ? Promise.resolve(convs) : api.conversations()]);
    state.openAppeals = open.length;
    state.notEvaluated = list.filter((c) => !c.evaluation).length;
    renderNav();
  } catch {
    /* счётчики — не главное */
  }
}

let lastKey = '';
/** После вставки разметки экрана: бегунки, поля, «табло», волна появления при смене экрана. */
export function painted(view, key, { rollDelay } = {}) {
  view.dataset.key = key; // по нему ассистент понимает, что нужный экран уже на месте
  placeInd();
  placeSegs(view);
  mountFields();
  if (key !== lastKey) {
    lastKey = key;
    kickNav();
    view.classList.remove('enter');
    void view.offsetWidth;
    view.classList.add('enter');
    clearTimeout(view._e);
    view._e = setTimeout(() => view.classList.remove('enter'), 1500);
  }
  rollAll(view, (el) => {
    if (rollDelay) return rollDelay(el);
    const li = el.closest('li');
    return li ? (parseInt(li.style.getPropertyValue('--i'), 10) || 0) * 45 + 220 : 0;
  });
}

/** Перерисовка без потери прокрутки страницы и прокручиваемых блоков. */
export function keepScroll(fn) {
  const y = window.scrollY;
  const keep = [...document.querySelectorAll('[data-keep-scroll]')].map((s) => s.scrollTop);
  fn();
  document.querySelectorAll('[data-keep-scroll]').forEach((s, i) => {
    if (keep[i] != null) s.scrollTop = keep[i];
  });
  window.scrollTo(0, y);
}

/** Плавная смена состояния через View Transitions, если браузер умеет. */
export function swap(fn) {
  const ok = document.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!ok) return fn();
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  const vt = document.startViewTransition(run);
  [vt.ready, vt.finished, vt.updateCallbackDone].forEach((p) => p?.catch(() => {}));
  setTimeout(() => {
    if (!done) {
      try {
        vt.skipTransition();
      } catch {}
      run();
    }
  }, 250);
}

export const errorHtml = (title, message) => `<div class="sheet empty"><b>${title}</b>${message}</div>`;
