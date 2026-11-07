// Точка входа: маршрутизация по hash, переключатель роли, счётчики в меню, демонстрация по экранам.
import { api } from './api.js';
import { role, toast, esc, icon } from './ui.js';
import { state, renderNav, refreshCounts, errorHtml } from './shell.js';
import { placeInd, placeSegs, bgGrid, reduced } from './viz.js';
import { renderList } from './views/list.js';
import { renderCard } from './views/card.js';
import { renderChecklists } from './views/checklists.js';
import { renderAppeals, showAllAppeals } from './views/appeals.js';
import { renderStats } from './views/stats.js';
import { cache, loadConversations } from './data.js';

const view = document.getElementById('view');

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}

let renderToken = 0;
export async function route() {
  const token = ++renderToken;
  const { parts, query } = parseHash();
  let name = parts[0] || 'list';
  if (name === 'c') name = 'card';
  if (!['list', 'card', 'appeals', 'checklists', 'stats'].includes(name)) name = 'list';
  state.route = name === 'card' ? 'list' : name;
  renderNav();
  const ctx = { view, query, parts, isCurrent: () => token === renderToken };
  if (!view.firstChild) view.innerHTML = '<div class="sheet empty"><span class="spinner"></span> Загружаю…</div>';
  try {
    if (name === 'card' && parts[1]) await renderCard(ctx, decodeURIComponent(parts[1]));
    else if (name === 'checklists') await renderChecklists(ctx);
    else if (name === 'appeals') await renderAppeals(ctx, parts[1] ? decodeURIComponent(parts[1]) : null);
    else if (name === 'stats') await renderStats(ctx);
    else await renderList(ctx);
  } catch (e) {
    console.error(e);
    if (ctx.isCurrent()) view.innerHTML = errorHtml('Не удалось загрузить страницу', esc(e.message));
  }
  refreshCounts();
}

// ── роль: сотрудник подаёт апелляции, проверяющий решает ──
function applyRole() {
  const r = role.get();
  document.body.dataset.role = r;
  document.querySelectorAll('#role [data-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === r)));
  placeSegs(document.querySelector('.top'));
}
document.querySelectorAll('#role [data-role]').forEach((b) =>
  b.addEventListener('click', () => {
    if (role.get() === b.dataset.role) return;
    role.set(b.dataset.role);
    applyRole();
    toast(b.dataset.role === 'reviewer' ? 'Режим проверяющего: решения по апелляциям' : 'Режим сотрудника: можно оспорить оценку');
    route();
  }),
);
document.getElementById('role').classList.add('seg');

// ── демонстрация: проходит по настоящим экранам на настоящих данных ──
const tour = { on: false, i: 0, id: null };
const STEPS = [
  { title: 'Список диалогов', text: 'Все диалоги набора: итог, ход разговора и метки критериев. Сверху — то, что требует внимания.', hash: () => '#/', spot: '.lane' },
  { title: 'Итог и разделы', text: 'Итог, разделы и шкала. Баллы считает код по ответам ИИ, модель только выбирает ответ.', hash: () => `#/c/${encodeURIComponent(tour.id)}`, spot: '.score' },
  { title: 'Обоснование', text: 'Открыт критерий: объяснение, совет оператору и реплика-доказательство — она подсвечена в разговоре.', hash: () => `#/c/${encodeURIComponent(tour.id)}`, spot: '.cr.on', open: true },
  { title: 'Из чего сложился итог', text: 'Вклад каждого критерия. Неприменимые (N/A) не штрафуют: их вес делится между остальными.', hash: () => `#/c/${encodeURIComponent(tour.id)}`, spot: '#breakdown' },
  { title: 'Апелляции', text: 'Сотрудник оспаривает оценку в карточке, проверяющий решает здесь — итог пересчитывается сам.', hash: () => '#/appeals', before: showAllAppeals, spot: '.ap, .sheet.empty' },
  { title: 'Чек-лист', text: 'Критерии — это настройка. Изменение можно оценить заранее и применить к диалогам.', hash: () => '#/checklists', spot: '.cl' },
];
const tourEl = document.getElementById('tour');
const tourBtn = document.getElementById('tour-btn');

function renderTour() {
  tourEl.hidden = !tour.on;
  tourBtn.setAttribute('aria-pressed', String(tour.on));
  if (!tour.on) {
    document.querySelectorAll('.spot').forEach((e) => e.classList.remove('spot'));
    return;
  }
  const s = STEPS[tour.i];
  tourEl.innerHTML = `<div class="steps" style="grid-template-columns:repeat(${STEPS.length},1fr)">${STEPS.map((x, k) => `<button type="button" data-tour="${k}" class="${k < tour.i ? 'done' : k === tour.i ? 'now' : ''}" aria-label="Шаг ${k + 1}: ${esc(x.title)}"></button>`).join('')}</div>
    <div><b><span>${tour.i + 1}/${STEPS.length}</span>${esc(s.title)}</b><p>${esc(s.text)}</p></div>
    <div class="nav2"><button type="button" class="btn sm" data-tour="${tour.i - 1}" ${tour.i ? '' : 'disabled'} aria-label="Назад">${icon('left')}</button>${tour.i < STEPS.length - 1 ? `<button type="button" class="btn primary sm" data-tour="${tour.i + 1}">Дальше</button>` : '<button type="button" class="btn primary sm" data-tour="end">Готово</button>'}</div>`;
  tourEl.querySelectorAll('[data-tour]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.tour === 'end') {
        tour.on = false;
        renderTour();
      } else tourGo(Number(b.dataset.tour));
    }),
  );
}

async function tourGo(i) {
  if (i < 0 || i >= STEPS.length) return;
  tour.i = i;
  renderTour();
  const s = STEPS[i];
  s.before?.();
  const hash = s.hash();
  if (location.hash !== hash) location.hash = hash;
  else if (s.before) route();
  for (let tries = 0; tries < 60 && tour.i === i; tries++) {
    await new Promise((r) => setTimeout(r, 120));
    if (s.open && !document.querySelector('.cr.on')) {
      // первый критерий с потерей баллов и репликой-доказательством, иначе первый с доказательством
      const target = document.querySelector('.cr.x[data-has-evidence] .cr-h') || document.querySelector('.cr[data-has-evidence] .cr-h');
      target?.click();
      continue;
    }
    const el = document.querySelector(s.spot);
    if (!el) continue;
    document.querySelectorAll('.spot').forEach((e) => e.classList.remove('spot'));
    el.classList.add('spot');
    el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
    return;
  }
}

tourBtn.addEventListener('click', async () => {
  tour.on = !tour.on;
  if (!tour.on) return renderTour();
  try {
    const convs = cache.convs || (await loadConversations());
    const evaluated = convs.filter((c) => c.evaluation?.total != null).sort((a, b) => a.evaluation.total - b.evaluation.total);
    if (!evaluated.length) {
      tour.on = false;
      renderTour();
      return toast('Сначала оцените хотя бы один диалог', 'error');
    }
    tour.id = evaluated[0].conversation_id;
  } catch (e) {
    tour.on = false;
    return toast(e.message, 'error');
  }
  tourGo(0);
});
document.addEventListener('keydown', (e) => {
  if (!tour.on || e.target.matches('input, textarea, select')) return;
  if (e.key === 'ArrowRight') tourGo(tour.i + 1);
  if (e.key === 'ArrowLeft') tourGo(tour.i - 1);
  if (e.key === 'Escape') {
    tour.on = false;
    renderTour();
  }
});

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  route();
});
window.addEventListener('resize', () => placeInd());
if (window.ResizeObserver) new ResizeObserver(() => placeInd()).observe(document.getElementById('nav'));
document.fonts?.ready.then(() => {
  placeInd();
  placeSegs(document);
});

applyRole();
bgGrid();
api.meta().then((m) => (state.meta = m)).catch(() => {});
route();
