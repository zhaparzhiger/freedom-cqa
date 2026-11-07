// Голосовая тренировка через Gemini Live (Vertex AI): браузер ↔ наш WebSocket ↔ Live-сессия.
// ИИ-клиент говорит голосом, обе стороны расшифровываются — расшифровка идёт коучу и в итоговую оценку.
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, StartSensitivity } from '@google/genai';
import { config } from './env.js';
import { save, now } from './store.js';
import { findTraining, getAttempt, clientSystemPrompt, coachTips } from './training.js';
import { handleAssistantLive } from './assistant-live.js';

const LIVE_MODEL = process.env.LIVE_MODEL || 'gemini-live-2.5-flash-native-audio';
const LIVE_LOCATION = process.env.LIVE_LOCATION || 'europe-west1';
const MAX_MS = 6 * 60_000;

let client = null;
function live() {
  if (client) return client;
  if (config.credentialsFile) {
    const project = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8')).project_id;
    client = new GoogleGenAI({ vertexai: true, project, location: LIVE_LOCATION });
  } else if (config.apiKey) {
    client = new GoogleGenAI({ apiKey: config.apiKey });
  } else throw new Error('Голосовой режим не настроен');
  return client;
}

const clock = (startedAt) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function attachLive(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    // голос ассистента «Аудитор»
    if (req.url.startsWith('/api/assistant/live')) {
      const route = new URL(req.url, 'http://x').searchParams.get('route') || '#/';
      return wss.handleUpgrade(req, socket, head, (ws) => handleAssistantLive(ws, route));
    }
    // голосовая тренировка оператора
    const m = req.url.match(/^\/api\/train\/([^/]+)\/live\?attempt=([^&]+)/);
    if (!m) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, decodeURIComponent(m[1]), decodeURIComponent(m[2])));
  });
}

async function handle(ws, token, attemptId) {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const t = findTraining(token);
  let a;
  try {
    if (!t) throw new Error('Тренировка не найдена');
    a = getAttempt(t, attemptId);
  } catch (e) {
    send({ t: 'error', error: e.message });
    return ws.close();
  }

  let session = null;
  let closed = false;
  let heard = ''; // оператор (вход)
  let said = ''; // ИИ-клиент (выход)
  let identityAnnounced = false;

  const flushHeard = () => {
    const text = heard.trim();
    heard = '';
    if (!text) return;
    a.transcript.push({ timestamp: clock(a.startedAt), speaker: 'operator', text });
    save();
    // подсказки коуча по только что сказанной реплике — не задерживают разговор
    const snapshot = [...a.transcript];
    coachTips(t, snapshot)
      .then((tips) => {
        a.coach.push({ afterIndex: snapshot.length - 1, tips });
        save();
        send({ t: 'tips', tips });
      })
      .catch(() => {});
    // голосом нельзя «нажать кнопку» проверки личности — система подтверждает, когда оператор её запросил
    if (t.scenario.needs_identification && !identityAnnounced && /(подтверд|идентифик|верифик|личност|verify|identity)/i.test(text)) {
      identityAnnounced = true;
      a.transcript.push({ timestamp: clock(a.startedAt), speaker: 'system', text: 'Личность клиента подтверждена.' });
      send({ t: 'system', text: 'Личность клиента подтверждена.' });
      session?.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '(Служебное: система подтвердила личность клиента.)' }] }], turnComplete: false });
    }
  };
  const flushSaid = () => {
    const text = said.trim();
    said = '';
    if (!text) return;
    a.transcript.push({ timestamp: clock(a.startedAt), speaker: 'client', text });
    save();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    flushHeard();
    flushSaid();
    try {
      session?.close();
    } catch {}
    send({ t: 'closed' });
    try {
      ws.close();
    } catch {}
  };
  const timer = setTimeout(() => {
    send({ t: 'limit' });
    finish();
  }, MAX_MS);
  ws.on('close', () => {
    clearTimeout(timer);
    finish();
  });

  const lang = t.scenario.language === 'EN' ? 'en-US' : t.scenario.language === 'KZ' ? 'kk-KZ' : 'ru-RU';
  try {
    session = await live().live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction:
          clientSystemPrompt(t) +
          '\nЭто ТЕЛЕФОННЫЙ ЗВОНОК в поддержку. Оператор говорит первым — дождись его приветствия, затем коротко изложи свой вопрос. Говори живо, как обычный человек по телефону, без списков.',
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        inputAudioTranscription: { languageCodes: [lang, 'ru-RU'].filter((v, i, s) => s.indexOf(v) === i) },
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: { startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW, prefixPaddingMs: 300, silenceDurationMs: 800 },
        },
      },
      callbacks: {
        onmessage: (m) => {
          const sc = m.serverContent;
          if (sc?.modelTurn?.parts) for (const p of sc.modelTurn.parts) if (p.inlineData?.data) send({ t: 'audio', d: p.inlineData.data });
          if (sc?.inputTranscription?.text) {
            if (said) flushSaid();
            heard += sc.inputTranscription.text;
            send({ t: 'in', text: sc.inputTranscription.text });
          }
          if (sc?.outputTranscription?.text) {
            if (heard) flushHeard();
            said += sc.outputTranscription.text;
            send({ t: 'out', text: sc.outputTranscription.text });
          }
          if (sc?.interrupted) send({ t: 'interrupted' });
          if (sc?.turnComplete) {
            flushSaid();
            send({ t: 'turn' });
          }
        },
        onerror: (e) => {
          console.error('[live]', e?.message || e);
          send({ t: 'error', error: 'Связь с голосовым сервисом прервалась' });
          finish();
        },
        onclose: () => finish(),
      },
    });
  } catch (e) {
    console.error('[live connect]', e?.message || e);
    send({ t: 'error', error: `Голосовой режим недоступен: ${String(e?.message || e).slice(0, 160)}` });
    return finish();
  }
  a.liveStartedAt = now();
  send({ t: 'ready', limitSeconds: MAX_MS / 1000 });

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      session.sendRealtimeInput({ audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'bye') finish();
    else if (msg.t === 'mic-off') session.sendRealtimeInput({ audioStreamEnd: true });
  });
}
