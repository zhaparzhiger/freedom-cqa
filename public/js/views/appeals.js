// Очередь апелляций для проверяющего.
import { api } from '../api.js';
import { esc, fmtDate, role } from '../ui.js';

let tab = 'open';

export async function renderAppeals(ctx) {
  const list = await api.appeals(tab === 'all' ? '' : tab);
  if (!ctx.isCurrent()) return;
  const isReviewer = role.get() === 'reviewer';
  const ans = (a, v) => (v == null ? '—' : v === 'yes' ? (a.criterionType === 'flag' ? 'Выявлены' : 'Да') : v === 'no' ? 'Нет' : v === 'na' ? 'N/A' : v);
  ctx.view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Апелляции</h1>
        <p class="muted">${isReviewer ? 'Откройте апелляцию, изучите реплики-доказательства и примите решение.' : 'Здесь видны поданные апелляции. Решения принимает проверяющий — переключите роль вверху.'}</p>
      </div>
    </div>
    <div class="seg-tabs">
      ${[['open', 'Открытые'], ['resolved', 'Рассмотренные'], ['all', 'Все']].map(([k, l]) => `<button type="button" data-tab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}
    </div>
    ${list.length ? `
    <div class="appeal-list">
      ${list.map((a) => `
        <a class="appeal-row panel" href="#/c/${encodeURIComponent(a.conversationId)}?crit=${a.criterionId}">
          <div class="appeal-row-head">
            <b>${esc(a.conversationId)}</b> · ${esc(a.criterionName || a.criterionId)}
            <span class="tag ${a.status === 'open' ? 'warn' : a.decision?.action === 'change' ? 'info' : 'good'}">${a.status === 'open' ? 'Ждёт решения' : a.decision.action === 'change' ? 'Оценка изменена' : 'Подтверждена'}</span>
          </div>
          <div class="muted tiny">Оценка ИИ: ${esc(ans(a, a.aiAnswer))}${a.proposedAnswer ? ` · ожидаемая: ${esc(ans(a, a.proposedAnswer))}` : ''}${a.decision?.answer ? ` · новая: ${esc(ans(a, a.decision.answer))}` : ''} · ${esc(a.author)}, ${fmtDate(a.createdAt)}</div>
          <p>«${esc(a.comment)}»</p>
          ${a.decision ? `<p class="tiny">Решение: ${esc(a.decision.reason)}</p>` : ''}
        </a>`).join('')}
    </div>` : `<div class="empty small"><h2>${tab === 'open' ? 'Открытых апелляций нет' : 'Апелляций нет'}</h2><p>Апелляцию подают из карточки диалога кнопкой «Оспорить оценку».</p></div>`}`;
  ctx.view.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      renderAppeals(ctx);
    }),
  );
}
