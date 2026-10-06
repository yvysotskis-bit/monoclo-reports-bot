// Світлофор і стрілки (розділ 6). Чисті функції; усі пороги приходять аргументами (з листа «Налаштування»).

const TARGET_TOLERANCE = 0.2; // "вище цілі не більше ніж на 20%" — фіксоване правило ТЗ

function hasVal_(x) {
  return isNum(x) && x > 0;
}

// Стрілка тренду (лише Spend): D vs AVG7
function trendArrow(v, avg, bandPct) {
  if (!isNum(v) || !hasVal_(avg)) return '';
  const diff = ((v - avg) / avg) * 100;
  if (diff > bandPct) return '↗';
  if (diff < -bandPct) return '↘';
  return '➖';
}

// «менше = краще». avg і target можуть бути null.
function colorLower(v, avg, target, bandPct) {
  if (!isNum(v)) return '';
  const hasAvg = hasVal_(avg);
  const hasT = isNum(target);
  if (!hasAvg && !hasT) return '';
  const b = bandPct / 100;
  const green = (!hasAvg || v <= avg * (1 + b)) && (!hasT || v <= target);
  if (green) return '🟢';
  const yellow =
    (hasAvg && v > avg * (1 + b) && v <= avg * (1 + 2 * b)) ||
    (hasT && v > target && v <= target * (1 + TARGET_TOLERANCE));
  return yellow ? '🟡' : '🔴';
}

// «більше = краще» — дзеркально
function colorHigher(v, avg, target, bandPct) {
  if (!isNum(v)) return '';
  const hasAvg = hasVal_(avg);
  const hasT = isNum(target);
  if (!hasAvg && !hasT) return '';
  const b = bandPct / 100;
  const green = (!hasAvg || v >= avg * (1 - b)) && (!hasT || v >= target);
  if (green) return '🟢';
  const yellow =
    (hasAvg && v < avg * (1 - b) && v >= avg * (1 - 2 * b)) ||
    (hasT && v < target && v >= target * (1 - TARGET_TOLERANCE));
  return yellow ? '🟡' : '🔴';
}

// CPM: у межах band від AVG7 — ➖, інакше звичайні кольори «менше = краще»
function colorCpm(v, avg, bandPct) {
  if (!isNum(v) || !hasVal_(avg)) return '';
  const b = bandPct / 100;
  if (v >= avg * (1 - b) && v <= avg * (1 + b)) return '➖';
  return colorLower(v, avg, null, bandPct);
}

function colorFreq(v, yellow, red) {
  if (!isNum(v)) return '';
  if (v < yellow) return '🟢';
  if (v < red) return '🟡';
  return '🔴';
}

// Піксель vs CRM: diffPct = null (ділення на нуль) -> без значка
function colorPixelCrm(diffPct, yellowPct, redPct) {
  if (!isNum(diffPct)) return '';
  if (diffPct < yellowPct) return '✅';
  if (diffPct < redPct) return '🟡';
  return '🔴';
}

function colorUtmMissing(sharePct, warnPct) {
  if (!isNum(sharePct)) return '';
  return sharePct < warnPct ? '' : '🟡';
}
