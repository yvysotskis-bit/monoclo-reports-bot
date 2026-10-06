// Форматування чисел українською (розділ 7.2). Чисті функції.

const DASH = '—';
// Відсотки від цього значення показуються цілими, менші — з одним знаком.
// Так отримуємо еталон 7.1: 12,5% · 34% · 85% · 8,7% · 11% (див. README, "Відхилення від ТЗ").
const PCT_INT_FROM = 20;
// Гривні: до цього значення — 1 знак після коми, від нього — ціле. Так отримуємо еталон 7.1:
// 6,6 · 5,1 (з одним знаком) і 24 · 53 · 155 · 378 (цілі). ТЗ у тексті каже "< 100 — 1 знак", але еталон
// містить "53 грн" при 53,125 — еталон важливіший (README, "Відхилення від ТЗ").
const UAH_DEC_BELOW = 10;

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

function groupThousands_(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// dec знаків після коми; strip — прибрати кінцеві нулі (",0")
function fmtDec(v, dec, strip) {
  if (!isNum(v)) return DASH;
  const f = Math.pow(10, dec);
  const r = Math.round(Math.abs(v) * f) / f;
  const parts = r.toFixed(dec).split('.');
  let out = groupThousands_(parts[0]);
  let frac = parts[1] || '';
  if (strip) frac = frac.replace(/0+$/, '');
  if (frac) out += ',' + frac;
  const negative = v < 0 && r !== 0;
  return (negative ? '-' : '') + out;
}

function fmtInt(v) {
  return fmtDec(v, 0, false);
}

// гривні: < UAH_DEC_BELOW — 1 знак (".0" прибирається), інакше ціле; opts.integer — завжди ціле (CPM)
function fmtUah(v, opts) {
  if (!isNum(v)) return DASH;
  if (Math.abs(v) >= UAH_DEC_BELOW || (opts && opts.integer)) return fmtDec(v, 0, false);
  return fmtDec(v, 1, true);
}

// "378 грн" або "—"
function uah(v, opts) {
  return isNum(v) ? fmtUah(v, opts) + ' грн' : DASH;
}

// відсотки; kind 'ctr' — 2 знаки, інші — за правилом PCT_INT_FROM
function fmtPct(v, kind) {
  if (!isNum(v)) return DASH;
  if (kind === 'ctr') return fmtDec(v, 2, false) + '%';
  if (Math.abs(v) >= PCT_INT_FROM) return fmtDec(v, 0, false) + '%';
  return fmtDec(v, 1, true) + '%';
}

function fmtRatio(v) {
  return isNum(v) ? fmtDec(v, 2, false) + '×' : DASH;
}

function fmtFreq(v) {
  return fmtDec(v, 2, false);
}

// цільове значення ROAS: "3,0", "3,25"
function fmtTargetRatio(v) {
  if (!isNum(v)) return DASH;
  const s = fmtDec(v, 2, true);
  return s.indexOf(',') === -1 ? s + ',0' : s;
}
