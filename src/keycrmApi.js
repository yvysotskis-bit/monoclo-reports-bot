// KeyCRM Open API. VERIFY: усі ендпоінти, параметри й назви полів нижче — ГІПОТЕЗИ,
// бо документація недоступна з середовища розробки. Єдине місце, де вони задані: константи KEYCRM_*.
// Реальну структуру замовлення, джерел і статусів показує discoverKeycrm(); після нього константи правляться тут.

const KEYCRM_ENDPOINTS = {
  orders: '/order', // VERIFY
  sources: '/order/source', // VERIFY
  statuses: '/order/status' // VERIFY
};
const KEYCRM_PAGE_LIMIT = 50; // VERIFY: максимум limit
const KEYCRM_THROTTLE_MS = 1100; // VERIFY: ліміт запитів на хвилину з документації
const KEYCRM_CREATED_FILTER = 'filter[created_between]'; // VERIFY: формат "YYYY-MM-DD HH:mm:ss,YYYY-MM-DD HH:mm:ss"

// Кандидати шляхів до полів у відповіді (перший непорожній виграє). VERIFY.
const KEYCRM_FIELDS = {
  id: ['id'],
  createdAt: ['created_at'],
  orderedAt: ['ordered_at'], // дата замовлення (так само групують звіти KeyCRM); якщо порожня — created_at
  sourceId: ['source_id'],
  statusId: ['status_id'],
  grandTotal: ['grand_total'],
  manager: ['manager.full_name', 'manager.name'],
  utm_source: ['marketing.utm_source'],
  utm_medium: ['marketing.utm_medium'],
  utm_campaign: ['marketing.utm_campaign'],
  utm_content: ['marketing.utm_content'],
  utm_term: ['marketing.utm_term'],
  gclid: ['marketing.gclid'],
  fbclid: ['marketing.fbclid']
};

function pickPath(obj, paths) {
  for (let i = 0; i < paths.length; i++) {
    let cur = obj;
    const parts = paths[i].split('.');
    for (let j = 0; j < parts.length && cur != null; j++) cur = cur[parts[j]];
    if (cur != null && cur !== '') return cur;
  }
  return '';
}

// Інтеграція сайту -> KeyCRM часто лишає marketing = null, але пише мітки в коментар менеджера рядком
// "UTM: utm_source: facebook; utm_medium: cpc; utm_campaign: warm; fbclid: ..." (перевірено на реальних замовленнях).
// Беремо лише цей рядок і лише відомі ключі; решту коментаря (контакти, адреси) ігноруємо.
const UTM_COMMENT_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'];

function utmFromComment(text) {
  const out = {};
  const m = /(?:^|\n)[ \t]*UTM:([^\n]*)/.exec(String(text == null ? '' : text));
  if (!m) return out;
  m[1].split(';').forEach(function (part) {
    const kv = /^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(part);
    if (!kv) return;
    const key = kv[1].toLowerCase();
    if (UTM_COMMENT_KEYS.indexOf(key) !== -1 && kv[2] !== '' && out[key] === undefined) out[key] = kv[2];
  });
  return out;
}

// Мітки замовлення з marketing; якщо їх там немає — з коментаря. {utm, origin: 'keycrm'|'comment'|'none'}
function utmFromRaw_(raw) {
  const utm = {};
  UTM_COMMENT_KEYS.forEach(function (k) {
    utm[k] = String(pickPath(raw, KEYCRM_FIELDS[k]));
  });
  if (hasAnyUtm(utm)) return { utm: utm, origin: 'keycrm' };
  const c = utmFromComment(raw && raw.manager_comment);
  UTM_COMMENT_KEYS.forEach(function (k) {
    utm[k] = c[k] || '';
  });
  return hasAnyUtm(utm) ? { utm: utm, origin: 'comment' } : { utm: utm, origin: 'none' };
}

// Сире замовлення KeyCRM -> рядок KeyCRM_Orders (розділ 4.5).
// ctx: {settings, rules, statusNames: {id: name}, utmFallback?: (raw) => utm|null}
function normalizeOrder(raw, ctx) {
  const F = KEYCRM_FIELDS;
  const ts = parseTimestamp(pickPath(raw, F.createdAt), ctx.settings.keycrm_naive_timestamp_tz);
  if (!isFinite(ts)) throw new Error('KeyCRM: неможливо розібрати created_at замовлення ' + pickPath(raw, F.id));
  const when = new Date(ts);
  // День замовлення — за ordered_at (як у звітах KeyCRM), інакше за created_at
  const orderedTs = parseTimestamp(pickPath(raw, F.orderedAt), ctx.settings.keycrm_naive_timestamp_tz);
  const orderDate = dateInTz(isFinite(orderedTs) ? new Date(orderedTs) : when, KYIV_TZ);

  const found = utmFromRaw_(raw);
  const utm = found.utm;
  let origin = found.origin;
  if (origin === 'none' && ctx.utmFallback) {
    const fb = ctx.utmFallback(raw);
    if (fb) {
      Object.keys(fb).forEach(function (k) {
        utm[k] = String(fb[k] == null ? '' : fb[k]);
      });
      origin = hasAnyUtm(utm) ? 'shopify' : 'shopify_none'; // 'shopify_none' = перевірено в Shopify, міток немає
    }
  }

  const sourceId = String(pickPath(raw, F.sourceId));
  const statusId = String(pickPath(raw, F.statusId));
  const sourceGroup = classifySource(sourceId, ctx.settings);
  const excluded = settingList(ctx.settings, 'keycrm_excluded_status_ids');

  return {
    order_id: String(pickPath(raw, F.id)),
    created_at_kyiv: dateTimeInTz(when, KYIV_TZ),
    date: orderDate,
    source_id: sourceId,
    source_group: sourceGroup,
    status_id: statusId,
    status_name: (ctx.statusNames && ctx.statusNames[statusId]) || '',
    is_counted: excluded.indexOf(statusId) === -1,
    grand_total: Number(pickPath(raw, F.grandTotal)) || 0,
    utm_source: utm.utm_source,
    utm_medium: utm.utm_medium,
    utm_campaign: utm.utm_campaign,
    utm_content: utm.utm_content,
    utm_term: utm.utm_term,
    gclid: utm.gclid,
    fbclid: utm.fbclid,
    utm_origin: origin,
    channel: classifyChannel(sourceGroup, utm, ctx.rules),
    manager: String(pickPath(raw, F.manager)),
    updated_at: ''
  };
}

function classifyKeycrmError(e) {
  if (e.http === 429) return { retry: true, waitMs: 30000 }; // VERIFY: пауза за лімітами документації
  if (e.http == null || e.http >= 500) return { retry: true };
  return { retry: false };
}

function keycrmGet_(path, params) {
  const base = requireSecret('KEYCRM_API_BASE').replace(/\/+$/, '');
  const q = toQuery_(params || {});
  const url = base + path + (q ? '?' + q : '');
  return withRetry(
    function () {
      let resp;
      try {
        resp = UrlFetchApp.fetch(url, {
          method: 'get',
          headers: { Authorization: 'Bearer ' + requireSecret('KEYCRM_API_KEY'), Accept: 'application/json' },
          muteHttpExceptions: true
        });
      } catch (netErr) {
        throw new Error('KeyCRM: мережева помилка: ' + redactSecrets_(netErr.message));
      }
      const code = resp.getResponseCode();
      if (code >= 400) {
        const e = new Error('KeyCRM API: HTTP ' + code + ' ' + String(resp.getContentText()).slice(0, 300));
        e.http = code;
        throw e;
      }
      return JSON.parse(resp.getContentText());
    },
    classifyKeycrmError,
    { delays: [2000, 5000, 10000], sleep: function (ms) { Utilities.sleep(ms); } }
  );
}

// Постраничне читання. VERIFY: форма пагінації ({data, last_page, ...}) — припущення;
// зупиняємось, коли сторінка порожня/неповна або досягнуто last_page.
function keycrmGetAll(path, params) {
  const out = [];
  for (let page = 1; page <= 500; page++) {
    const body = keycrmGet_(path, Object.assign({}, params, { limit: KEYCRM_PAGE_LIMIT, page: page }));
    const data = Array.isArray(body) ? body : body.data || [];
    data.forEach(function (r) {
      out.push(r);
    });
    if (Array.isArray(body) || data.length < KEYCRM_PAGE_LIMIT) break;
    if (body.last_page && page >= body.last_page) break;
    Utilities.sleep(KEYCRM_THROTTLE_MS);
  }
  return out;
}

// Сирі замовлення, створені в [from, to] за Києвом. Запит розширюємо на добу в обидва боки
// (зона часу API не звірена), а точну межу доби робить normalizeOrder + фільтр за date.
function fetchKeycrmRawOrders(from, to, settings) {
  const params = {};
  params[KEYCRM_CREATED_FILTER] = addDays(from, -1) + ' 00:00:00,' + addDays(to, 1) + ' 23:59:59';
  const include = String(settings.keycrm_order_include || '').trim();
  if (include) params.include = include;
  return keycrmGetAll(KEYCRM_ENDPOINTS.orders, params);
}

function fetchKeycrmStatusNames_() {
  const map = {};
  keycrmGetAll(KEYCRM_ENDPOINTS.statuses, {}).forEach(function (s) {
    map[String(s.id)] = s.name || '';
  });
  return map;
}

// Нормалізовані замовлення в межах [from, to] за Києвом.
// existing — {order_id: рядок KeyCRM_Orders} (щоб не питати Shopify повторно про вже знайдені мітки).
// Помилка резерву Shopify не валить завантаження: вона лишається у властивості результату .shopifyError.
function fetchKeycrmOrders(from, to, settings, rules, existing) {
  const statusNames = fetchKeycrmStatusNames_();
  const raws = fetchKeycrmRawOrders(from, to, settings);
  let fallback = null;
  let shopifyError = '';
  if (settingBool(settings, 'shopify_utm_fallback')) {
    try {
      fallback = buildShopifyFallback_(raws, settings, existing || {}, dateInTz(new Date(), KYIV_TZ));
    } catch (e) {
      shopifyError = redactSecrets_(e && e.message ? e.message : String(e));
    }
  }
  // Одне "биття" замовлення (напр. без дати) не повинно зупиняти завантаження всіх інших
  const skipped = [];
  const normalized = [];
  raws.forEach(function (raw) {
    try {
      normalized.push(normalizeOrder(raw, { settings: settings, rules: rules, statusNames: statusNames, utmFallback: fallback }));
    } catch (e) {
      skipped.push(String(pickPath(raw, KEYCRM_FIELDS.id)) + ': ' + (e && e.message ? e.message : e));
    }
  });
  const orders = normalized.filter(function (o) {
    return o.date >= from && o.date <= to;
  });
  orders.shopifyError = shopifyError;
  orders.skipped = skipped;
  orders.rawCount = raws.length;
  return orders;
}
