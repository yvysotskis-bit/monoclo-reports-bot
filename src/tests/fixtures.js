// Фікстури розділу 10 ТЗ. День D = 2026-10-05 (пн).
// D-1 і AVG7 підібрано так, щоб збігалось із еталоном 7.1 (див. README, "Відхилення від ТЗ").

const FX_DATE = '2026-10-05';

function fxMetaRows() {
  const dates = dateRange('2026-09-28', '2026-10-04');
  const cols = {
    spend: [3400, 3150, 3400, 3200, 3000, 3500, 3100],
    impressions: [40000, 39500, 41000, 40300, 38800, 42200, 39200],
    reach: [23000, 22800, 23500, 23200, 22500, 24000, 22900],
    link_clicks: [585, 590, 600, 595, 575, 607, 608],
    view_content: [520, 500, 530, 510, 490, 540, 510],
    add_to_cart: [66, 64, 68, 67, 62, 70, 71],
    initiate_checkout: [28, 27, 29, 28, 26, 30, 29],
    purchases: [8, 9, 8, 8, 7, 9, 9],
    purchase_value: [11000, 12500, 11800, 12000, 10500, 13000, 12700],
    conversations_started: [46, 42, 44, 40, 41, 43, 44],
    first_replies: [38, 36, 37, 34, 35, 36, 38],
    direct_spend: [1100, 1050, 1100, 1000, 1050, 1100, 1100]
  };
  const rows = dates.map(function (d, i) {
    const r = { date: d };
    Object.keys(cols).forEach(function (k) {
      r[k] = cols[k][i];
    });
    return r;
  });
  rows.push({
    date: FX_DATE, spend: 3400, impressions: 41200, reach: 23800, link_clicks: 667, view_content: 512, add_to_cart: 64,
    initiate_checkout: 22, purchases: 9, purchase_value: 13050, conversations_started: 46, first_replies: 39, direct_spend: 1104
  });
  return rows;
}

// Налаштування для еталона. Два значення відрізняються від дефолтів ТЗ (див. README):
// trend_band_pct = 4 (інакше +4,6% дає ➖, а не ↗) і color_band_pct = 12 (інакше 8,7% vs 11% дає 🔴, а не 🟡).
function fxSettings(over) {
  const sources = {
    keycrm_source_site_ids: 'site',
    keycrm_source_quickorders_ids: 'quickorders',
    keycrm_source_instagram_ids: 'instagram',
    keycrm_excluded_status_ids: '99'
  };
  return Object.assign(defaultSettingsMap(), { trend_band_pct: 4, color_band_pct: 12 }, sources, over || {});
}

function fxOrder_(id, date, sourceGroup, utm, counted, total) {
  const rules = parseRuleRows(DEFAULT_UTM_RULES);
  const u = Object.assign({ utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '', gclid: '', fbclid: '' }, utm || {});
  return Object.assign(
    {
      order_id: String(id), created_at_kyiv: date + ' 12:00:00', date: date, source_id: sourceGroup, source_group: sourceGroup,
      status_id: counted ? '1' : '99', status_name: counted ? 'Новий' : 'Скасовано', is_counted: counted, grand_total: total,
      utm_origin: 'keycrm', channel: classifyChannel(sourceGroup, u, rules), manager: '', updated_at: ''
    },
    u
  );
}

// Нормалізовані замовлення: день D за таблицею з розділу 10 + пряме замовлення за D-7…D-1 (33 шт.)
function fxOrders() {
  const out = [];
  let id = 1;
  const fb = { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: '120200000001' };
  const ig = { utm_source: 'ig', utm_medium: 'paid' };
  for (let i = 0; i < 7; i++) out.push(fxOrder_(id++, FX_DATE, 'site', fb, true, 1400));
  out.push(fxOrder_(id++, FX_DATE, 'site', { gclid: 'abc123' }, true, 1450));
  for (let i = 0; i < 2; i++) out.push(fxOrder_(id++, FX_DATE, 'site', {}, true, 1350));
  for (let i = 0; i < 2; i++) out.push(fxOrder_(id++, FX_DATE, 'quickorders', ig, true, 1225));
  out.push(fxOrder_(id++, FX_DATE, 'quickorders', {}, true, 900));
  for (let i = 0; i < 4; i++) out.push(fxOrder_(id++, FX_DATE, 'instagram', {}, true, 1400));
  out.push(fxOrder_(id++, FX_DATE, 'site', fb, false, 1200)); // «Скасовано»
  const directPerDay = [5, 4, 5, 4, 4, 6, 5]; // разом 33
  dateRange('2026-09-28', '2026-10-04').forEach(function (d, i) {
    for (let k = 0; k < directPerDay[i]; k++) out.push(fxOrder_(id++, d, 'instagram', {}, true, 1400));
  });
  return out;
}

// Еталон 7.1. Єдина відмінність від ТЗ: D-1 CPC "5,1" замість "5,3" — при CPM 79 і CTR 1,55% за формулами
// CPC = CPM ÷ (CTR × 10) ≈ 5,10, значення 5,3 арифметично недосяжне (README, "Відхилення від ТЗ").
function fxReferenceMsg1() {
  return [
    '🎯 MONOCLO · META · 05.10 (пн)',
    'порівняння: вчора │ середнє 7 днів',
    '',
    '💸 ВИТРАТИ',
    'Spend: 3 400 грн │ 3 100 │ 3 250 ↗',
    'Показів: 41 200 · Охоплення: 23 800',
    'Частота акаунта: 1,73 🟢',
    'CPM: 83 грн │ 79 │ 81 ➖',
    'CTR (link): 1,62% │ 1,55% │ 1,48% 🟢',
    'CPC (link): 5,1 грн │ 5,1 │ 5,5 🟢',
    '',
    '🛒 САЙТ (піксель)',
    'Перегляд товару: 512 · 6,6 грн',
    'Додали в кошик: 64 · 53 грн · 12,5% 🟢',
    'Оформлення: 22 · 155 грн · 34% від кошика 🟡',
    'Покупки: 9 · CPA 378 грн 🟢',
    'Цінність: 13 050 грн · ROAS 3,84×',
    '',
    '💬 INSTAGRAM DIRECT',
    'Нових розмов: 46 · 24 грн/розмова 🟢',
    'Перших відповідей клієнта: 39 (85%)',
    'Замовлень з Direct: 4 · сума 5 600 грн',
    'Конверсія розмова → замовлення: 8,7% 🟡 (7 днів: 11%)',
    '',
    '📥 ЗАМОВЛЕННЯ З META (KeyCRM)',
    'Сайт: 7 · 9 800 грн',
    'QuickOrders: 2 · 2 450 грн',
    'Instagram Direct: 4 · 5 600 грн',
    'Піксель vs CRM (сайт): 9 │ 9 ✅',
    'Без UTM-мітки: 3 замовл. (не враховано)',
    '',
    '📊 РАЗОМ META (за CRM)',
    'Замовлень: 13 · CPA 262 грн 🟢',
    'Сума: 17 850 грн · ROAS 5,25× 🟢',
    'Ціль: CPA ≤ 350 · ROAS ≥ 3,0'
  ].join('\n');
}
