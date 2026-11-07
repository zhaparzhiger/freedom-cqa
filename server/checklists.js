// Проверка конфигурации чек-листа перед сохранением.
import { CRITERION_TYPES } from './checklist-default.js';

const fail = (msg) => {
  const e = new Error(msg);
  e.status = 400;
  throw e;
};

export function nextCriterionId(criteria) {
  const nums = criteria.map((c) => Number(String(c.id || '').replace(/^c/, ''))).filter((n) => Number.isInteger(n));
  return `c${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
}

export function validateChecklist(cl) {
  if (!String(cl.name || '').trim()) fail('У чек-листа нет названия');
  if (!Array.isArray(cl.criteria) || !cl.criteria.length) fail('В чек-листе нет критериев');
  const ids = new Set();
  const sectionIds = new Set((cl.sections || []).map((s) => s.id));
  for (const c of cl.criteria) {
    const label = `Критерий «${c.name || c.id}»`;
    if (!/^[a-z][a-z0-9_]{0,30}$/i.test(c.id || '')) fail(`${label}: некорректный идентификатор`);
    if (ids.has(c.id)) fail(`${label}: идентификатор ${c.id} повторяется`);
    ids.add(c.id);
    if (!String(c.name || '').trim()) fail(`Критерий ${c.id}: нет названия`);
    if (!CRITERION_TYPES.includes(c.type)) fail(`${label}: неизвестный тип ${c.type}`);
    c.weight = Number(c.weight) || 0;
    if (c.weight < 0) fail(`${label}: вес не может быть отрицательным`);
    if (c.type === 'flag') {
      c.weight = 0;
      c.naAllowed = false;
    }
    if (c.type === 'scale') {
      if (!Array.isArray(c.scale) || c.scale.length < 2) fail(`${label}: у шкалы должно быть минимум две ступени`);
      c.scale = c.scale.map((s) => ({ value: Number(s.value), label: String(s.label || '') }));
      if (c.scale.some((s) => Number.isNaN(s.value) || s.value < 0)) fail(`${label}: ступени шкалы должны быть неотрицательными числами`);
      if (new Set(c.scale.map((s) => s.value)).size !== c.scale.length) fail(`${label}: ступени шкалы повторяются`);
      if (Math.max(...c.scale.map((s) => s.value)) <= 0) fail(`${label}: верхняя ступень шкалы должна быть больше нуля`);
    } else {
      c.scale = [];
    }
    if (c.section && sectionIds.size && !sectionIds.has(c.section)) fail(`${label}: раздел ${c.section} не найден`);
    c.naAllowed = Boolean(c.naAllowed);
  }
  return cl;
}
