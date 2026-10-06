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

  const utm = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'].forEach(function (k) {
    utm[k] = String(pickPath(raw, F[k]));
  });
  let origin = hasAnyUtm(utm) ? 'keycrm' : 'none';
  if (origin === 'none' && ctx.utmFallback) {
    const fb = ctx.utmFallback(raw);
    if (fb) {
      Object.keys(fb).forEach(function (k) {
        utm[k] = String(fb[k] == null ? '' : fb[k]);
      });
      origin = hasAnyUtm(utm) ? 'shopify' : 'none';
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
      fallback = buildShopifyFallback_(raws, settings, existing || {});
    } catch (e) {
      shopifyError = redactSecrets_(e && e.message ? e.message : String(e));
    }
  }
  const orders = raws
    .map(function (raw) {
      return normalizeOrder(raw, { settings: settings, rules: rules, statusNames: statusNames, utmFallback: fallback });
    })
    .filter(function (o) {
      return o.date >= from && o.date <= to;
    });
  orders.shopifyError = shopifyError;
  return orders;
}
