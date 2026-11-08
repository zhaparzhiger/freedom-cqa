// Голосовой режим ассистента «Аудитор» через Gemini Live.
// Браузер ↔ WebSocket ↔ Live-сессия. Модель слушает микрофон, отвечает голосом и вызывает те же инструменты,
// что и текстовый ассистент: данные считаются на сервере, команды интерфейса уходят в браузер и выполняются там.
import fs from 'node:fs';
import { GoogleGenAI, Modality, StartSensitivity } from '@google/genai';
import { config } from './env.js';
import { TOOLS, SYSTEM, dataTools, UI_TOOLS, CLIENT_TOOLS } from './assistant.js';

// названия Live-моделей у Vertex и у Google AI Studio разные
const LIVE_MODEL = process.env.LIVE_MODEL || (config.credentialsFile ? 'gemini-live-2.5-flash-native-audio' : 'gemini-3.1-flash-live-preview');
const LIVE_LOCATION = process.env.LIVE_LOCATION || 'europe-west1';
const VOICE = process.env.ASSISTANT_VOICE || 'Charon';
const MAX_MS = 10 * 60_000;

let client = null;
function live() {
  if (client) return client;
  if (config.credentialsFile) {
    const project = JSON.parse(fs.readFileSync(config.credentialsFile, 'utf8')).project_id;
    client = new GoogleGenAI({ vertexai: true, project, location: LIVE_LOCATION });
  } else if (config.apiKey) client = new GoogleGenAI({ apiKey: config.apiKey });
  else throw new Error('Голосовой режим не настроен');
  return client;
}

// Голос один на все сессии: тембр задаёт VOICE, а манеру речи — эта инструкция. Она идёт первой:
// нативная аудиомодель сильнее всего держится начала инструкции и без неё «плавает» в акценте и интонации.
const VOICE_PERSONA = `МАНЕРА РЕЧИ — ОДНА И ТА ЖЕ ВСЕГДА:
Ты говоришь одним постоянным голосом: спокойный, уверенный взрослый мужчина, деловой диктор. Ровный темп, ровная интонация, чёткая дикция.
По-русски — чистое литературное (московское) произношение без какого-либо регионального или иностранного акцента: не украинский, не среднеазиатский, не кавказский, не прибалтийский — нейтральный, как у диктора федерального телеканала.
По-казахски — чистое естественное казахское произношение. По-английски — нейтральный американский (General American).
Не подражай акценту, тембру и манере собеседника. Не меняй голос, высоту, темп и интонацию между репликами и в течение сессии. Не пой, не играй ролей, не изображай эмоции голосом.`;

const VOICE_RULES = `
Ты разговариваешь ГОЛОСОМ в реальном времени. Ты — ИИ-ассистент «Аудитор», а не реальный человек: не называй себя чужим именем и не говори от лица руководителей компании.
Говори живо и уверенно, как опытный руководитель контроля качества: 1–3 коротких предложения, без списков и markdown.
Говори на том языке, на котором к тебе обратились последней фразой: по-казахски — отвечай по-казахски, по-английски — по-английски, на другом языке — на нём. Приветствие в начале — по-русски, дальше подстраивайся под собеседника.
Номера диалогов произноси коротко («восемнадцатый русский диалог»), id критериев вслух не называй — называй критерий словами.
Показ голосом: решай по тем же правилам «показывать или ответить словами». Большинство вопросов голосом — просто ответь голосом, ничего не показывая. Показ сворачивает окно чата.
— Если показываешь: сначала вызови показ места (highlight, point_at_rows, point_at_criterion, point_at_message, open_page), потом говори ровно об этом месте. О следующем месте не говори, пока не вызвал его показ: указатель переходит, когда ты договоришь предыдущее. Вместо tour показывай места по одному.
Когда просят что-то сделать на сайте — делай сам через read_screen и click/type_text/select_option, а вслух коротко комментируй («Открываю апелляции», «Ввожу поиск»). Подтверждение для действий с пометкой [нужно подтверждение] спрашивай голосом и жди явного согласия.
Объясняя страницу голосом, tour не используй: вызови read_screen, затем по очереди highlight каждого блока (b…) сверху вниз и после каждого скажи о нём одну-две фразы — только то, что в подписи этого блока. Так указатель движется по странице вместе с речью.
Если тебя перебили — остановись и ответь на новый вопрос.`;

export async function handleAssistantLive(ws, initialRoute) {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  let session = null;
  let closed = false;
  let route = initialRoute || '#/';

  const finish = () => {
    if (closed) return;
    closed = true;
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

  // действия на сайте выполняет браузер: ждём его ответ (результат и новый снимок экрана)
  const waiting = new Map();
  let seq = 0;
  const askBrowser = (name, args) =>
    new Promise((resolve) => {
      const id = `u${++seq}`;
      const t = setTimeout(() => {
        waiting.delete(id);
        resolve({ error: 'браузер не ответил вовремя' });
      }, 60_000); // окно подтверждения в браузере может висеть, пока пользователь думает
      waiting.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      send({ t: 'ui_call', id, name, args });
    });

  const onToolCall = async (calls) => {
    const functionResponses = await Promise.all(calls.map(async (fc) => {
      let response;
      if (CLIENT_TOOLS.has(fc.name)) {
        response = await askBrowser(fc.name, fc.args || {});
      } else if (UI_TOOLS.has(fc.name)) {
        send({ t: 'ui', name: fc.name, args: fc.args || {} });
        response = { result: 'показано на экране; продолжай говорить, не повторяй сказанное' };
      } else if (dataTools[fc.name]) {
        send({ t: 'tool', name: fc.name });
        try {
          response = { result: dataTools[fc.name](fc.args || {}) };
        } catch (e) {
          response = { error: e.message };
        }
      } else response = { error: 'нет такого инструмента' };
      return { id: fc.id, name: fc.name, response };
    }));
    if (!closed) session.sendToolResponse({ functionResponses });
  };

  try {
    session = await live().live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: VOICE_PERSONA + '\n\n' + SYSTEM + '\n' + VOICE_RULES,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        // меньше случайности — голос и интонация не «гуляют» от ответа к ответу
        temperature: 0.5,
        tools: [{ functionDeclarations: TOOLS }],
        // без подсказки языков распознавание путает русский с другими языками
        // подсказка языков распознавания есть только у Vertex
        inputAudioTranscription: config.credentialsFile ? { languageCodes: ['ru-RU', 'kk-KZ'] } : {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        // фон и стук не должны обрывать ответ: низкая чувствительность к началу речи
        realtimeInputConfig: {
          automaticActivityDetection: { startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW, prefixPaddingMs: 300, silenceDurationMs: 700 },
        },
      },
      callbacks: {
        onmessage: (m) => {
          const sc = m.serverContent;
          if (sc?.modelTurn?.parts) for (const p of sc.modelTurn.parts) if (p.inlineData?.data) send({ t: 'audio', d: p.inlineData.data });
          if (sc?.inputTranscription?.text) send({ t: 'in', text: sc.inputTranscription.text });
          if (sc?.outputTranscription?.text) send({ t: 'out', text: sc.outputTranscription.text });
          if (sc?.interrupted) send({ t: 'interrupted' });
          if (sc?.turnComplete) send({ t: 'turn' });
          if (m.toolCall?.functionCalls?.length) onToolCall(m.toolCall.functionCalls).catch((e) => console.error('[assistant live tool]', e?.message || e));
        },
        onerror: (e) => {
          console.error('[assistant live]', e?.message || e);
          send({ t: 'error', error: 'Связь с голосом прервалась' });
          finish();
        },
        onclose: () => finish(),
      },
    });
  } catch (e) {
    console.error('[assistant live connect]', e?.message || e);
    send({ t: 'error', error: `Голосовой режим недоступен: ${String(e?.message || e).slice(0, 160)}` });
    return finish();
  }

  send({ t: 'ready', limitSeconds: MAX_MS / 1000 });
  // ассистент начинает разговор сам — коротко, с одним предложением
  session.sendClientContent({
    turns: [{ role: 'user', parts: [{ text: `(Служебное: руководитель КК открыл голосовой режим, на экране ${route}. Поздоровайся одной живой фразой и предложи одну конкретную вещь — например, показать худшего оператора недели. Ничего не показывай на экране, пока не спросят.)` }] }],
    turnComplete: true,
  });

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
    if (msg.t === 'text' && msg.text) session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: String(msg.text).slice(0, 2000) }] }], turnComplete: true });
    else if (msg.t === 'ui_result' && waiting.has(msg.id)) {
      const done = waiting.get(msg.id);
      waiting.delete(msg.id);
      done(msg.result && typeof msg.result === 'object' ? msg.result : { error: 'пустой ответ браузера' });
    } else if (msg.t === 'route') route = String(msg.route || route);
    else if (msg.t === 'bye') finish();
  });
}
