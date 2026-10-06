// Налаштування: Script Properties (секрети) і лист «Налаштування».
// Секрети читаються лише тут і лише з Script Properties — ніколи з коду чи таблиці.

// Початкове наповнення листа «Налаштування» (розділ 2). Рантайм читає значення з листа;
// ці дефолти потрібні для seed (setupSpreadsheet) і як запасне значення, якщо ключ видалили.
const DEFAULT_SETTINGS = [
  ['target_cpa_total', 350, 'цільовий CPA Meta за CRM (сайт + QuickOrders + Direct), грн'],
  ['target_cpa_site', 400, 'цільовий CPA сайту за пікселем, грн'],
  ['target_roas', 3.0, 'мінімальний ROAS'],
  ['target_cost_per_conversation', 30, 'ціль вартості розмови в Direct, грн'],
  ['freq_yellow', 2.0, 'частота акаунта: від цього значення 🟡'],
  ['freq_red', 3.0, 'частота акаунта: від цього значення 🔴'],
  ['trend_band_pct', 5, 'поріг для стрілок ↗ ↘ (±%)'],
  ['color_band_pct', 10, 'поріг для 🟢 🟡 🔴 при порівнянні з середнім (±%)'],
  ['direct_campaign_ids', '', 'ID Meta-кампаній на повідомлення через кому; порожньо — автовизначення (4.4)'],
  ['report_send_enabled', true, 'вимикач відправки в Telegram'],
  ['keycrm_source_site_ids', '', 'ID джерела «Сайт | Monoclo» (після discoverKeycrm)'],
  ['keycrm_source_quickorders_ids', '', 'ID джерела «Monoclo QuickOrders» (після discoverKeycrm)'],
  ['keycrm_source_instagram_ids', '', 'ID джерела «Інстаграм | Monoclo» (після discoverKeycrm)'],
  ['keycrm_excluded_status_ids', '', 'ID статусів, які НЕ рахуються замовленням (група «Скасовано»)'],
  ['pixel_crm_diff_yellow_pct', 20, 'розбіжність піксель vs CRM: від цього % — 🟡'],
  ['pixel_crm_diff_red_pct', 40, 'розбіжність піксель vs CRM: від цього % — 🔴'],
  ['utm_missing_warn_pct', 30, 'частка замовлень сайту без UTM: від цього % — 🟡'],
  ['meta_fx_mode', 'nbu', 'рахунки Meta не в UAH: nbu = офіційний курс НБУ на кожну дату; fixed = фіксований курс нижче'],
  ['meta_fx_fixed_rate', '', 'грн за 1 одиницю валюти рахунку (лише якщо meta_fx_mode = fixed)'],
  ['shopify_utm_fallback', false, 'брати UTM із Shopify, якщо їх немає в KeyCRM (вмикати після успішного checkShopify)'],
  // додаткові (не з ТЗ) — технічні, потрібні через те, що документація API не звірена:
  ['keycrm_order_include', 'marketing', 'VERIFY: значення параметра include для /order (де лежать UTM)'],
  ['keycrm_naive_timestamp_tz', 'UTC', 'VERIFY: часова зона для дат KeyCRM без зсуву (UTC або Europe/Kyiv)']
];

function defaultSettingsMap() {
  const o = {};
  DEFAULT_SETTINGS.forEach(function (r) {
    o[r[0]] = r[1];
  });
  return o;
}

// Лист «Налаштування» (рядки [ключ, значення, опис]) -> {ключ: значення}, з запасними дефолтами
function parseSettingsRows(rows) {
  const o = defaultSettingsMap();
  (rows || []).forEach(function (r) {
    const key = String(r[0] == null ? '' : r[0]).trim();
    if (!key || key === 'key' || key === 'ключ') return;
    if (r[1] === '' || r[1] == null) {
      if (key in o && typeof o[key] !== 'string') return; // порожнє числове значення -> лишається дефолт
      o[key] = '';
      return;
    }
    o[key] = r[1];
  });
  return o;
}

function settingNum(settings, key) {
  const v = settings[key];
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
  if (!isFinite(n)) throw new Error('Налаштування «' + key + '» не є числом: ' + v);
  return n;
}

function settingNumOrNull(settings, key) {
  const v = settings[key];
  if (v === '' || v == null) return null;
  return settingNum(settings, key);
}

function settingBool(settings, key) {
  const v = settings[key];
  if (typeof v === 'boolean') return v;
  return String(v).trim().toLowerCase() === 'true';
}

// "12, 15" -> ['12','15']; число 12 -> ['12']
function settingList(settings, key) {
  const v = settings[key];
  if (v === '' || v == null) return [];
  return String(v)
    .split(',')
    .map(function (x) {
      return x.trim();
    })
    .filter(function (x) {
      return x !== '';
    });
}

// ---- Script Properties (I/O) ----

function getSecret(name) {
  if (typeof PropertiesService === 'undefined') return ''; // тести в Node
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return v == null ? '' : String(v).trim();
}

function requireSecret(name) {
  const v = getSecret(name);
  if (!v) throw new Error('Не заповнено Script Property ' + name);
  return v;
}

const SECRET_NAMES = ['META_ACCESS_TOKEN', 'TG_BOT_TOKEN', 'KEYCRM_API_KEY', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_CLIENT_SECRET'];
// Токени, отримані під час виконання (напр. Shopify client credentials), теж не повинні потрапляти в логи
const EXTRA_SECRETS = [];

function secretValues_() {
  return SECRET_NAMES.map(getSecret).concat(EXTRA_SECRETS).filter(function (v) {
    return v && v.length >= 6;
  });
}

// Прибирає значення секретів з тексту (логи, алерти, помилки)
function redact(text, secrets) {
  let s = String(text);
  (secrets || []).forEach(function (sec) {
    if (sec) s = s.split(sec).join('***');
  });
  return s;
}

function redactSecrets_(text) {
  return redact(text, secretValues_());
}

// ---- Лист «Налаштування» і «Правила_UTM» (I/O через store) ----

function loadSettings(store) {
  return parseSettingsRows(store.readRaw('Налаштування'));
}

function loadUtmRules(store) {
  const rows = store.read('Правила_UTM');
  return parseRuleRows(rows.length ? rows : DEFAULT_UTM_RULES);
}
