// Страница тренажёра для оператора: разбор ошибок → ролевая тренировка (чат или голос) → оценка «было / стало».
import { esc, fmt, toast, busy, answerLabel, answerTone, scoreTone } from './ui.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const view = document.getElementById('tr-view');
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

async function boot() {
  try {
    info = await api('GET', '');
  } catch (e) {
    view.innerHTML = `<div class="empty"><h2>Ссылка не работает</h2><p>${esc(e.message)}</p></div>`;
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
    <section class="tr-hero panel">
      <div class="tiny muted">Тренировка по реальному диалогу</div>
      <h1>${esc(info.title)}</h1>
      <div class="tr-scores">
        <div><div class="tiny muted">Ваш балл в диалоге</div><div class="score-big ${scoreTone(info.originalTotal)}">${fmt(info.originalTotal)}<small>/100</small></div></div>
        ${best ? `<div><div class="tiny muted">Лучшая тренировка</div><div class="score-big ${scoreTone(best.total)}">${fmt(best.total)}<small>/100</small></div></div>` : ''}
      </div>
    </section>

    <h2 class="tr-h">Что пошло не так</h2>
    ${info.mistakes.length ? `<div class="tr-mistakes">${info.mistakes.map((m) => `
      <article class="panel tr-mistake">
        <div class="tr-mistake-head"><b>${esc(m.name)}</b><span class="tag ${m.criterionId === 'c08' || /груб/i.test(m.name) ? 'bad' : 'mid'}">${esc(m.answer === 'yes' ? 'нарушение' : m.answer === 'no' ? 'Нет' : `${m.answer} баллов`)}</span></div>
        <p>${esc(m.explanation)}</p>
        ${m.advice ? `<p class="advice"><b>Как надо:</b> ${esc(m.advice)}</p>` : ''}
      </article>`).join('')}</div>` : '<p class="muted">Ошибок не найдено — можно потренироваться для закрепления.</p>'}

    <section class="panel tr-start">
      <h2>Пройдите этот диалог заново</h2>
      <p class="muted">ИИ сыграет того же клиента с тем же вопросом. Коуч подскажет по ходу, а в конце диалог оценят по тому же чек-листу.</p>
      <div class="tr-modes">
        <button class="btn primary" data-start="text">💬 Тренировка в чате</button>
        <button class="btn" data-start="voice" ${voiceOk ? '' : 'disabled title="Голос пока доступен для русского и английского"'}>🎙 Голосом, как звонок</button>
      </div>
      ${voiceOk ? '' : '<p class="tiny muted">Голосовой режим для казахского языка пока не поддерживается — используйте чат.</p>'}
      <p class="tiny muted">Клиент сначала писал боту: «${esc(info.contextBeforeOperator)}»</p>
    </section>

    ${info.attempts.length ? `<h2 class="tr-h">Ваши попытки</h2><div class="tr-attempts">${info.attempts.map((a) => `
      <div class="panel tr-attempt"><span>${a.mode === 'voice' ? '🎙 Голос' : '💬 Чат'} · ${new Date(a.startedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      <b class="score ${scoreTone(a.total)}">${a.total == null ? 'не завершена' : fmt(a.total)}</b></div>`).join('')}</div>` : ''}`;
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
  return `<div class="msg msg-${esc(m.speaker)}"><div class="msg-meta"><span class="msg-role">${m.speaker === 'operator' ? 'Вы' : m.speaker === 'client' ? 'Клиент' : 'Система'}</span><span class="msg-time">${esc(m.timestamp || '')}</span></div><div class="msg-text">${esc(m.text)}</div></div>`;
}
const tipsHtml = (tips) =>
  tips?.length ? `<div class="tr-tips">${tips.map((t) => `<div class="tr-tip ${t.type}">${t.type === 'good' ? '✓' : '!'} ${esc(t.text)}</div>`).join('')}</div>` : '';

function renderChat(attempt) {
  view.innerHTML = `
    <div class="tr-chat-wrap">
      <div class="tr-chat-head">
        <button class="btn small ghost" id="tr-back">← Разбор</button>
        <b>${esc(info.title)}</b>
        <button class="btn small primary" id="tr-finish">Завершить и оценить</button>
      </div>
      <div class="tr-chat panel">
        <div class="transcript" id="tr-msgs">${attempt.transcript.map(bubble).join('')}</div>
        <form class="tr-input" id="tr-form">
          <textarea name="text" rows="2" placeholder="Ваш ответ клиенту…  (Enter — отправить, Shift+Enter — новая строка)" required></textarea>
          <button class="btn primary" type="submit">Отправить</button>
        </form>
      </div>
    </div>`;
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
    msgs.insertAdjacentHTML('beforeend', '<div class="tr-typing muted tiny" id="tr-typing">Клиент печатает…</div>');
    scroll();
    const btn = e.submitter;
    busy(btn, true, '…');
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
  view.querySelector('#tr-back').addEventListener('click', () => boot());
  view.querySelector('#tr-finish').addEventListener('click', (e) => finish(attempt, e.currentTarget));
}

// ── 2б. голос (Gemini Live) ─────────────────────────────────────────
function renderVoice(attempt) {
  view.innerHTML = `
    <div class="tr-voice">
      <div class="tr-chat-head">
        <button class="btn small ghost" id="tr-back">← Разбор</button>
        <b>${esc(info.title)}</b>
        <span></span>
      </div>
      <section class="panel tr-call">
        <div class="tr-call-state" id="tr-state">Нажмите «Позвонить» и поздоровайтесь — клиент ждёт вашего приветствия.</div>
        <div class="tr-level"><span id="tr-level"></span></div>
        <div class="tr-modes">
          <button class="btn primary" id="tr-call">📞 Позвонить</button>
          <button class="btn" id="tr-hang" disabled>Положить трубку</button>
        </div>
        <p class="tiny muted">Нужен микрофон. Разговор длится до 6 минут. Расшифровка ниже — по ней коуч даёт подсказки, а в конце звонок оценят.</p>
      </section>
      <div class="tr-chat panel"><div class="transcript" id="tr-msgs"></div></div>
      <button class="btn primary tr-finish-voice" id="tr-finish" disabled>Получить оценку звонка</button>
    </div>`;
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
    view.querySelector('#tr-call').disabled = false;
    view.querySelector('#tr-hang').disabled = true;
    view.querySelector('#tr-finish').disabled = !msgs.querySelector('.msg-operator');
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
        state.innerHTML = '<b class="good-text">● На линии.</b> Говорите — клиент слышит вас.';
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
  view.querySelector('#tr-back').addEventListener('click', () => {
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
    <section class="panel tr-hero">
      <div class="tiny muted">Результат тренировки</div>
      <div class="tr-scores">
        <div><div class="tiny muted">Было в диалоге</div><div class="score-big ${scoreTone(before)}">${fmt(before)}</div></div>
        <div class="tr-arrow">→</div>
        <div><div class="tiny muted">Стало на тренировке</div><div class="score-big ${scoreTone(res.total)}">${fmt(res.total)}</div></div>
        ${delta != null ? `<div class="tag ${delta >= 0 ? 'good' : 'bad'} big">${delta >= 0 ? '+' : ''}${fmt(delta)}</div>` : ''}
      </div>
      ${res.grossError ? '<p class="tag bad big">⚠ На тренировке допущена грубая ошибка</p>' : ''}
    </section>
    <div class="criteria">
      ${res.checklist.criteria.map((c) => {
        const it = res.items.find((i) => i.criterionId === c.id);
        if (!it) return '';
        const fixed = info.mistakes.some((m) => m.criterionId === c.id) && answerTone(c, it.answer) === 'good';
        return `<article class="crit">
          <header class="crit-head"><div class="crit-name">${esc(c.name)}${fixed ? ' <span class="tag good">исправлено</span>' : ''}</div>
          <span class="answer ${answerTone(c, it.answer)}">${esc(answerLabel(c, it.answer))}</span></header>
          <p class="crit-expl">${esc(it.explanation)}</p>
          ${it.advice ? `<p class="advice"><b>Совет:</b> ${esc(it.advice)}</p>` : ''}
        </article>`;
      }).join('')}
    </div>
    <div class="tr-modes tr-end">
      <button class="btn primary" id="tr-again">Ещё раз</button>
      <button class="btn" id="tr-intro">К разбору</button>
    </div>`;
  view.querySelector('#tr-again').addEventListener('click', async (e) => {
    info = await api('GET', '');
    start(a.mode, e.currentTarget);
  });
  view.querySelector('#tr-intro').addEventListener('click', boot);
}

boot();
