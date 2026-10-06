// Meta Marketing API (Insights). Параметри запитів — за розділами 4.1, 4.3, 4.4 ТЗ.
// VERIFY: назви полів/параметрів не звірені з документацією (з середовища розробки вона недоступна);
// їх перевіряє discoverActions(), який друкує реальні відповіді акаунта.

const META_RETRY_CODES = [4, 17, 32, 613];

function makeMetaError_(http, body) {
  const err = (body && body.error) || {};
  const e = new Error('Meta API: HTTP ' + http + (err.code != null ? ', code ' + err.code : '') + (err.message ? ': ' + err.message : ''));
  e.http = http;
  e.metaCode = err.code;
  e.isTokenError = err.code === 190;
  return e;
}

function classifyMetaError(e) {
  if (e.isTokenError) return { retry: false };
  if (META_RETRY_CODES.indexOf(e.metaCode) !== -1) return { retry: true };
  if (e.http == null || e.http >= 500) return { retry: true }; // мережа / 5xx
  return { retry: false };
}

function metaBase_() {
  return 'https://graph.facebook.com/' + requireSecret('META_API_VERSION');
}

function toQuery_(params) {
  return Object.keys(params)
    .map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    })
    .join('&');
}

// Токен передається заголовком Authorization, а не в URL — щоб не потрапив у логи/помилки
function metaFetchJson_(url) {
  return withRetry(
    function () {
      let resp;
      try {
        resp = UrlFetchApp.fetch(url, {
          method: 'get',
          headers: { Authorization: 'Bearer ' + requireSecret('META_ACCESS_TOKEN') },
          muteHttpExceptions: true
        });
      } catch (netErr) {
        const e = new Error('Meta API: мережева помилка: ' + redactSecrets_(netErr.message));
        throw e;
      }
      const code = resp.getResponseCode();
      let body = null;
      try {
        body = JSON.parse(resp.getContentText());
      } catch (x) {
        body = null;
      }
      if (code >= 400 || (body && body.error)) throw makeMetaError_(code, body);
      return body;
    },
    classifyMetaError,
    { delays: [2000, 5000, 10000], sleep: function (ms) { Utilities.sleep(ms); } }
  );
}

// GET з пагінацією (paging.next)
function metaGetAll(path, params) {
  let url = metaBase_() + path + '?' + toQuery_(params);
  const out = [];
  for (let page = 0; page < 200 && url; page++) {
    const body = metaFetchJson_(url);
    (body.data || []).forEach(function (r) {
      out.push(r);
    });
    url = body.paging && body.paging.next ? body.paging.next : null;
  }
  return out;
}

// Узагальнений запит Insights (рівень акаунта / кампанії; для Частини Б — level=ad, breakdowns)
function fetchInsights(opts) {
  const params = {
    level: opts.level,
    time_range: JSON.stringify({ since: opts.since, until: opts.until }),
    time_increment: 1,
    fields: opts.fields,
    limit: 500,
    use_account_attribution_setting: 'true'
  };
  if (opts.breakdowns) params.breakdowns = opts.breakdowns;
  return metaGetAll('/' + requireSecret('META_AD_ACCOUNT_ID') + '/insights', params);
}

const META_ACCOUNT_FIELDS = 'spend,impressions,reach,inline_link_clicks,actions,action_values';
const META_CAMPAIGN_FIELDS = 'campaign_id,campaign_name,spend,actions';

// ---- чисті допоміжні ----

const DIRECT_DESTINATION_RE = /MESSAGING|MESSENGER|DIRECT|WHATSAPP/i; // VERIFY: реальні destination_type показує discoverActions

// adsets: [{campaign_id, destination_type}] -> масив ID Direct-кампаній (4.4)
function detectDirectCampaigns(adsets, overrideIds) {
  if (overrideIds && overrideIds.length) return overrideIds.map(String);
  const set = {};
  adsets.forEach(function (a) {
    if (a.destination_type && DIRECT_DESTINATION_RE.test(a.destination_type)) set[String(a.campaign_id)] = true;
  });
  return Object.keys(set);
}

// Рядки campaign-рівня -> {date: сума spend Direct-кампаній}
function directSpendByDate(campaignRows, directIds) {
  const out = {};
  campaignRows.forEach(function (r) {
    if (directIds.indexOf(String(r.campaign_id)) === -1) return;
    out[r.date_start] = (out[r.date_start] || 0) + (Number(r.spend) || 0);
  });
  return out;
}

// Meta не повертає рядки за дні без показів — доповнюємо нулями
function fillMissingDays(rows, from, to) {
  const byDate = {};
  rows.forEach(function (r) {
    byDate[r.date] = r;
  });
  return dateRange(from, to).map(function (d) {
    return (
      byDate[d] || {
        date: d, spend: 0, impressions: 0, reach: 0, link_clicks: 0, view_content: 0, add_to_cart: 0,
        initiate_checkout: 0, purchases: 0, purchase_value: 0, conversations_started: 0, first_replies: 0, direct_spend: 0
      }
    );
  });
}

// Повний набір днів [from, to]: рядки Meta_Daily без updated_at
function assembleMetaDays(accountRows, campaignRows, directIds, from, to) {
  const spendBy = directSpendByDate(campaignRows, directIds);
  const days = fillMissingDays(accountRows.map(mapInsightRow), from, to);
  return days.map(function (r) {
    return Object.assign({}, r, { direct_spend: Math.round((spendBy[r.date] || 0) * 100) / 100 });
  });
}

// ---- I/O-оркестрація ----

function fetchAdsets_() {
  return metaGetAll('/' + requireSecret('META_AD_ACCOUNT_ID') + '/adsets', { fields: 'campaign_id,destination_type', limit: 500 });
}

// Усе, що потрібно щоденному звіту за [from, to]: {days, directCampaigns}
function fetchMetaDays(from, to, settings) {
  const accountRows = fetchInsights({ level: 'account', since: from, until: to, fields: META_ACCOUNT_FIELDS });
  const campaignRows = fetchInsights({ level: 'campaign', since: from, until: to, fields: META_CAMPAIGN_FIELDS });
  const override = settingList(settings, 'direct_campaign_ids');
  const directIds = detectDirectCampaigns(override.length ? [] : fetchAdsets_(), override);
  return { days: assembleMetaDays(accountRows, campaignRows, directIds, from, to), directCampaigns: directIds };
}
