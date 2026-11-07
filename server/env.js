// Загрузка .env без зависимостей. Значения из окружения процесса имеют приоритет.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    const value = raw.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8870),
  credentialsFile: (process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim(),
  vertexLocation: process.env.VERTEX_LOCATION || 'global',
  apiKey: (process.env.GEMINI_API_KEY || '').trim(),
  model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  // запасные модели на случай 429 (перегрузка общего пула Vertex), через запятую
  fallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.1-flash-lite').split(',').map((s) => s.trim()).filter(Boolean),
  priceInputPerM: num(process.env.PRICE_INPUT_PER_M, 0.25),
  priceOutputPerM: num(process.env.PRICE_OUTPUT_PER_M, 1.5),
  votes: Math.max(1, Math.min(5, num(process.env.EVAL_VOTES, 1))),
  concurrency: Math.max(1, Math.min(16, num(process.env.EVAL_CONCURRENCY, 3))),
  maxParallel: Math.max(1, Math.min(64, num(process.env.GEMINI_MAX_PARALLEL, 6))),
  mode: ['single', 'agents'].includes(process.env.EVAL_MODE) ? process.env.EVAL_MODE : 'agents',
  usePrecedents: process.env.USE_PRECEDENTS !== '0',
  orgApiUrl: (process.env.ORG_API_URL || '').trim(),
  dataDir: path.join(ROOT, 'data'),
};
