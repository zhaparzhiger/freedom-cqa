// Подсчёт баллов по правилам чек-листа. Общий модуль: им пользуются и сервер, и интерфейс.
// Модель только выбирает ответ по каждому критерию; арифметика целиком здесь.
//
// Порядок расчёта (стр. 2 чек-листа):
// 1. N/A — только где разрешён.  2. «Да» = полный вес, «Нет» = 0, шкала — одна из ступеней.
// 3. Шкала пересчитывается пропорционально весу (верхняя ступень = полный вес).
// 4. Веса N/A-критериев перераспределяются пропорционально между применимыми, максимум 100.
// 5. Итог округляется до двух знаков; если применимых критериев с весом нет — итог не считается.
//    Грубые ошибки отмечаются отдельно.

export const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export function scaleMax(criterion) {
  const values = (criterion.scale || []).map((s) => Number(s.value));
  return values.length ? Math.max(...values) : 0;
}

/** Допустимые ответы критерия в виде строк: 'yes' | 'no' | 'na' | '<ступень шкалы>'. */
export function allowedAnswers(criterion) {
  let base;
  if (criterion.type === 'scale') base = (criterion.scale || []).map((s) => String(s.value));
  else base = ['yes', 'no'];
  if (criterion.naAllowed && criterion.type !== 'flag') base = [...base, 'na'];
  return base;
}

/** Баллы критерия до перераспределения (null — N/A или критерий без веса). */
export function rawPoints(criterion, answer) {
  if (answer === 'na' || answer == null) return null;
  if (criterion.type === 'flag') return null;
  const w = Number(criterion.weight) || 0;
  if (criterion.type === 'yesno') return answer === 'yes' ? w : 0;
  const max = scaleMax(criterion);
  return max > 0 ? (Number(answer) / max) * w : 0;
}

/**
 * @param checklist {criteria, sections}
 * @param answers   {[criterionId]: 'yes'|'no'|'na'|'15'...}
 */
export function computeScore(checklist, answers) {
  const rows = [];
  let applicableWeight = 0;
  let earned = 0;
  const grossFlags = [];

  for (const c of checklist.criteria) {
    const answer = answers[c.id];
    if (answer === undefined) {
      rows.push({ criterionId: c.id, answer: null, evaluated: false });
      continue;
    }
    if (c.type === 'flag') {
      if (answer === 'yes') grossFlags.push(c.id);
      rows.push({ criterionId: c.id, answer, evaluated: true, flag: true, raised: answer === 'yes' });
      continue;
    }
    const weight = Number(c.weight) || 0;
    const na = answer === 'na';
    const points = rawPoints(c, answer);
    if (!na && weight > 0) {
      applicableWeight += weight;
      earned += points;
    }
    rows.push({ criterionId: c.id, answer, evaluated: true, na, weight, points });
  }

  const k = applicableWeight > 0 ? 100 / applicableWeight : null;
  for (const r of rows) {
    if (r.weight !== undefined && !r.na && k) {
      r.effectiveWeight = round2(r.weight * k);
      r.effectivePoints = round2(r.points * k);
    }
  }

  const sections = (checklist.sections || []).map((s) => {
    const inSection = checklist.criteria.filter((c) => c.section === s.id && c.type !== 'flag');
    const sectionRows = rows.filter((r) => inSection.some((c) => c.id === r.criterionId) && r.evaluated && !r.na && r.weight > 0);
    const max = sectionRows.reduce((a, r) => a + r.weight, 0);
    const got = sectionRows.reduce((a, r) => a + r.points, 0);
    return {
      sectionId: s.id,
      name: s.name,
      points: k ? round2(got * k) : null,
      max: k ? round2(max * k) : null,
      percent: max > 0 ? round2((got / max) * 100) : null,
      hasScoredCriteria: inSection.length > 0,
    };
  }).filter((s) => s.hasScoredCriteria);

  return {
    total: k ? round2(earned * k) : null,
    applicableWeight,
    rows,
    sections,
    grossError: grossFlags.length > 0,
    grossFlags,
  };
}
