// «Аудитор» — ИИ-ассистент руководителя КК. Текстом или голосом (Gemini Live) отвечает по данным платформы
// и сам ведёт по интерфейсу: открывает разделы и диалоги, подводит аватар к строкам, критериям и репликам.
import { esc, toast, icon } from './ui.js';
import { setListFilters } from './views/list.js';
import { jump } from './views/card.js';

const AVATAR_SRC = '/img/auditor.jpg';
const ava = (cls = '') => `<img class="ai-img ${cls}" src="${AVATAR_SRC}" alt="" draggable="false">`;

const SUGGEST = [
  'Кто лучший оператор и почему?',
  'Кто худший оператор? Покажи его главную ошибку',
  'Где операторы ошибаются чаще всего?',
  'Покажи диалоги с грубыми ошибками',
  'Сравни качество на русском, казахском и английском',
];

const apiBase = () => (window.CQA_CONFIG?.apiBase || '').replace(/\/$/, '');
const history = [];
let busyNow = false;

// ── разметка ─────────────────────────────────────────────────────────
const root = document.createElement('div');
root.className = 'ai';
root.innerHTML = `
  <button class="ai-fab" type="button" aria-label="Открыть ассистента Аудитор"><span class="ai-face">${ava()}</span><span>Аудитор</span></button>
  <section class="ai-panel" hidden aria-label="ИИ-ассистент Аудитор">
    <header class="ai-head">
      <span class="ai-face small">${ava()}</span>
      <div><b>Аудитор</b><div class="sub">ИИ-ассистент руководителя контроля качества</div></div>
      <button class="icon-btn" type="button" id="ai-close" aria-label="Свернуть">${icon('x')}</button>
    </header>
    <div class="ai-stage" data-state="idle">
      <div class="ai-face big" id="ai-big">${ava()}<span class="ai-ring"></span></div>
      <div class="ai-status" id="ai-status">Поговорите со мной голосом — я покажу всё на экране</div>
      <button class="btn lime ai-call" type="button" id="ai-call">${icon('mic')}Поговорить голосом</button>
    </div>
    <div class="ai-msgs" id="ai-msgs">
      <div class="ai-sugg">${SUGGEST.map((s) => `<button type="button" class="ai-chip">${esc(s)}</button>`).join('')}</div>
    </div>
    <form class="ai-input" id="ai-form">
      <input class="input" name="q" placeholder="Или напишите вопрос…" autocomplete="off" aria-label="Вопрос ассистенту">
      <button class="btn primary" type="submit" aria-label="Отправить">${icon('send')}</button>
    </form>
  </section>
  <div class="ai-pointer" hidden><span class="ai-face small">${ava()}</span><div class="ai-caption"></div></div>`;
document.body.appendChild(root);

const $ = (s) => root.querySelector(s);
const panel = $('.ai-panel');
const fab = $('.ai-fab');
const msgs = $('#ai-msgs');
const stage = $('.ai-stage');
const status = $('#ai-status');
const big = $('#ai-big');

fab.addEventListener('click', () => {
  panel.hidden = false;
  fab.hidden = true;
});
$('#ai-close').addEventListener('click', () => {
  panel.hidden = true;
  fab.hidden = false;
});
root.querySelectorAll('.ai-chip').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
$('#ai-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.q;
  const q = input.value.trim();
  input.value = '';
  if (!q) return;
  if (voice.ws?.readyState === 1) {
    bubble('me', q);
    voice.ws.send(JSON.stringify({ t: 'text', text: q }));
  } else ask(q);
});

// лёгкий markdown: **жирный**, `код`, списки
const format = (t) =>
  esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-•*]\s+/gm, '• ')
    .replace(/\n/g, '<br>');

function bubble(who, html, raw = false) {
  msgs.querySelector('.ai-sugg')?.remove();
  msgs.insertAdjacentHTML('beforeend', `<div class="ai-msg ${who === 'me' ? 'me' : 'bot'}">${raw ? html : esc(html)}</div>`);
  msgs.scrollTop = msgs.scrollHeight;
  return msgs.lastElementChild;
}

// ── текстовый режим ─────────────────────────────────────────────────
async function ask(q) {
  if (busyNow) return;
  if (voice.ws?.readyState === 1) {
    bubble('me', q);
    voice.ws.send(JSON.stringify({ t: 'text', text: q }));
    return;
  }
  busyNow = true;
  bubble('me', q);
  const think = bubble('bot', '<span class="spinner"></span> Смотрю данные…', true);
  history.push({ role: 'user', text: q });
  try {
    const res = await fetch(`${apiBase()}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, context: { route: location.hash || '#/' } }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    history.push({ role: 'assistant', text: data.reply });
    think.remove();
    bubble('bot', format(data.reply), true);
    for (const a of data.actions) enqueue(a);
  } catch (e) {
    think.remove();
    bubble('bot', `Не получилось: ${e.message}`);
  } finally {
    busyNow = false;
  }
}

// ── голосовой режим (Gemini Live) ───────────────────────────────────
const voice = { ws: null, micCtx: null, micStream: null, outCtx: null, analyser: null, gain: null, playAt: 0, sources: new Set(), cur: null, raf: 0 };

function setState(state, text) {
  stage.dataset.state = state;
  if (text) status.innerHTML = text;
  $('#ai-call').innerHTML = state === 'idle' ? `${icon('mic')}Поговорить голосом` : `${icon('stop')}Завершить разговор`;
}

function liveLine(who, text) {
  if (!voice.cur || voice.cur.who !== who) voice.cur = { who, el: bubble(who, '') };
  voice.cur.el.textContent += text;
  msgs.scrollTop = msgs.scrollHeight;
}

function playPcm(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer);
  const buf = voice.outCtx.createBuffer(1, pcm.length, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = voice.outCtx.createBufferSource();
  src.buffer = buf;
  src.connect(voice.gain);
  voice.playAt = Math.max(voice.playAt, voice.outCtx.currentTime + 0.03);
  src.start(voice.playAt);
  voice.playAt += buf.duration;
  voice.sources.add(src);
  src.onended = () => voice.sources.delete(src);
}
function stopPlayback() {
  voice.sources.forEach((s) => {
    try {
      s.stop();
    } catch {}
  });
  voice.sources.clear();
  voice.playAt = 0;
}

// аватар «дышит» в такт речи: громкость голоса ассистента и пользователя → CSS-переменная --lvl
let micLevel = 0;
function animate() {
  const data = new Uint8Array(voice.analyser.fftSize);
  const tick = () => {
    voice.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    const out = Math.sqrt(sum / data.length);
    const speaking = out > 0.02;
    const lvl = speaking ? Math.min(1, out * 5) : Math.min(1, micLevel * 6);
    for (const el of root.querySelectorAll('.ai-face')) {
      el.style.setProperty('--lvl', lvl.toFixed(3));
      el.classList.toggle('talking', speaking);
      el.classList.toggle('hearing', !speaking && micLevel > 0.03);
    }
    if (voice.ws) {
      if (speaking && stage.dataset.state !== 'speaking') setState('speaking', '<b>Говорит…</b> можно перебить голосом');
      else if (!speaking && stage.dataset.state === 'speaking') setState('listening', '<b class="ok">● Слушаю</b> — спрашивайте');
    }
    voice.raf = requestAnimationFrame(tick);
  };
  tick();
}

async function startVoice() {
  try {
    voice.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    toast('Нет доступа к микрофону — разрешите его в браузере', 'error');
    return;
  }
  setState('connecting', 'Подключаюсь…');
  voice.outCtx = new AudioContext({ sampleRate: 24000 });
  await voice.outCtx.resume();
  voice.gain = voice.outCtx.createGain();
  voice.analyser = voice.outCtx.createAnalyser();
  voice.analyser.fftSize = 512;
  voice.gain.connect(voice.analyser);
  voice.analyser.connect(voice.outCtx.destination);
  voice.micCtx = new AudioContext();
  await voice.micCtx.audioWorklet.addModule('/js/mic-worklet.js');
  const node = new AudioWorkletNode(voice.micCtx, 'cqa-mic');
  voice.micCtx.createMediaStreamSource(voice.micStream).connect(node);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const base = apiBase() ? apiBase().replace(/^http/, 'ws') : `${proto}://${location.host}`;
  const ws = new WebSocket(`${base}/api/assistant/live?route=${encodeURIComponent(location.hash || '#/')}`);
  voice.ws = ws;
  ws.binaryType = 'arraybuffer';
  node.port.onmessage = ({ data }) => {
    micLevel = data.rms;
    if (ws.readyState === 1) ws.send(data.pcm);
  };
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.t === 'ready') setState('listening', '<b class="ok">● Слушаю</b> — спрашивайте');
    else if (m.t === 'audio') playPcm(m.d);
    else if (m.t === 'in') liveLine('me', m.text);
    else if (m.t === 'out') liveLine('bot', m.text);
    else if (m.t === 'turn') voice.cur = null;
    else if (m.t === 'interrupted') {
      stopPlayback();
      voice.cur = null;
    } else if (m.t === 'tool') status.innerHTML = '<span class="spinner"></span> Смотрю данные…';
    else if (m.t === 'ui') enqueue({ name: m.name, args: m.args });
    else if (m.t === 'error') toast(m.error, 'error');
    else if (m.t === 'limit') toast('Время голосовой сессии вышло', 'info');
    else if (m.t === 'closed') stopVoice();
  };
  ws.onclose = () => stopVoice();
  animate();
}

function stopVoice() {
  if (!voice.ws && !voice.micStream) return;
  try {
    voice.ws?.readyState === 1 && voice.ws.send(JSON.stringify({ t: 'bye' }));
    voice.ws?.close();
  } catch {}
  voice.ws = null;
  stopPlayback();
  voice.micStream?.getTracks().forEach((t) => t.stop());
  voice.micStream = null;
  voice.micCtx?.close().catch(() => {});
  cancelAnimationFrame(voice.raf);
  setTimeout(() => voice.outCtx?.close().catch(() => {}), 300);
  root.querySelectorAll('.ai-face').forEach((el) => {
    el.classList.remove('talking', 'hearing');
    el.style.setProperty('--lvl', 0);
  });
  setState('idle', 'Поговорите со мной голосом — я покажу всё на экране');
}

$('#ai-call').addEventListener('click', () => (voice.ws ? stopVoice() : startVoice()));
window.addEventListener('hashchange', () => voice.ws?.readyState === 1 && voice.ws.send(JSON.stringify({ t: 'route', route: location.hash })));

// ── действия на экране: аватар летит к элементу и подсвечивает его ──
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

async function pointTo(el, caption) {
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
  const p = $('.ai-pointer');
  const r = el.getBoundingClientRect();
  p.hidden = false;
  p.querySelector('.ai-caption').textContent = caption || '';
  p.querySelector('.ai-caption').hidden = !caption;
  // аватар — над левой частью элемента, подпись справа от него
  const x = Math.min(window.innerWidth - 320, Math.max(8, r.left + Math.min(r.width * 0.25, 160)));
  const y = Math.min(window.innerHeight - 70, Math.max(90, r.top - 58));
  p.style.transform = `translate(${x}px, ${y}px)`;
  document.querySelectorAll('.ai-focus').forEach((x) => x.classList.remove('ai-focus'));
  await sleep(500);
  el.classList.add('ai-focus');
}

async function run(a) {
  const g = a.args || {};
  const card = (id) => `#/c/${encodeURIComponent(id)}`;
  const onCard = (id) => decodeURIComponent(location.hash.split('?')[0]) === `#/c/${id}`;
  // экран считается открытым, когда #view помечен его ключом (shell.painted)
  const onView = (prefix, sel) => sel.split(',').map((x) => `#view[data-key^="${prefix.replace(/["\\]/g, '')}"] ${x.trim()}`).join(', ');
  const cardKey = (id) => `card:${id}:`;
  if (a.name === 'open_page') {
    const map = { list: '#/', appeals: '#/appeals', checklists: '#/checklists', stats: '#/stats' };
    const page = map[g.page] ? g.page : 'list';
    await pointTo(await goto(map[page], onView(page, '.page-anim > .lane, .page-anim > .head')), g.caption);
  } else if (a.name === 'open_conversation') {
    await pointTo(await goto(card(g.conversation_id), onView(cardKey(g.conversation_id), '.score')), g.caption);
  } else if (a.name === 'point_at_rows') {
    // строки могли скрыть фильтры списка — сбрасываем их и перерисовываем список
    setListFilters();
    document.getElementById('view').dataset.key = ''; // ждём новую отрисовку списка, а не старую
    const ids = g.conversation_ids || [];
    if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
    else window.dispatchEvent(new HashChangeEvent('hashchange'));
    await sleep(150);
    await waitFor(onView('list', ids.length ? `li[data-row-id="${CSS.escape(ids[0])}"]` : '.cards, .rows, .empty'));
    // карточки догружают ход разговора — ждём, пока высота строк перестанет меняться
    for (let t = Date.now(); document.querySelector('.fp-wait, .cv-skel') && Date.now() - t < 6000; ) await sleep(150);
    document.querySelectorAll('.ai-row').forEach((r) => r.classList.remove('ai-row'));
    const rows = ids.map((id) => document.querySelector(`li[data-row-id="${CSS.escape(id)}"]`)).filter(Boolean);
    rows.forEach((r) => r.classList.add('ai-row'));
    await pointTo(rows[0]?.firstElementChild, g.caption);
  } else if (a.name === 'point_at_criterion') {
    if (!onCard(g.conversation_id)) await goto(card(g.conversation_id), onView(cardKey(g.conversation_id), '#breakdown'));
    const box = await waitFor(`#crit-${CSS.escape(g.criterion_id)}`);
    // раскрываем критерий: объяснение и реплика-доказательство подсвечиваются в разговоре
    if (box && !box.classList.contains('on')) {
      box.querySelector('.cr-h')?.click();
      await sleep(350);
    }
    await pointTo(document.querySelector(`#crit-${CSS.escape(g.criterion_id)}`), g.caption);
  } else if (a.name === 'point_at_message') {
    if (!onCard(g.conversation_id)) await goto(card(g.conversation_id), onView(cardKey(g.conversation_id), '.msgs'));
    const m = await waitFor(`#m-${Number(g.index)}`);
    if (m) jump(Number(g.index));
    await sleep(250);
    await pointTo(document.querySelector(`#m-${Number(g.index)}`), g.caption);
  }
}

// действия выполняются по одному, даже если голосовая модель присылает их пачкой
let chain = Promise.resolve();
let hideTimer = 0;
const recent = new Map(); // ключ действия → время: голосовая модель иногда повторяет ту же подсветку
function enqueue(action) {
  const g = action.args || {};
  const key = [action.name, g.page, g.conversation_id, g.criterion_id, g.index, (g.conversation_ids || []).join(',')].join('|');
  if (Date.now() - (recent.get(key) || 0) < 15000) return;
  recent.set(key, Date.now());
  chain = chain
    .then(async () => {
      clearTimeout(hideTimer);
      // на узком экране панель закрывает интерфейс — сворачиваем её, пока ассистент показывает
      if (window.innerWidth < 720 && !panel.hidden) {
        panel.hidden = true;
        fab.hidden = false;
      }
      await run(action);
      await sleep(1600);
      hideTimer = setTimeout(() => {
        $('.ai-pointer').hidden = true;
        document.querySelectorAll('.ai-focus').forEach((x) => x.classList.remove('ai-focus'));
      }, 4000);
    })
    .catch((e) => console.warn('[assistant action]', action.name, e));
}

// те же действия на экране доступны другим модулям (и для проверки без модели)
export { enqueue as showOnScreen };
