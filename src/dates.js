// Чисті функції для дат. Усі "дати" в системі — рядки YYYY-MM-DD за Europe/Kyiv.

const KYIV_TZ = 'Europe/Kyiv';
const WEEKDAYS_UA = ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error('Невірна дата (очікується YYYY-MM-DD): ' + s);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function addDays(ymd, n) {
  const p = parseYmd(ymd);
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function weekdayUa(ymd) {
  const p = parseYmd(ymd);
  return WEEKDAYS_UA[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
}

function formatDdMm(ymd) {
  const p = parseYmd(ymd);
  return pad2_(p.d) + '.' + pad2_(p.m);
}

function tzParts_(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);
  const o = {};
  parts.forEach(function (p) {
    o[p.type] = p.value;
  });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

// 'YYYY-MM-DD' для моменту часу в зоні tz
function dateInTz(date, tz) {
  const p = tzParts_(date, tz || KYIV_TZ);
  return p.y + '-' + pad2_(p.m) + '-' + pad2_(p.d);
}

// 'YYYY-MM-DD HH:mm:ss' для моменту часу в зоні tz
function dateTimeInTz(date, tz) {
  const p = tzParts_(date, tz || KYIV_TZ);
  return p.y + '-' + pad2_(p.m) + '-' + pad2_(p.d) + ' ' + pad2_(p.h) + ':' + pad2_(p.mi) + ':' + pad2_(p.s);
}

function tzOffsetMs_(utcMs, tz) {
  const base = Math.floor(utcMs / 1000) * 1000;
  const p = tzParts_(new Date(base), tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - base;
}

// локальний час у зоні tz -> UTC мс
function localToUtcMs(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const off1 = tzOffsetMs_(guess, tz);
  let utc = guess - off1;
  const off2 = tzOffsetMs_(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

// Розбір часової мітки з API. Якщо в рядку є зсув / Z — він і використовується.
// Якщо зсуву немає ("2026-10-05 23:50:00") — рядок трактується як час у naiveTz.
// Повертає мс або NaN.
function parseTimestamp(value, naiveTz) {
  if (value == null || value === '') return NaN;
  if (value instanceof Date) return value.getTime();
  const s = String(value).trim();
  const explicit = /[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}(:?\d{2})?)$/i.test(s);
  if (explicit) return new Date(s.replace(' ', 'T').replace(/\s+/g, '')).getTime();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return NaN;
  return localToUtcMs(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), naiveTz || 'UTC');
}
