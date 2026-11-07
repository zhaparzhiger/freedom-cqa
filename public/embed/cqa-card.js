// <cqa-card> — веб-компонент карточки оценки диалога для встраивания в любую страницу
// (HTML-веб-ресурс Dynamics 365, портал, внутренняя вики). Подключение одной строкой:
//
//   <script type="module" src="https://<сервер-cqa>/embed/cqa-card.js"></script>
//   <cqa-card conversation-id="p1-ru-001"></cqa-card>
//
// Атрибуты: conversation-id (обязательный), api-base (адрес сервера CQA; по умолчанию — тот, откуда загружен скрипт),
// compact (без пояснений по критериям). Стили изолированы в Shadow DOM и не конфликтуют со страницей.
// Событие cqa-loaded (detail: { conversationId, total, grossError }) — для интеграции со скриптами формы CRM.

const SCRIPT_ORIGIN = new URL(import.meta.url).origin;

const CSS = `
:host { --g:#1f8a4c; --g2:#e5f3ea; --b:#c0392b; --b2:#fbe9e7; --m:#b7791f; --m2:#fbf1df; --t:#17201b; --mu:#66736c; --bd:#e1e6e3; --s2:#f8faf9;
  display:block; font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif; color:var(--t); }
.card { border:1px solid var(--bd); border-radius:10px; background:#fff; overflow:hidden; }
.head { display:flex; gap:14px; align-items:center; padding:14px 16px; border-bottom:1px solid var(--bd); flex-wrap:wrap; }
.score { font-size:34px; font-weight:700; line-height:1; font-variant-numeric:tabular-nums; }
.score small { font-size:13px; color:var(--mu); font-weight:500; }
.good{color:var(--g)} .mid{color:var(--m)} .bad{color:var(--b)} .na{color:var(--mu)}
.meta { flex:1; min-width:160px; }
.id { font-weight:600; }
.tiny { font-size:12px; color:var(--mu); }
.tag { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; font-weight:500; margin:4px 4px 0 0; }
.tag.bad { background:var(--b2); color:var(--b); } .tag.ok { background:var(--g2); color:var(--g); } .tag.warn { background:var(--m2); color:var(--m); }
ul { list-style:none; margin:0; padding:0; }
li { padding:10px 16px; border-bottom:1px solid var(--bd); }
li:last-child { border-bottom:0; }
.row { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
.name { font-weight:600; }
.ans { font-weight:600; font-size:12px; padding:1px 8px; border-radius:6px; white-space:nowrap; }
.ans.good { background:var(--g2); } .ans.bad { background:var(--b2); } .ans.mid { background:var(--m2); } .ans.na { background:var(--s2); }
.expl { margin:4px 0 0; }
q { display:block; margin-top:4px; padding:4px 8px; border-left:3px solid var(--bd); color:var(--mu); font-size:12px; quotes:none; }
.foot { padding:10px 16px; background:var(--s2); display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; }
a { color:var(--g); text-decoration:none; font-weight:500; } a:hover { text-decoration:underline; }
.empty { padding:18px 16px; color:var(--mu); }
`;

const tone = (c, a) => {
  if (a == null || a === 'na') return 'na';
  if (c.type === 'flag') return a === 'yes' ? 'bad' : 'good';
  if (c.type === 'scale') {
    const r = Number(a) / Math.max(...c.scale.map((s) => s.value));
    return r >= 1 ? 'good' : r >= 0.5 ? 'mid' : 'bad';
  }
  return a === 'yes' ? 'good' : 'bad';
};
const label = (c, a) => {
  if (a == null) return '—';
  if (a === 'na') return 'N/A';
  if (c.type === 'flag') return a === 'yes' ? 'Выявлены' : 'Нет';
  if (c.type === 'scale') return `${a} из ${Math.max(...c.scale.map((s) => s.value))}`;
  return a === 'yes' ? 'Да' : 'Нет';
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }));
const scoreTone = (t) => (t == null ? 'na' : t >= 85 ? 'good' : t >= 60 ? 'mid' : 'bad');

class CqaCard extends HTMLElement {
  static get observedAttributes() {
    return ['conversation-id', 'api-base', 'compact'];
  }
  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }
  connectedCallback() {
    this.load();
  }
  attributeChangedCallback() {
    if (this.isConnected) this.load();
  }
  get base() {
    return (this.getAttribute('api-base') || SCRIPT_ORIGIN).replace(/\/$/, '');
  }
  async load() {
    const id = this.getAttribute('conversation-id');
    if (!id) return this.paint('<div class="empty">Не указан conversation-id</div>');
    this.paint('<div class="empty">Загружаю оценку…</div>');
    try {
      const res = await fetch(`${this.base}/api/conversations/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      this.render(data);
    } catch (e) {
      this.paint(`<div class="empty">Не удалось загрузить оценку диалога ${esc(id)}: ${esc(e.message)}</div>`);
    }
  }
  paint(inner) {
    this.root.innerHTML = `<style>${CSS}</style><div class="card">${inner}</div>`;
  }
  render({ conversation, current: ev }) {
    if (!ev) {
      this.paint(`<div class="empty">Диалог ${esc(conversation.conversation_id)} ещё не оценён. <a href="${this.base}/#/c/${encodeURIComponent(conversation.conversation_id)}" target="_blank" rel="noopener">Оценить в CQA ↗</a></div>`);
      return;
    }
    const r = ev.result;
    const fs = r.finalScore;
    const compact = this.hasAttribute('compact');
    const quote = (i) => conversation.transcript[i] ? `<q>#${i} ${esc(conversation.transcript[i].speaker === 'operator' ? 'Оператор' : conversation.transcript[i].speaker === 'client' ? 'Клиент' : 'Система')}: ${esc(String(conversation.transcript[i].text).slice(0, 160))}</q>` : '';
    this.paint(`
      <div class="head">
        <div class="score ${scoreTone(fs.total)}">${num(fs.total)}<small>/100</small></div>
        <div class="meta">
          <div class="id">${esc(conversation.conversation_id)} · ${conversation.channel === 'voice call' ? 'звонок' : 'чат'} · ${esc(conversation.language)}</div>
          <div class="tiny">${esc(ev.checklist.name)} v${ev.checklistVersion}${r.changed.length ? ` · пересмотрено (ИИ: ${num(r.originalScore.total)})` : ''}</div>
          ${fs.grossError ? '<span class="tag bad">⚠ Грубая ошибка</span>' : '<span class="tag ok">Грубых ошибок нет</span>'}
          ${r.openAppeals ? `<span class="tag warn">Апелляций: ${r.openAppeals}</span>` : ''}
        </div>
      </div>
      <ul>
        ${ev.checklist.criteria.map((c) => {
          const a = r.finalAnswers[c.id];
          const it = ev.items.find((i) => i.criterionId === c.id);
          return `<li><div class="row"><span class="name">${esc(c.name)}</span><span class="ans ${tone(c, a)} ${tone(c, a)}">${esc(label(c, a))}</span></div>
            ${!compact && it ? `<p class="expl">${esc(it.explanation)}</p>${(it.evidence || []).slice(0, 1).map(quote).join('')}` : ''}</li>`;
        }).join('')}
      </ul>
      <div class="foot"><span class="tiny">Оценено ${new Date(ev.createdAt).toLocaleString('ru-RU')}</span><a href="${this.base}/#/c/${encodeURIComponent(conversation.conversation_id)}" target="_blank" rel="noopener">Открыть в CQA ↗</a></div>`);
    this.dispatchEvent(new CustomEvent('cqa-loaded', { bubbles: true, composed: true, detail: { conversationId: conversation.conversation_id, total: fs.total, grossError: fs.grossError } }));
  }
}

if (!customElements.get('cqa-card')) customElements.define('cqa-card', CqaCard);
