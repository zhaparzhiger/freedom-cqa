// Страница тренажёра для оператора: разбор ошибок → ролевая тренировка (чат или голос) → оценка «было / стало».
import { esc, fmt, toast, busy, answerLabel, answerTone, band, icon, logo, stateTag, critState } from './ui.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const view = document.getElementById('tr-view');
document.getElementById('brandMark').innerHTML = logo();
const api = async (method, path, body) => {
  const res = await fetch(`/api/train/${encodeURIComponent(token)}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
};

let info = null;
const ring = () => Array.from({ length: 28 }, (_, i) => `<i style="--k:${i};--h:${30 + ((i * 37) % 70)}%"></i>`).join('');

async function boot() {
  try {
    info = await api('GET', '');
  } catch (e) {
    view.innerHTML = `<div class="sheet empty"><b>Ссылка не работает</b>${esc(e.message)}</div>`;
    return;
  }
  document.getElementById('tr-sub').textContent = `Диалог ${info.conversationId}`;
  renderIntro();
}

// ── 1. разбор ошибок ─────────────────────────────────────────────────
function renderIntro() {
  const best = info.attempts.filter((a) => a.total != null).sort((a, b) => b.total - a.total)[0];
  const voiceOk = info.language !== 'KZ';
  view.innerHTML = `
    <header class="head"><div><span class="cap">Тренировка по реальному диалогу</span><h1>${esc(info.title)}</h1></div></header>
    <section class="score tr-hero">
      <div><span class="cap">Ваш балл в диалоге</span><div class="total">${fmt(info.originalTotal)}</div></div>
      <div class="secs">${best ? `<div><span>Лучшая тренировка</span><b>${fmt(best.total)}</b></div>` : ''}<div><span>Ошибок к разбору</span><b>${info.mistakes.length}</b></div><div><span>Попыток</span><b>${info.attempts.length}</b></div></div>
    </section>

    <section class="sheet tr-sec">
      <div class="sheet-h"><div><h2>Что пошло не так</h2><p>По оценке исходного диалога</p></div></div>
      ${info.mistakes.length ? `<ul class="tr-mistakes">${info.mistakes.map((m) => `
        <li><div class="tr-m-h"><b>${esc(m.name)}</b><span class="tag ${m.criterionId === 'c08' || /груб/i.test(m.name) ? 'bad' : 'mid'}">${esc(m.answer === 'yes' ? 'нарушение' : m.answer === 'no' ? 'Нет' : `${m.answer} баллов`)}</span></div>
        <p>${esc(m.explanation)}</p>
        ${m.advice ? `<div class="coach"><span class="cap">Как надо</span>${esc(m.advice)}</div>` : ''}</li>`).join('')}</ul>` : '<div class="empty">Ошибок не найдено — можно потренироваться для закрепления.</div>'}
    </section>

    <section class="incoming" data-call>
      <div class="who"><span class="ringer">${icon('call')}</span><div><h2>Пройдите этот диалог заново</h2><p>ИИ сыграет того же клиента с тем же вопросом. Коуч подскажет по ходу, а в конце диалог оценят по тому же чек-листу.</p></div></div>
      <div class="wave-ring" aria-hidden="true">${ring()}</div>
      <div class="tr-modes">
        <button class="btn lime big" data-start="text">${icon('chat')}Тренировка в чате</button>
        <button class="btn big tr-voice-btn" data-start="voice" ${voiceOk ? '' : 'disabled title="Голос пока доступен для русского и английского"'}>${icon('mic')}Голосом, как звонок</button>
      </div>
      ${voiceOk ? '' : '<p class="small">Голосовой режим для казахского языка пока не поддерживается — используйте чат.</p>'}
      <p class="small">Клиент сначала писал боту: «${esc(info.contextBeforeOperator)}»</p>
    </section>

    ${info.attempts.length ? `<section class="sheet tr-sec"><div class="sheet-h"><div><h2>Ваши попытки</h2></div></div><ul class="live">${info.attempts.map((a) => `
      <li><span>${a.mode === 'voice' ? 'Голос' : 'Чат'} · ${new Date(a.startedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      <b class="${a.total == null ? 'muted' : `c-${band(a.total)}`}">${a.total == null ? 'не завершена' : fmt(a.total)}</b></li>`).join('')}</ul></section>` : ''}`;
  view.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => start(b.dataset.start, b)));
}

async function start(mode, btn) {
  busy(btn, true, 'Готовлю…');
  try {
    const attempt = await api('POST', '/attempts', { mode });
    if (mode === 'voice') renderVoice(attempt);
    else renderChat(attempt);
  } catch (e) {
    toast(e.message, 'error');
    busy(btn, false);
  }
}

// ── 2а. чат ──────────────────────────────────────────────────────────
function bubble(m) {
  const who = m.speaker === 'operator' ? 'Вы' : m.speaker === 'client' ? 'ИИ-клиент' : 'Система';
  return `<div class="msg ${esc(m.speaker)}"><small><span>${who}</span>${m.timestamp ? `<span>${esc(m.timestamp)}</span>` : ''}</small><span class="msg-text">${esc(m.text)}</span></div>`;
}
const tipsHtml = (tips) =>
  tips?.length ? `<div class="tr-tips">${tips.map((t) => `<div class="tr-tip ${t.type === 'good' ? 'good' : 'warn'}">${t.type === 'good' ? icon('check') : icon('alert')}${esc(t.text)}</div>`).join('')}</div>` : '';

function chatHead(title, right) {
  return `<header class="head tr-chat-head"><div><a class="crumb" href="#" id="tr-back">${icon('left')}К разбору</a><h1>${esc(title)}</h1></div><div class="acts">${right}</div></header>`;
}

function renderChat(attempt) {
  view.innerHTML = `
    ${chatHead(info.title, `<button class="btn primary" id="tr-finish">${icon('check')}Завершить и оценить</button>`)}
    <section class="sheet tr-chat">
      <div class="sheet-h"><div><h2>Разговор</h2><p>Коуч подсказывает по ходу — зелёным то, что получилось, янтарным — что поправить</p></div></div>
      <div class="msgs" id="tr-msgs">${attempt.transcript.map(bubble).join('')}</div>
      <form class="composer" id="tr-form">
        <textarea class="textarea" name="text" rows="2" placeholder="Ваш ответ клиенту…  (Enter — отправить, Shift+Enter — новая строка)" required aria-label="Ваш ответ"></textarea>
        <button class="btn primary" type="submit" aria-label="Отправить">${icon('send')}</button>
      </form>
    </section>`;
  const msgs = view.querySelector('#tr-msgs');
  const scroll = () => (msgs.scrollTop = msgs.scrollHeight);
  scroll();
  const form = view.querySelector('#tr-form');
  const ta = form.querySelector('textarea');
  ta.focus();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    msgs.insertAdjacentHTML('beforeend', bubble({ speaker: 'operator', text, timestamp: '' }));
    msgs.insertAdjacentHTML('beforeend', '<div class="tr-typing" id="tr-typing"><span class="spinner"></span> Клиент печатает…</div>');
    scroll();
    const btn = e.submitter;
    busy(btn, true, '');
    try {
      const r = await api('POST', `/attempts/${attempt.id}/message`, { text });
      view.querySelector('#tr-typing')?.remove();
      msgs.insertAdjacentHTML('beforeend', tipsHtml(r.tips) + r.added.map(bubble).join(''));
      scroll();
      if (r.finished) toast('Клиент завершил разговор — можно получить оценку', 'ok');
    } catch (err) {
      view.querySelector('#tr-typing')?.remove();
      toast(err.message, 'error');
    } finally {
      busy(btn, false);
      ta.focus();
    }
  });
  view.querySelector('#tr-back').addEventListener('click', (e) => {
    e.preventDefault();
    boot();
  });
  view.querySelector('#tr-finish').addEventListener('click', (e) => finish(attempt, e.currentTarget));
}

// ── 2б. голос (Gemini Live) ─────────────────────────────────────────
function renderVoice(attempt) {
  view.innerHTML = `
    ${chatHead(info.title, '')}
    <section class="incoming tr-call">
      <div class="who"><span class="ringer">${icon('call')}</span><div><h2 id="tr-state">Нажмите «Позвонить» и поздоровайтесь</h2><p>Клиент ждёт вашего приветствия. Нужен микрофон, разговор длится до 6 минут.</p></div></div>
      <div class="tr-level" aria-hidden="true"><span id="tr-level"></span></div>
      <div class="tr-modes">
        <button class="btn lime big" id="tr-call">${icon('call')}Позвонить</button>
        <button class="btn big tr-voice-btn" id="tr-hang" disabled>${icon('stop')}Положить трубку</button>
      </div>
    </section>
    <section class="sheet tr-chat tr-chat-voice">
      <div class="sheet-h"><div><h2>Расшифровка</h2><p>По ней коуч даёт подсказки, а в конце звонок оценят</p></div><button class="btn primary sm" id="tr-finish" disabled>${icon('check')}Получить оценку звонка</button></div>
      <div class="msgs" id="tr-msgs"></div>
    </section>`;
  const msgs = view.querySelector('#tr-msgs');
  const state = view.querySelector('#tr-state');
  let ws = null;
  let micCtx = null;
  let micStream = null;
  let outCtx = null;
  let playAt = 0;
  const sources = new Set();
  let cur = { speaker: null, el: null };

  const line = (speaker, text) => {
    if (cur.speaker !== speaker || !cur.el) {
      msgs.insertAdjacentHTML('beforeend', bubble({ speaker, text: '', timestamp: '' }));
      cur = { speaker, el: msgs.lastElementChild.querySelector('.msg-text') };
    }
    cur.el.textContent += text;
    msgs.scrollTop = msgs.scrollHeight;
  };
  const playPcm = (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);
    const buf = outCtx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(outCtx.destination);
    playAt = Math.max(playAt, outCtx.currentTime + 0.03);
    src.start(playAt);
    playAt += buf.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
  };
  const stopPlayback = () => {
    sources.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    sources.clear();
    playAt = 0;
  };
  const hangup = () => {
    try {
      ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'bye' }));
    } catch {}
    micStream?.getTracks().forEach((t) => t.stop());
    micCtx?.close().catch(() => {});
    if (!view.contains(state)) return; // экран уже сменился
    view.querySelector('#tr-call').disabled = false;
    view.querySelector('#tr-hang').disabled = true;
    view.querySelector('#tr-finish').disabled = !msgs.querySelector('.msg.operator');
    view.querySelector('.tr-call')?.classList.remove('live');
    state.textContent = 'Звонок завершён. Можно получить оценку или позвонить ещё раз.';
  };

  view.querySelector('#tr-call').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      toast('Нет доступа к микрофону — разрешите его в браузере', 'error');
      btn.disabled = false;
      return;
    }
    outCtx ||= new AudioContext({ sampleRate: 24000 });
    await outCtx.resume();
    micCtx = new AudioContext();
    await micCtx.audioWorklet.addModule('/js/mic-worklet.js');
    const node = new AudioWorkletNode(micCtx, 'cqa-mic');
    micCtx.createMediaStreamSource(micStream).connect(node);
    const level = view.querySelector('#tr-level');
    state.textContent = 'Соединяю…';
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/train/${encodeURIComponent(token)}/live?attempt=${attempt.id}`);
    ws.binaryType = 'arraybuffer';
    node.port.onmessage = ({ data }) => {
      level.style.width = `${Math.min(100, data.rms * 400)}%`;
      if (ws.readyState === 1) ws.send(data.pcm);
    };
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.t === 'ready') {
        state.innerHTML = '<span class="ok">● На линии.</span> Говорите — клиент слышит вас.';
        view.querySelector('.tr-call')?.classList.add('live');
        view.querySelector('#tr-hang').disabled = false;
      } else if (m.t === 'audio') playPcm(m.d);
      else if (m.t === 'in') line('operator', m.text);
      else if (m.t === 'out') line('client', m.text);
      else if (m.t === 'interrupted') stopPlayback();
      else if (m.t === 'system') {
        msgs.insertAdjacentHTML('beforeend', bubble({ speaker: 'system', text: m.text }));
        cur = { speaker: null, el: null };
      } else if (m.t === 'tips') {
        msgs.insertAdjacentHTML('beforeend', tipsHtml(m.tips));
        cur = { speaker: null, el: null };
        msgs.scrollTop = msgs.scrollHeight;
      } else if (m.t === 'error') toast(m.error, 'error');
      else if (m.t === 'limit') toast('Время звонка вышло', 'info');
      else if (m.t === 'closed') hangup();
    };
    ws.onclose = () => hangup();
  });
  view.querySelector('#tr-hang').addEventListener('click', hangup);
  view.querySelector('#tr-back').addEventListener('click', (e) => {
    e.preventDefault();
    hangup();
    boot();
  });
  view.querySelector('#tr-finish').addEventListener('click', (e) => finish(attempt, e.currentTarget));
}

// ── 3. результат ────────────────────────────────────────────────────
async function finish(attempt, btn) {
  busy(btn, true, 'ИИ оценивает…');
  try {
    const r = await api('POST', `/attempts/${attempt.id}/finish`);
    renderResult(r.attempt, r.originalTotal);
  } catch (e) {
    toast(e.message, 'error');
    busy(btn, false);
  }
}

function renderResult(a, before) {
  const res = a.result;
  const delta = res.total != null && before != null ? res.total - before : null;
  view.innerHTML = `
    <header class="head"><div><span class="cap">Результат тренировки</span><h1>${esc(info.title)}</h1></div></header>
    <section class="score tr-hero">
      <div><span class="cap">Стало на тренировке</span><span class="was">было ${fmt(before)}</span><div class="total">${fmt(res.total)}</div>
        ${delta != null ? `<div class="verdict">${icon(delta >= 0 ? 'check' : 'alert')}${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))} к исходному диалогу</div>` : ''}</div>
      <div class="secs"><div><span>Было в диалоге</span><b>${fmt(before)}</b></div><div><span>Стало</span><b>${fmt(res.total)}</b></div></div>
      ${res.grossError ? `<div class="crit-note">${icon('alert')}На тренировке допущена грубая ошибка</div>` : ''}
    </section>
    <section class="sheet tr-sec">
      <div class="sheet-h"><div><h2>По критериям</h2><p>Тот же чек-лист, что и у исходного диалога</p></div></div>
      ${res.checklist.criteria.map((c, i) => {
        const it = res.items.find((x) => x.criterionId === c.id);
        if (!it) return '';
        const fixed = info.mistakes.some((m) => m.criterionId === c.id) && answerTone(c, it.answer) === 'good';
        return `<div class="cr ${critState(c, it.answer)} on"><div class="cr-h" role="presentation"><span class="cr-code">C${i + 1}</span><span class="cr-name">${esc(c.name)}${fixed ? '<small class="fixed">исправлено</small>' : ''}</span><span class="tag ${stateTag(critState(c, it.answer))}">${esc(answerLabel(c, it.answer))}</span><span></span><span></span></div>
          <div class="cr-b"><p class="why">${esc(it.explanation)}</p>${it.advice ? `<div class="coach"><span class="cap">Совет</span>${esc(it.advice)}</div>` : ''}</div></div>`;
      }).join('')}
    </section>
    <div class="tr-modes tr-end">
      <button class="btn primary big" id="tr-again">${icon('refresh')}Ещё раз</button>
      <button class="btn big" id="tr-intro">К разбору</button>
    </div>`;
  view.querySelector('#tr-again').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    info = await api('GET', '');
    start(a.mode, btn);
  });
  view.querySelector('#tr-intro').addEventListener('click', boot);
}

boot();
