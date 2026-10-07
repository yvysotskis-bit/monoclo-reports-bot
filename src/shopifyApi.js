// Резервне джерело UTM: Shopify Admin GraphQL API (розділ 4.7 ТЗ).
// Вмикається налаштуванням shopify_utm_fallback = TRUE, коли в замовленнях KeyCRM немає міток (marketing = null).
// VERIFY: назви полів customerJourneySummary / utmParameters і зв'язок KeyCRM -> Shopify (source_uuid) не звірені з
// документацією; їх перевіряє checkShopify() на реальних замовленнях.
//
// Автентифікація: SHOPIFY_ADMIN_TOKEN (старий постійний токен), інакше client credentials через
// SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard; токен діє 24 год і кешується).

const SHOPIFY_VISIT_FIELDS = 'landingPage referrerUrl source sourceType utmParameters { source medium campaign content term }'; // VERIFY
const SHOPIFY_NODES_QUERY =
  'query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id name createdAt customerJourneySummary { ready firstVisit { ' +
  SHOPIFY_VISIT_FIELDS + ' } lastVisit { ' + SHOPIFY_VISIT_FIELDS + ' } } } } }';
const SHOPIFY_BATCH = 25;

// ---- чисті функції ----

function parseShopifyDomain(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

// Параметри запиту з URL/шляху: "/p?utm_source=ig&x=1" -> {utm_source:'ig', x:'1'}
function urlParams_(url) {
  const out = {};
  const s = String(url == null ? '' : url);
  const i = s.indexOf('?');
  if (i === -1) return out;
  s.slice(i + 1).split('#')[0].split('&').forEach(function (pair) {
    if (!pair) return;
    const k = pair.split('=')[0];
    let v = pair.slice(k.length + 1);
    try {
      v = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch (e) {
      // залишаємо як є
    }
    out[k.toLowerCase()] = v;
  });
  return out;
}

// KeyCRM source_uuid -> gid замовлення Shopify. Довге число (≥10 цифр) вважаємо ID замовлення Shopify;
// короткий номер (замовлення #1234) тут не обробляється — для нього потрібен пошук за name (VERIFY через checkShopify).
function shopifyOrderGid(raw) {
  const v = String(raw && raw.source_uuid != null ? raw.source_uuid : '').trim();
  const m = /^(?:gid:\/\/shopify\/Order\/)?(\d{10,})$/.exec(v);
  return m ? 'gid://shopify/Order/' + m[1] : null;
}

// Ключ пошуку замовлення Shopify за замовленням KeyCRM:
//  - довге число (≥10 цифр) або gid -> 'gid:gid://shopify/Order/…'
//  - номер/назва замовлення Shopify (напр. "M-CL6309") -> 'name:M-CL6309'
//  - внутрішні ідентифікатори QuickOrders ("quick-…") і порожнє -> null
function shopifyLookupKey(raw) {
  const gid = shopifyOrderGid(raw);
  if (gid) return 'gid:' + gid;
  const v = String(raw && raw.source_uuid != null ? raw.source_uuid : '').trim();
  if (!v || /^quick-/i.test(v)) return null;
  if (/^#?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) && /\d/.test(v)) return 'name:' + v.replace(/^#/, '');
  return null;
}

function visitToUtm_(v) {
  if (!v) return null;
  const p = v.utmParameters || {};
  const q = urlParams_(v.landingPage);
  const utm = {
    utm_source: p.source || q.utm_source || '',
    utm_medium: p.medium || q.utm_medium || '',
    utm_campaign: p.campaign || q.utm_campaign || '',
    utm_content: p.content || q.utm_content || '',
    utm_term: p.term || q.utm_term || '',
    gclid: q.gclid || '',
    fbclid: q.fbclid || ''
  };
  return hasAnyUtm(utm) ? utm : null;
}

// Мітки з "шляху клієнта": спершу останній візит (last click), інакше перший
function journeyToUtm(journey) {
  if (!journey) return null;
  return visitToUtm_(journey.lastVisit) || visitToUtm_(journey.firstVisit);
}

// ---- I/O ----

function shopifyToken_() {
  const legacy = getSecret('SHOPIFY_ADMIN_TOKEN');
  if (legacy) return legacy;
  const cache = CacheService.getScriptCache();
  const cached = cache.get('shopify_token');
  if (cached) {
    EXTRA_SECRETS.push(cached);
    return cached;
  }
  const domain = parseShopifyDomain(requireSecret('SHOPIFY_STORE_DOMAIN'));
  const resp = UrlFetchApp.fetch('https://' + domain + '/admin/oauth/access_token', {
    method: 'post',
    payload: { grant_type: 'client_credentials', client_id: requireSecret('SHOPIFY_CLIENT_ID'), client_secret: requireSecret('SHOPIFY_CLIENT_SECRET') },
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  let body = null;
  try {
    body = JSON.parse(resp.getContentText());
  } catch (e) {
    body = null;
  }
  if (code !== 200 || !body || !body.access_token) {
    throw new Error('Shopify: не вдалося отримати токен (HTTP ' + code + '): ' + redactSecrets_(String(resp.getContentText()).slice(0, 200)));
  }
  EXTRA_SECRETS.push(body.access_token);
  const ttl = Math.min(21000, Math.max(60, (Number(body.expires_in) || 86399) - 600)); // CacheService: максимум 6 год
  cache.put('shopify_token', body.access_token, ttl);
  return body.access_token;
}

function classifyShopifyError(e) {
  if (e.http === 429) return { retry: true, waitMs: 2000 };
  if (e.http == null || e.http >= 500) return { retry: true };
  return { retry: false };
}

function shopifyGraphql_(query, variables) {
  const domain = parseShopifyDomain(requireSecret('SHOPIFY_STORE_DOMAIN'));
  const url = 'https://' + domain + '/admin/api/' + requireSecret('SHOPIFY_API_VERSION') + '/graphql.json';
  return withRetry(
    function () {
      let resp;
      try {
        resp = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'X-Shopify-Access-Token': shopifyToken_() },
          payload: JSON.stringify({ query: query, variables: variables || {} }),
          muteHttpExceptions: true
        });
      } catch (netErr) {
        throw new Error('Shopify: мережева помилка: ' + redactSecrets_(netErr.message));
      }
      const code = resp.getResponseCode();
      const text = resp.getContentText();
      if (code >= 400) {
        const e = new Error('Shopify API: HTTP ' + code + ' ' + redactSecrets_(String(text).slice(0, 300)));
        e.http = code;
        throw e;
      }
      const body = JSON.parse(text);
      if (body.errors) throw new Error('Shopify GraphQL: ' + redactSecrets_(JSON.stringify(body.errors).slice(0, 400)));
      return body.data;
    },
    classifyShopifyError,
    { delays: [2000, 5000, 10000], sleep: function (ms) { Utilities.sleep(ms); } }
  );
}

const SHOPIFY_JOURNEY_FIELDS = 'customerJourneySummary { ready firstVisit { ' + SHOPIFY_VISIT_FIELDS + ' } lastVisit { ' + SHOPIFY_VISIT_FIELDS + ' } }';
const SHOPIFY_NAME_BATCH = 10;

function fetchByGid_(gids, out) {
  for (let i = 0; i < gids.length; i += SHOPIFY_BATCH) {
    const chunk = gids.slice(i, i + SHOPIFY_BATCH);
    const data = shopifyGraphql_(SHOPIFY_NODES_QUERY, { ids: chunk });
    chunk.forEach(function (gid, k) {
      const n = data.nodes && data.nodes[k];
      out['gid:' + gid] = n && n.customerJourneySummary ? n.customerJourneySummary : null;
    });
  }
}

// Пошук за назвою замовлення (query: name:"M-CL6309"); збіг перевіряється за точною назвою
function fetchByName_(names, out) {
  for (let i = 0; i < names.length; i += SHOPIFY_NAME_BATCH) {
    const chunk = names.slice(i, i + SHOPIFY_NAME_BATCH);
    const vars = {};
    const defs = [];
    const body = [];
    chunk.forEach(function (n, k) {
      vars['q' + k] = 'name:"' + String(n).replace(/"/g, '') + '"';
      defs.push('$q' + k + ': String!');
      body.push('o' + k + ': orders(first: 1, query: $q' + k + ') { nodes { id name ' + SHOPIFY_JOURNEY_FIELDS + ' } }');
    });
    const data = shopifyGraphql_('query(' + defs.join(', ') + ') { ' + body.join(' ') + ' }', vars);
    chunk.forEach(function (n, k) {
      const nodes = data['o' + k] && data['o' + k].nodes;
      const node = nodes && nodes[0];
      out['name:' + n] = node && String(node.name).replace(/^#/, '') === n && node.customerJourneySummary ? node.customerJourneySummary : null;
    });
  }
}

// keys (результат shopifyLookupKey) -> {key: journeySummary|null}; невідоме замовлення дає null
function fetchShopifyJourneys(keys) {
  const out = {};
  const gids = [];
  const names = [];
  keys.forEach(function (k) {
    if (k.indexOf('gid:') === 0) gids.push(k.slice(4));
    else if (k.indexOf('name:') === 0) names.push(k.slice(5));
  });
  if (gids.length) fetchByGid_(gids, out);
  if (names.length) fetchByName_(names, out);
  return out;
}

// Функція-резерв для normalizeOrder: raw замовлення KeyCRM -> UTM із Shopify:
//  - об'єкт з мітками — знайдено; {} — перевірено, міток немає; null — не застосовується / ще не перевірено.
// existing: {order_id: рядок KeyCRM_Orders}. Не питаємо Shopify повторно про:
//  - замовлення, де мітки вже знайдено (utm_origin = shopify);
//  - перевірені й порожні замовлення старші за 2 доби (utm_origin = shopify_none).
// Щоб не впертись у ліміт часу Apps Script, за один запуск робиться не більше shopify_max_lookups_per_run
// пошуків і не довше SHOPIFY_TIME_BUDGET_MS від початку запуску; найновіші замовлення — першими.
const SHOPIFY_TIME_BUDGET_MS = 240000;

function buildShopifyFallback_(raws, settings, existing, today) {
  const found = {};
  const need = [];
  const staleBefore = addDays(today, -2);
  raws.forEach(function (raw) {
    const group = classifySource(pickPath(raw, KEYCRM_FIELDS.sourceId), settings);
    if (group !== 'site' && group !== 'quickorders') return;
    if (hasAnyUtm(extractUtm_(raw))) return;
    const id = String(pickPath(raw, KEYCRM_FIELDS.id));
    const ex = existing[id];
    if (ex && ex.utm_origin === 'shopify') {
      found[id] = {
        utm_source: ex.utm_source, utm_medium: ex.utm_medium, utm_campaign: ex.utm_campaign,
        utm_content: ex.utm_content, utm_term: ex.utm_term, gclid: ex.gclid, fbclid: ex.fbclid
      };
      return;
    }
    if (ex && ex.utm_origin === 'shopify_none' && String(ex.date) <= staleBefore) {
      found[id] = {};
      return;
    }
    const key = shopifyLookupKey(raw);
    if (key) need.push({ id: id, key: key });
  });
  need.sort(function (a, b) {
    return Number(b.id) - Number(a.id);
  });
  const maxLookups = settingNumOrNull(settings, 'shopify_max_lookups_per_run') || 80;
  let done = 0;
  for (let i = 0; i < need.length; i += SHOPIFY_NAME_BATCH) {
    if (done >= maxLookups) break;
    if (RUN_START_MS && Date.now() - RUN_START_MS > SHOPIFY_TIME_BUDGET_MS) break;
    const chunk = need.slice(i, i + SHOPIFY_NAME_BATCH);
    const journeys = fetchShopifyJourneys(
      chunk.map(function (n) {
        return n.key;
      })
    );
    chunk.forEach(function (n) {
      found[n.id] = journeyToUtm(journeys[n.key]) || {};
    });
    done += chunk.length;
  }
  return function (raw) {
    const v = found[String(pickPath(raw, KEYCRM_FIELDS.id))];
    return v === undefined ? null : v;
  };
}
