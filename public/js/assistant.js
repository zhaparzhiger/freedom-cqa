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
  if (present.on) return present.end(true);
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
    // чуть длиннее блока — режем пополам, чтобы в конце не остался обрывок из одного слова
    const lim = s.length < MAX_CHUNK * 1.6 ? Math.ceil(s.length / 2) + 12 : MAX_CHUNK;
    let cut = s.lastIndexOf(', ', lim);
    if (cut < lim * 0.4) cut = s.lastIndexOf(' ', lim);
    if (cut <= 0) cut = lim;
    out.push(s.slice(0, cut + 1).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

const audioNow = () => voice.outCtx?.currentTime ?? 0;

const say = {
  buf: '',
  queue: [],
  timer: 0,
  until: 0,
  start: null, // голос: момент аудио, с которого звучит текущее предложение
  // поток текста (голос приходит кусками): готовые предложения — в очередь, хвост ждёт продолжения.
  // В голосе звук приходит быстрее, чем играет, поэтому каждое предложение привязано к моменту аудио,
  // когда его начнут произносить: субтитр появляется вместе со звуком, а не раньше.
  feed(text, voiced = false) {
    if (voiced && this.start == null) this.start = voice.turnStart ?? Math.max(audioNow(), voice.playAt);
    this.buf += text;
    const re = /^([\s\S]*?[.!?…]+["»)]*)\s+([\s\S]*)$/;
    let m;
    while ((m = this.buf.match(re))) {
      this.push(m[1], voiced ? this.start : 0);
      // конец уже полученного звука ≈ конец этого предложения = начало следующего
      if (voiced) this.start = Math.max(audioNow(), voice.playAt);
      this.buf = m[2];
    }
  },
  flush(voiced = false) {
    if (this.buf.trim()) this.push(this.buf, voiced ? (this.start ?? 0) : 0);
    this.buf = '';
    this.start = null;
  },
  text(t) {
    this.reset();
    this.feed(plain(t) + ' ');
    this.flush();
  },
  push(sentence, at = 0) {
    let offset = 0;
    for (const part of split(plain(sentence))) {
      if (!part) continue;
      // вторая половина длинной фразы — когда до неё дойдёт речь (~15 символов в секунду)
      this.queue.push({ text: part, at: at ? at + offset / 15 : 0, voiced: !!at });
      offset += part.length + 1;
    }
    this.pump();
  },
  // текст: фраза держится столько, сколько её читают (~65 мс на символ); голос: пока не зазвучит следующая
  pump() {
    clearTimeout(this.timer);
    const next = this.queue[0];
    if (!next) return;
    let wait = this.until - Date.now();
    if (next.at) wait = Math.max(next.voiced ? 0 : wait, (next.at - audioNow()) * 1000);
    if (wait > 30) return void (this.timer = setTimeout(() => this.pump(), Math.min(wait, 500)));
    this.queue.shift();
    this.until = Date.now() + (next.voiced ? 600 : Math.max(1500, next.text.length * 65));
    this.show(next.text);
    if (this.queue.length) this.timer = setTimeout(() => this.pump(), 60);
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
    // во время показа окно свёрнуто — та же фраза идёт подписью у аватара на странице
    if (present.on) caption(line.innerHTML);
  },
  thinking(text = 'Смотрю данные…') {
    this.reset();
    sayBox.querySelector('.ai-sugg')?.remove();
    sayBox.querySelectorAll('.ai-line').forEach((old) => old.remove());
    sayBox.insertAdjacentHTML('beforeend', `<div class="ai-line wait"><span class="spinner"></span> ${esc(text)}</div>`);
    if (present.on) caption(`<span class="spinner"></span> ${esc(text)}`);
  },
  reset() {
    clearTimeout(this.timer);
    this.buf = '';
    this.queue = [];
    this.until = 0;
    this.start = null;
  },
  get talking() {
    return this.queue.length > 0 || Date.now() < this.until;
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
      // экскурсия закончилась — окно возвращается сразу, финальная фраза придёт уже в него
      if (data.pending.calls.some((c) => c.name === 'tour')) {
        present.end();
        say.thinking('Секунду…');
      }
      data = await post({ resume: { ...data.pending, results } });
    }
    history.push({ role: 'assistant', text: data.reply });
    const acts = data.actions || [];
    if (acts.length) {
      // ответ с показом: места по очереди, каждая фраза — у аватара рядом со своим местом (окно свёрнуто)
      const ss = sentences(data.reply);
      const steps = acts.map((a, i) => ({ action: a, text: i === acts.length - 1 ? ss.slice(i).join(' ') : ss[i] || '' }));
      await perform('tour', { steps });
    } else {
      say.text(data.reply);
      for (const a of acts) enqueue(a);
    }
  } catch (e) {
    history.pop();
    say.reset();
    say.show(`Не получилось: ${e.message}`, 'err');
  } finally {
    busyNow = false;
  }
}

// ── голосовой режим (Gemini Live) ───────────────────────────────────
const voice = { ws: null, micCtx: null, micStream: null, outCtx: null, analyser: null, gain: null, playAt: 0, turnStart: null, sources: new Set(), cur: null, raf: 0 };

// голос: дождаться, пока договорится уже полученная речь — только потом показывать следующее место,
// иначе указатель убегает вперёд слов (звук приходит быстрее, чем играет)
async function audioDrained(max = 25000) {
  const t = Date.now();
  while (voice.ws && voice.outCtx && audioNow() < voice.playAt - 0.12 && Date.now() - t < max) await sleep(80);
}

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
  if (voice.turnStart == null) voice.turnStart = voice.playAt; // отсюда зазвучит первое предложение ответа
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
    else if (m.t === 'out') say.feed(m.text, true); // слова пользователя ('in') не показываем
    else if (m.t === 'turn') {
      say.flush(true);
      voice.turnStart = null;
    } else if (m.t === 'interrupted') {
      stopPlayback();
      say.reset();
      voice.turnStart = null;
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

// подпись у аватара: во время показа — текущая фраза Аудитора, иначе — что он делает
function caption(html) {
  const c = $('.ai-pointer .ai-caption');
  c.innerHTML = html;
  c.hidden = !html;
}

// Режим показа: окно свёрнуто, аватар ходит по странице и подсвечивает то, о чём говорит; его фразы — подписью у аватара.
// Окно сворачивается на любой показ (подсветка, экскурсия, действие на сайте). Ответ словами — окно остаётся открытым:
// решает модель, показывать или нет (правила в server/assistant.js).
// Когда речь и действия закончились: указатель исчезает, окно возвращается.
let jobs = 0;
const hidePointer = () => {
  $('.ai-pointer').hidden = true;
  document.querySelectorAll('.ai-focus').forEach((x) => x.classList.remove('ai-focus'));
};
const present = {
  on: false,
  reopen: false,
  timer: 0,
  start() {
    clearTimeout(this.timer);
    if (this.on) return;
    this.on = true;
    this.reopen = !panel.hidden;
    // фраза, которую Аудитор произносит прямо сейчас, переезжает к аватару; старая — не должна мелькнуть
    const cur = sayBox.querySelector('.ai-line:not(.out)');
    caption(cur && (say.talking || cur.classList.contains('wait')) ? cur.innerHTML : '');
    panel.hidden = true;
    fab.hidden = false;
    root.classList.add('presenting');
  },
  idle(delay = 2500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const talking = say.talking || voice.sources.size;
      if (jobs || talking || busyNow) return this.idle(800);
      if (this.on) this.end();
      else hidePointer();
    }, delay);
  },
  end(open = this.reopen) {
    clearTimeout(this.timer);
    if (!this.on) return;
    this.on = false;
    root.classList.remove('presenting');
    hidePointer();
    if (open) {
      panel.hidden = false;
      fab.hidden = true;
    }
  },
};

async function pointTo(el, text) {
  if (!el) return;
  const top0 = el.getBoundingClientRect();
  // высокий блок целиком не влезет — показываем его начало; то, что уже на экране, не прокручиваем
  const tall = top0.height > window.innerHeight * 0.6;
  const inView = top0.top >= 64 && top0.bottom <= window.innerHeight - 16;
  if (!inView) {
    el.scrollIntoView({ behavior: 'smooth', block: tall ? 'start' : 'center' });
    // ждём, пока плавная прокрутка остановится, иначе координаты устаревшие
    let last = -1;
    for (let i = 0; i < 15; i++) {
      await sleep(70);
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - last) < 1) break;
      last = top;
    }
  }
  const r = el.getBoundingClientRect();
  const p = $('.ai-pointer');
  p.hidden = false;
  // своя подпись действия; без неё остаётся текущая фраза Аудитора
  if (text) caption(esc(text));
  else if (!present.on) caption('');
  // аватар — над левой частью элемента, подпись справа от него
  const x = Math.max(8, Math.min(window.innerWidth - 400, r.left + Math.min(r.width * 0.25, 160)));
  const y = Math.min(window.innerHeight - 120, Math.max(90, (tall ? Math.max(r.top, 70) : r.top) - 58));
  p.style.transform = `translate(${x}px, ${y}px)`;
  // подсветка переходит на новое место сразу, пока аватар летит (полёт — 0,7 с)
  document.querySelectorAll('.ai-focus').forEach((x) => x !== el && x.classList.remove('ai-focus'));
  el.classList.add('ai-focus');
  await sleep(350);
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
const recent = new Map(); // ключ действия → время: голосовая модель иногда повторяет ту же подсветку

// любое действие на экране идёт в общую очередь. kind: 'hidden' — ничего не показывает (снимок экрана),
// 'show' / 'tour' — Аудитор что-то подсвечивает: окно чата сворачивается, чтобы не закрывать страницу
function schedule(fn, kind = 'show') {
  jobs++;
  const job = chain.then(async () => {
    if (kind !== 'hidden') {
      clearTimeout(present.timer);
      // голос: сначала договариваем уже сказанное, потом переводим указатель — слова и подсветка совпадают
      if (voice.ws) await audioDrained();
      present.start();
    }
    try {
      return await fn();
    } finally {
      jobs--;
      present.idle();
    }
  });
  chain = job.catch(() => {});
  return job;
}

function enqueue(action) {
  const g = action.args || {};
  const key = [action.name, g.page, g.conversation_id, g.criterion_id, g.index, (g.conversation_ids || []).join(',')].join('|');
  if (Date.now() - (recent.get(key) || 0) < 15000) return;
  recent.set(key, Date.now());
  schedule(() => run(action)).catch((e) => console.warn('[assistant action]', action.name, e));
}

// шаг экскурсии — место на текущем экране (ref из снимка) или место в данных (диалог, критерий, реплика, раздел)
async function showStep(s) {
  if (s.action) {
    await run(s.action);
    return s.action.name;
  }
  if (s.ref) return (await act('highlight', { ref: s.ref }, pointTo)).error ? null : s.ref;
  const id = s.conversation_id;
  const step =
    id && s.criterion_id ? { name: 'point_at_criterion', args: { conversation_id: id, criterion_id: s.criterion_id } }
    : id && Number.isFinite(s.message_index) ? { name: 'point_at_message', args: { conversation_id: id, index: s.message_index } }
    : s.conversation_ids?.length ? { name: 'point_at_rows', args: { conversation_ids: s.conversation_ids } }
    : id ? { name: 'open_conversation', args: { conversation_id: id } }
    : s.page ? { name: 'open_page', args: { page: s.page } }
    : null;
  if (step) await run(step);
  return step ? step.name : 'text';
}

// экскурсия: аватар переходит к месту, подсвечивает его, и сразу идёт пояснение именно об этом месте.
// Следующее место — только когда пояснение дочитано/договорено.
async function tour(steps = []) {
  const shown = [];
  steps = steps.slice(0, 10);
  // все шаги — места одной страницы: идём сверху вниз, чтобы указатель не прыгал (текст остаётся при своём месте)
  if (steps.length > 1 && steps.every((s) => s.ref)) {
    const y = (s) => {
      const el = document.querySelector(`[data-ai-ref="${CSS.escape(String(s.ref))}"]`);
      return el ? el.getBoundingClientRect().top + window.scrollY : Infinity;
    };
    const x = (s) => document.querySelector(`[data-ai-ref="${CSS.escape(String(s.ref))}"]`)?.getBoundingClientRect().left ?? 0;
    steps = steps.map((s) => ({ s, y: Math.round(y(s) / 40), x: x(s) })).sort((a, b) => a.y - b.y || a.x - b.x).map((o) => o.s);
  }
  for (const s of steps) {
    if (!voice.ws) caption(''); // в полёте к новому месту старая фраза не висит рядом с ним
    const done = await showStep(s);
    if (!done) continue;
    shown.push(done);
    const text = plain(String(s.text || '')).trim();
    if (!text) continue;
    if (voice.ws) {
      // голосом пояснение произносит модель — держим место столько, сколько его обычно говорят
      await sleep(Math.max(1500, text.length * 60));
      continue;
    }
    say.reset();
    say.feed(text + ' ');
    say.flush();
    await sleep(100);
    while (say.talking) await sleep(80);
  }
  return shown.length
    ? { ok: `показано шагов: ${shown.length} (${shown.join(', ')}). Пользователь уже прочитал эти пояснения — в ответе их не повторяй, закончи одной короткой фразой.` }
    : { error: 'ни одно место не найдено — экран изменился. Вызови read_screen и повтори с новыми ref.' };
}

// действие на сайте (click, type_text, highlight, tour…): в общей очереди с показом, результат — модели
function perform(name, args = {}) {
  return schedule(
    async () => {
      try {
        if (name === 'tour') return await tour(args.steps);
        return await act(name, args, pointTo);
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    },
    name === 'read_screen' ? 'hidden' : name === 'tour' ? 'tour' : 'show',
  );
}

// предложения ответа — чтобы раздать их по местам, которые модель показала в одном ответе
const sentences = (t) => (plain(t).match(/[^.!?…]+(?:[.!?…]+["»)]*|$)/g) || []).map((x) => x.trim()).filter(Boolean);

// те же действия на экране доступны другим модулям (и для проверки без модели)
export { enqueue as showOnScreen, say as subtitles, perform as controlSite };
