// «Аудитор» — ИИ-ассистент руководителя КК. Отвечает по данным платформы и сам ведёт по интерфейсу:
// открывает разделы и диалоги, подводит указатель к строкам, критериям и репликам и подсвечивает их.
import { esc, toast } from './ui.js';
import { setListFilters } from './views/list.js';

const AVATAR = `
<svg viewBox="0 0 64 64" aria-hidden="true">
  <rect x="6" y="8" width="52" height="48" rx="18" fill="#1f8a4c"/>
  <rect x="14" y="20" width="36" height="22" rx="11" fill="#e9f7ee"/>
  <circle class="eye" cx="25" cy="31" r="4" fill="#17201b"/>
  <circle class="eye" cx="39" cy="31" r="4" fill="#17201b"/>
  <path d="M26 47 q6 4 12 0" stroke="#e9f7ee" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M8 30 a24 24 0 0 1 48 0" stroke="#145c33" stroke-width="3" fill="none"/>
  <rect x="3" y="28" width="7" height="12" rx="3" fill="#145c33"/>
  <rect x="54" y="28" width="7" height="12" rx="3" fill="#145c33"/>
</svg>`;

const SUGGEST = [
  'Кто лучший оператор и почему?',
  'Кто худший оператор? Покажи его главную ошибку',
  'Где операторы ошибаются чаще всего?',
  'Покажи диалоги с грубыми ошибками',
  'Сравни качество на русском, казахском и английском',
];

const history = [];
let speak = false;
let busyNow = false;

function mount() {
  const root = document.createElement('div');
  root.className = 'ai';
  root.innerHTML = `
    <button class="ai-fab" type="button" aria-label="Открыть ассистента Аудитор">${AVATAR}<span>Аудитор</span></button>
    <section class="ai-panel" hidden aria-label="ИИ-ассистент Аудитор">
      <header class="ai-head">
        <span class="ai-ava">${AVATAR}</span>
        <div><b>Аудитор</b><div class="tiny muted">ИИ-ассистент руководителя КК · показывает всё на экране</div></div>
        <label class="ai-voice tiny" title="Озвучивать ответы"><input type="checkbox" id="ai-speak"> 🔊</label>
        <button class="icon-btn" type="button" id="ai-close" aria-label="Свернуть">✕</button>
      </header>
      <div class="ai-msgs" id="ai-msgs">
        <div class="ai-msg bot">Здравствуйте! Я знаю все оценки на платформе. Спросите, кто лучший или худший оператор, где чаще ошибаются — я найду и покажу прямо на экране.</div>
        <div class="ai-sugg">${SUGGEST.map((s) => `<button type="button" class="ai-chip">${esc(s)}</button>`).join('')}</div>
      </div>
      <form class="ai-input" id="ai-form">
        <button type="button" class="icon-btn" id="ai-mic" title="Сказать голосом" aria-label="Сказать голосом">🎙</button>
        <input name="q" placeholder="Спросите о качестве работы операторов…" autocomplete="off">
        <button class="btn primary small" type="submit">→</button>
      </form>
    </section>
    <div class="ai-pointer" hidden>${AVATAR}<div class="ai-caption"></div></div>`;
  document.body.appendChild(root);

  const panel = root.querySelector('.ai-panel');
  const fab = root.querySelector('.ai-fab');
  const msgs = root.querySelector('#ai-msgs');
  const form = root.querySelector('#ai-form');
  const input = form.querySelector('input');
  fab.addEventListener('click', () => {
    panel.hidden = false;
    fab.hidden = true;
    input.focus();
  });
  root.querySelector('#ai-close').addEventListener('click', () => {
    panel.hidden = true;
    fab.hidden = false;
  });
  root.querySelector('#ai-speak').addEventListener('change', (e) => {
    speak = e.target.checked;
    if (!speak) speechSynthesis?.cancel();
  });
  root.querySelectorAll('.ai-chip').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) ask(q);
    input.value = '';
  });

  // голосовой ввод — распознавание речи браузера (Chrome/Edge)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = root.querySelector('#ai-mic');
  if (!SR) mic.hidden = true;
  else
    mic.addEventListener('click', () => {
      const rec = new SR();
      rec.lang = 'ru-RU';
      rec.interimResults = false;
      mic.classList.add('rec');
      rec.onresult = (e) => ask(e.results[0][0].transcript);
      rec.onerror = () => toast('Не удалось распознать речь', 'error');
      rec.onend = () => mic.classList.remove('rec');
      rec.start();
    });

  async function ask(q) {
    if (busyNow) return;
    busyNow = true;
    msgs.querySelector('.ai-sugg')?.remove();
    msgs.insertAdjacentHTML('beforeend', `<div class="ai-msg me">${esc(q)}</div><div class="ai-msg bot ai-think"><span class="spinner"></span> Смотрю данные…</div>`);
    msgs.scrollTop = msgs.scrollHeight;
    history.push({ role: 'user', text: q });
    try {
      const res = await fetch(`${(window.CQA_CONFIG?.apiBase || '').replace(/\/$/, '')}/api/assistant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history, context: { route: location.hash || '#/' } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      history.push({ role: 'assistant', text: data.reply });
      msgs.querySelector('.ai-think')?.remove();
      msgs.insertAdjacentHTML('beforeend', `<div class="ai-msg bot">${format(data.reply)}${data.actions.length ? `<div class="tiny muted ai-acts">Показываю на экране: ${data.actions.length} ${data.actions.length === 1 ? 'шаг' : 'шага'}</div>` : ''}</div>`);
      msgs.scrollTop = msgs.scrollHeight;
      if (speak && window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(data.reply.replace(/[*`#_]/g, ''));
        u.lang = 'ru-RU';
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
      }
      await play(data.actions, root);
    } catch (e) {
      msgs.querySelector('.ai-think')?.remove();
      msgs.insertAdjacentHTML('beforeend', `<div class="ai-msg bot error">Не получилось: ${esc(e.message)}</div>`);
    } finally {
      busyNow = false;
    }
  }
}

// лёгкий markdown: **жирный**, `код`, списки
const format = (t) =>
  esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-•*]\s+/gm, '• ')
    .replace(/\n/g, '<br>');

// ── указатель: летит к элементу, подсвечивает, подписывает ──────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(selector, timeout = 9000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(120);
  }
  return null;
}
const goto = async (hash, readySelector) => {
  if (location.hash !== hash) location.hash = hash;
  return waitFor(readySelector);
};

async function pointTo(el, caption, root) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // ждём, пока плавная прокрутка остановится, иначе координаты устаревшие
  let last = -1;
  for (let i = 0; i < 15; i++) {
    await sleep(90);
    const top = el.getBoundingClientRect().top;
    if (Math.abs(top - last) < 1) break;
    last = top;
  }
  const p = root.querySelector('.ai-pointer');
  const r = el.getBoundingClientRect();
  p.hidden = false;
  p.querySelector('.ai-caption').textContent = caption || '';
  p.querySelector('.ai-caption').hidden = !caption;
  // указатель — над левой частью элемента, подпись справа от него
  const x = Math.min(window.innerWidth - 320, Math.max(8, r.left + Math.min(r.width * 0.25, 160)));
  const y = Math.min(window.innerHeight - 60, Math.max(64, r.top - 50));
  p.style.transform = `translate(${x}px, ${y}px)`;
  document.querySelectorAll('.ai-focus').forEach((x) => x.classList.remove('ai-focus'));
  await sleep(500);
  el.classList.add('ai-focus');
}

async function play(actions, root) {
  const card = (id) => `#/c/${encodeURIComponent(id)}`;
  const onCard = (id) => decodeURIComponent(location.hash).startsWith(`#/c/${id}`);
  for (const a of actions.slice(0, 6)) {
    const g = a.args || {};
    try {
      if (a.name === 'open_page') {
        const map = { list: '#/', appeals: '#/appeals', checklists: '#/checklists', stats: '#/stats' };
        const el = await goto(map[g.page] || '#/', '.page-head');
        await pointTo(el, g.caption, root);
      } else if (a.name === 'open_conversation') {
        const el = await goto(card(g.conversation_id), '.score-card, .empty');
        await pointTo(el, g.caption, root);
      } else if (a.name === 'point_at_rows') {
        setListFilters();
        const ids = g.conversation_ids || [];
        await goto('#/', ids.length ? `tr[data-id="${CSS.escape(ids[0])}"]` : '.table');
        const rows = ids.map((id) => document.querySelector(`tr[data-id="${CSS.escape(id)}"]`)).filter(Boolean);
        rows.forEach((r) => r.classList.add('ai-row'));
        await pointTo(rows[0], g.caption, root);
      } else if (a.name === 'point_at_criterion') {
        if (!onCard(g.conversation_id)) await goto(card(g.conversation_id), '.criteria');
        document.querySelector('[data-tab="result"]')?.click();
        await pointTo(await waitFor(`#crit-${CSS.escape(g.criterion_id)}`), g.caption, root);
      } else if (a.name === 'point_at_message') {
        if (!onCard(g.conversation_id)) await goto(card(g.conversation_id), '.transcript');
        const grid = document.querySelector('.card-grid');
        if (grid && getComputedStyle(grid).display !== 'grid') document.querySelector('[data-tab="transcript"]')?.click();
        const m = await waitFor(`#m-${Number(g.index)}`);
        m?.classList.add('hl');
        await pointTo(m, g.caption, root);
      }
    } catch (e) {
      console.warn('[assistant action]', a.name, e);
    }
    await sleep(1700);
  }
  setTimeout(() => {
    root.querySelector('.ai-pointer').hidden = true;
  }, 4000);
}

mount();
