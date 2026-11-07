// Точка входа: маршрутизация по hash, переключатель роли, счётчик апелляций.
import { api } from './api.js';
import { role, toast } from './ui.js';
import { renderList } from './views/list.js';
import { renderCard } from './views/card.js';
import { renderChecklists } from './views/checklists.js';
import { renderAppeals } from './views/appeals.js';
import { renderStats } from './views/stats.js';

const view = document.getElementById('view');
export const state = { meta: null };

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}

let renderToken = 0;
export async function route() {
  const token = ++renderToken;
  const { parts, query } = parseHash();
  const name = parts[0] || 'list';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (name === 'c' ? 'list' : name)));
  const ctx = { view, query, isCurrent: () => token === renderToken };
  try {
    if (name === 'c' && parts[1]) await renderCard(ctx, decodeURIComponent(parts[1]));
    else if (name === 'checklists') await renderChecklists(ctx);
    else if (name === 'appeals') await renderAppeals(ctx);
    else if (name === 'stats') await renderStats(ctx);
    else await renderList(ctx);
  } catch (e) {
    console.error(e);
    if (ctx.isCurrent()) view.innerHTML = `<div class="empty"><h2>Не удалось загрузить страницу</h2><p>${e.message}</p></div>`;
  }
  refreshAppealsBadge();
}

export async function refreshAppealsBadge() {
  try {
    const open = await api.appeals('open');
    const b = document.getElementById('appeals-badge');
    b.hidden = !open.length;
    b.textContent = open.length;
  } catch {}
}

function applyRole() {
  const r = role.get();
  document.body.dataset.role = r;
  document.querySelectorAll('[data-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === r)));
}

document.querySelectorAll('[data-role]').forEach((b) =>
  b.addEventListener('click', () => {
    role.set(b.dataset.role);
    applyRole();
    toast(b.dataset.role === 'reviewer' ? 'Режим проверяющего: можно принимать решения по апелляциям' : 'Режим сотрудника: можно подавать апелляции');
    route();
  }),
);

window.addEventListener('hashchange', route);
applyRole();
api.meta().then((m) => (state.meta = m)).catch(() => {});
route();
