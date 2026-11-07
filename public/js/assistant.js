// «Аудитор» — ИИ-ассистент руководителя КК. Текстом или голосом (Gemini Live) отвечает по данным платформы
// и сам ведёт по интерфейсу: открывает разделы и диалоги, подводит аватар к строкам, критериям и репликам.
import { esc, toast, icon } from './ui.js';
import { setListFilters } from './views/list.js';
import { jump } from './views/card.js';
import { act } from './agent-dom.js';

const AVATAR_SRC = '/img/auditor.jpg';
const ava = (cls = '') => `<img class="ai-img ${cls}" src="${AVATAR_SRC}" alt="" draggable="false">`;

// подсказки помещаются в блок субтитров без прокрутки — поэтому их три
const SUGGEST = ['Где операторы ошибаются чаще всего?', 'Покажи диалоги с грубыми ошибками', 'Сравни качество на русском, казахском и английском'];

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
    <div class="ai-say" id="ai-say" aria-live="polite">
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
const sayBox = $('#ai-say');
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
    say.reset();
    voice.ws.send(JSON.stringify({ t: 'text', text: q }));
  } else ask(q);
});

// ── субтитры: одна фраза на месте, следующая сменяет предыдущую ─────
// Ни истории переписки, ни расшифровки слов пользователя: видно только то, что Аудитор говорит сейчас.
const MAX_CHUNK = 130; // столько символов помещается в блок без прокрутки
const plain = (t) => t.replace(/\*\*|`/g, '').replace(/^\s*[-•*]\s+/gm, '').replace(/\s+/g, ' ');

// длинную фразу режем по запятой или пробелу, чтобы она целиком помещалась в блок
function split(sentence) {
  const out = [];
  let s = sentence.trim();
  while (s.length > MAX_CHUNK) {
    let cut = s.lastIndexOf(', ', MAX_CHUNK);
    if (cut < MAX_CHUNK * 0.4) cut = s.lastIndexOf(' ', MAX_CHUNK);
    if (cut <= 0) cut = MAX_CHUNK;
    out.push(s.slice(0, cut + 1).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

const say = {
  buf: '',
  queue: [],
  timer: 0,
  until: 0,
  // поток текста (голос приходит кусками): готовые предложения — в очередь, хвост ждёт продолжения
  feed(text) {
    this.buf += text;
    const re = /^([\s\S]*?[.!?…]+["»)]*)\s+([\s\S]*)$/;
    let m;
    while ((m = this.buf.match(re))) {
      this.push(m[1]);
      this.buf = m[2];
    }
  },
  flush() {
    if (this.buf.trim()) this.push(this.buf);
    this.buf = '';
  },
  text(t) {
    this.reset();
    this.feed(plain(t) + ' ');
    this.flush();
  },
  push(sentence) {
    for (const part of split(plain(sentence))) if (part) this.queue.push(part);
    this.pump();
  },
  // фраза держится столько, сколько её произносят (~65 мс на символ), затем её место занимает следующая
  pump() {
    clearTimeout(this.timer);
    const wait = this.until - Date.now();
    if (wait > 0) return void (this.timer = setTimeout(() => this.pump(), wait));
    const next = this.queue.shift();
    if (!next) return;
    this.until = Date.now() + Math.max(1500, next.length * 65);
    this.show(next);
    if (this.queue.length) this.timer = setTimeout(() => this.pump(), this.until - Date.now());
  },
  show(sentence, cls = '') {
    sayBox.querySelector('.ai-sugg')?.remove();
    sayBox.querySelectorAll('.ai-line').forEach((old) => {
      old.classList.add('out');
      setTimeout(() => old.remove(), 450);
    });
    const words = sentence.split(' ');
    const step = Math.min(70, 900 / words.length);
    const line = document.createElement('div');
    line.className = `ai-line ${cls}`;
    line.innerHTML = words.map((w, i) => `<span style="animation-delay:${Math.round(i * step)}ms">${esc(w)}</span>`).join(' ');
    sayBox.appendChild(line);
  },
  thinking(text = 'Смотрю данные…') {
    this.reset();
    sayBox.querySelector('.ai-sugg')?.remove();
    sayBox.querySelectorAll('.ai-line').forEach((old) => old.remove());
    sayBox.insertAdjacentHTML('beforeend', `<div class="ai-line wait"><span class="spinner"></span> ${esc(text)}</div>`);
  },
  reset() {
    clearTimeout(this.timer);
    this.buf = '';
    this.queue = [];
    this.until = 0;
  },
};

// ── текстовый режим ─────────────────────────────────────────────────
async function ask(q) {
  if (busyNow) return;
  if (voice.ws?.readyState === 1) {
    say.reset();
    voice.ws.send(JSON.stringify({ t: 'text', text: q }));
    return;
  }
  busyNow = true;
  say.thinking();
  history.push({ role: 'user', text: q });
  const post = async (extra = {}) => {
    const res = await fetch(`${apiBase()}/api/assistant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, context: { route: location.hash || '#/' }, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.status);
    return data;
  };
  try {
    let data = await post();
    // модель управляет сайтом: браузер выполняет её действия и возвращает результат, пока она не ответит текстом
    while (data.pending) {
      for (const a of data.actions || []) enqueue(a);
      say.thinking('Работаю на сайте…');
      const results = [];
      for (const c of data.pending.calls) results.push(await perform(c.name, c.args));
      data = await post({ resume: { ...data.pending, results } });
    }
    history.push({ role: 'assistant', text: data.reply });
    say.text(data.reply);
    for (const a of data.actions) enqueue(a);
  } catch (e) {
    history.pop();
    say.reset();
    say.show(`Не получилось: ${e.message}`, 'err');
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
    else if (m.t === 'out') say.feed(m.text); // слова пользователя ('in') не показываем
    else if (m.t === 'turn') say.flush();
    else if (m.t === 'interrupted') {
      stopPlayback();
      say.reset();
    } else if (m.t === 'tool') status.innerHTML = '<span class="spinner"></span> Смотрю данные…';
    else if (m.t === 'ui') enqueue({ name: m.name, args: m.args });
    else if (m.t === 'ui_call') perform(m.name, m.args).then((result) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'ui_result', id: m.id, result })));
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

// действие на сайте (click, type_text…): в общей очереди с показом, результат и новый снимок экрана — модели
function perform(name, args = {}) {
  const job = chain.then(async () => {
    clearTimeout(hideTimer);
    if (window.innerWidth < 720 && !panel.hidden) {
      panel.hidden = true;
      fab.hidden = false;
    }
    try {
      return await act(name, args, pointTo);
    } catch (e) {
      return { error: String(e?.message || e) };
    } finally {
      hideTimer = setTimeout(() => {
        $('.ai-pointer').hidden = true;
        document.querySelectorAll('.ai-focus').forEach((x) => x.classList.remove('ai-focus'));
      }, 2500);
    }
  });
  chain = job.catch(() => {});
  return job;
}

// те же действия на экране доступны другим модулям (и для проверки без модели)
export { enqueue as showOnScreen, say as subtitles, perform as controlSite };
