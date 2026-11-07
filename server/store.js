// Хранилище в одном JSON-файле: для прототипа этого достаточно, данные видны глазами и легко переносятся.
// Запись атомарная (через временный файл), чтобы при падении процесса файл не повредился.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './env.js';
import { defaultChecklist } from './checklist-default.js';

const DB_FILE = path.join(config.dataDir, 'db.json');

const empty = () => ({
  checklists: [],
  activeChecklistId: null,
  conversations: {},
  evaluations: [],
  appeals: [],
});

let db = empty();

export function load() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    db = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  }
  if (!db.checklists.length) {
    const cl = { ...defaultChecklist(), id: newId('cl'), createdAt: now(), updatedAt: now() };
    db.checklists.push(cl);
    db.activeChecklistId = cl.id;
    save();
  }
  return db;
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 50);
}

export function flush() {
  clearTimeout(saveTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

export const getDb = () => db;
export const now = () => new Date().toISOString();
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
