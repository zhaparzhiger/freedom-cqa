import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeScore } from '../public/js/scoring.js';
import { defaultChecklist } from '../server/checklist-default.js';

const cl = defaultChecklist();

test('все критерии на максимуме дают 100', () => {
  const r = computeScore(cl, { c01: 'yes', c02: 'yes', c03: 'yes', c04: '20', c05: 'yes', c06: '10', c07: 'yes', c08: 'no' });
  assert.equal(r.total, 100);
  assert.equal(r.grossError, false);
});

test('N/A перераспределяет вес: пример p1-ru-001', () => {
  // применимы 1,4,5,6,7 → сумма весов 65; завершение «Нет» → 60 из 65
  const r = computeScore(cl, { c01: 'yes', c02: 'na', c03: 'na', c04: '20', c05: 'yes', c06: '10', c07: 'no', c08: 'no' });
  assert.equal(r.applicableWeight, 65);
  assert.equal(r.total, 92.31);
});

test('шкала пересчитывается пропорционально весу', () => {
  const r = computeScore(cl, { c01: 'no', c02: 'no', c03: 'no', c04: '15', c05: 'no', c06: '7', c07: 'no', c08: 'no' });
  // 15/20*20 = 15; 7/10*15 = 10.5 → 25.5 из 100
  assert.equal(r.total, 25.5);
  const c06 = r.rows.find((x) => x.criterionId === 'c06');
  assert.equal(c06.points, 10.5);
});

test('грубая ошибка отмечается отдельно и не влияет на балл', () => {
  const a = { c01: 'yes', c02: 'yes', c03: 'na', c04: '20', c05: 'yes', c06: '10', c07: 'yes' };
  const r1 = computeScore(cl, { ...a, c08: 'no' });
  const r2 = computeScore(cl, { ...a, c08: 'yes' });
  assert.equal(r1.total, r2.total);
  assert.equal(r2.grossError, true);
});

test('нет применимых критериев с весом — итог не считается', () => {
  const custom = { ...cl, criteria: cl.criteria.filter((c) => c.naAllowed || c.type === 'flag') };
  const r = computeScore(custom, { c02: 'na', c03: 'na', c04: 'na', c07: 'na', c08: 'no' });
  assert.equal(r.total, null);
});

test('итог по секциям', () => {
  const r = computeScore(cl, { c01: 'yes', c02: 'no', c03: 'na', c04: '20', c05: 'yes', c06: '10', c07: 'yes', c08: 'no' });
  const s1 = r.sections.find((s) => s.sectionId === 's1');
  assert.equal(s1.percent, 40); // 10 из 25
});
