// Meta Marketing API (Insights). Параметри запитів — за розділами 4.1, 4.3, 4.4 ТЗ.
// VERIFY: назви полів/параметрів не звірені з документацією (з середовища розробки вона недоступна);
// їх перевіряє discoverActions(), який друкує реальні відповіді акаунта.

// 4/17/32/613 — ліміти запитів (ТЗ); 1 і 2 — тимчасові збої сервісу Meta ("Service temporarily unavailable")
const META_RETRY_CODES = [1, 2, 4, 17, 32, 613];

function makeMetaError_(http, body) {
  const err = (body && body.error) || {};
  const e = new Error(
    'Meta API: HTTP ' + http + (err.code != null ? ', code ' + err.code : '') + (err.error_subcode != null ? ', subcode ' + err.error_subcode : '') + (err.message ? ': ' + err.message : '')
  );
  e.http = http;
  e.metaCode = err.code;
  e.metaSubcode = err.error_subcode;
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
  return metaGetAll('/' + opts.accountId + '/insights', params);
}

const META_ACCOUNT_FIELDS = 'spend,impressions,reach,inline_link_clicks,actions,action_values';
// 21.10.2026 запит з усіма полями разом повернув spend/impressions/reach = 0 за дні з кліками, хоча Ads Manager показував
// нормальні витрати. Тому дані акаунта беруться трьома окремими простими запитами й склеюються за датою.
const META_ACCOUNT_FIELD_SETS = ['spend,impressions,reach', 'inline_link_clicks', 'actions,action_values'];
const META_CAMPAIGN_FIELDS = 'campaign_id,spend'; // actions і назва не потрібні — швидший запит

// ---- чисті допоміжні ----

// Склеює рядки кількох запитів Insights за date_start. З кожного запиту береться ЛИШЕ те, що в ньому просили:
// 21.10.2026 запит із inline_link_clicks або actions повертав spend = 0 і impressions = 0 (діагностика checkSpend),
// тож чужі поля з відповіді не можна переносити — вони затерли б правильні витрати з простого запиту.
// sets: [{fields: 'spend,impressions,reach', rows: [...]}, ...] -> рядки за датою (відсортовано)
function mergeInsightRowSets(sets) {
  const byDate = {};
  sets.forEach(function (set) {
    const keys = String(set.fields).split(',');
    set.rows.forEach(function (r) {
      const acc = byDate[r.date_start] || (byDate[r.date_start] = { date_start: r.date_start });
      keys.forEach(function (k) {
        if (r[k] !== undefined) acc[k] = r[k];
      });
    });
  });
  return Object.keys(byDate)
    .sort()
    .map(function (d) {
      return byDate[d];
    });
}

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


// Чисте: чи є серед адсетів кампанії Direct-адсети
function isDirectAdsets(adsets) {
  return (adsets || []).some(function (a) {
    return a.destination_type && DIRECT_DESTINATION_RE.test(a.destination_type);
  });
}

// Чисте: які з АКТИВНИХ кампаній (були витрати за період) є Direct.
// cache = {yes: {id: true}, no: {id: true}} доповнюється; для відомих кампаній запитів до Meta немає.
function resolveDirectCampaigns(activeIds, cache, fetchAdsets) {
  const out = [];
  activeIds.forEach(function (raw) {
    const id = String(raw);
    if (cache.yes[id]) {
      out.push(id);
      return;
    }
    if (cache.no[id]) return;
    const direct = isDirectAdsets(fetchAdsets(id));
    (direct ? cache.yes : cache.no)[id] = true;
    if (direct) out.push(id);
  });
  return out;
}

function loadDirectCache_() {
  const p = PropertiesService.getScriptProperties();
  function toSet(str) {
    const o = {};
    String(str || '').split(',').forEach(function (x) {
      if (x) o[x] = true;
    });
    return o;
  }
  return { yes: toSet(p.getProperty('direct_cache_yes')), no: toSet(p.getProperty('direct_cache_no')) };
}

// Властивість скрипта обмежена ~9 КБ: зберігаємо до 400 останніх ID в кожному списку
function saveDirectCache_(cache) {
  function pack(o) {
    return Object.keys(o).slice(-400).join(',');
  }
  PropertiesService.getScriptProperties().setProperties({ direct_cache_yes: pack(cache.yes), direct_cache_no: pack(cache.no) });
}

function fetchCampaignAdsets_(campaignId) {
  return metaGetAll('/' + campaignId + '/adsets', { fields: 'destination_type', limit: 100 });
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

// Суперечливі дні: витрати й покази = 0, але є кліки по посиланнях або витрати Direct (по кампаніях). Так виглядала
// відповідь Meta 21.10.2026 (spend/impressions = 0 за дні з кліками): такі дані не можна писати в Meta_Daily
// (вони затирають правильні) і не можна показувати як «реклама не крутилась».
// Покупки, розмови й перегляди тут НЕ враховуються: Meta може рахувати події на день конверсії, тож у день без
// витрат вони бувають справжніми (хибне спрацювання 21.10 на акаунті без витрат 19.10).
function findInconsistentMetaDays(days) {
  return days
    .filter(function (d) {
      const noSpend = !(Number(d.spend) > 0) && !(Number(d.impressions) > 0);
      return noSpend && (Number(d.link_clicks) > 0 || Number(d.direct_spend) > 0);
    })
    .map(function (d) {
      return d.date;
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

function fetchAdsets_(accountId) {
  return metaGetAll('/' + accountId + '/adsets', { fields: 'campaign_id,destination_type', limit: 500 });
}

// META_AD_ACCOUNT_ID може містити кілька акаунтів через кому: "act_1, act_2".
// Голі числа отримують префікс act_.
function parseAccountIds(raw) {
  return String(raw == null ? '' : raw)
    .split(',')
    .map(function (x) {
      return x.trim();
    })
    .filter(function (x) {
      return x !== '';
    })
    .map(function (x) {
      return /^\d+$/.test(x) ? 'act_' + x : x;
    });
}

function getMetaAccountIds() {
  const ids = parseAccountIds(requireSecret('META_AD_ACCOUNT_ID'));
  if (!ids.length) throw new Error('META_AD_ACCOUNT_ID порожній');
  return ids;
}

// Складає дні кількох акаунтів в один набір: усі метрики — суми по датах.
// УВАГА: reach між акаунтами додається як є (дублікати людей не усуваються), тому "Частота акаунта"
// при кількох акаунтах трохи занижена.
function mergeAccountDays(daysPerAccount) {
  const byDate = {};
  const order = [];
  daysPerAccount.forEach(function (days) {
    days.forEach(function (d) {
      if (!byDate[d.date]) {
        byDate[d.date] = Object.assign({}, d);
        order.push(d.date);
        return;
      }
      const acc = byDate[d.date];
      Object.keys(d).forEach(function (k) {
        if (k !== 'date') acc[k] = (Number(acc[k]) || 0) + (Number(d[k]) || 0);
      });
    });
  });
  return order.sort().map(function (date) {
    const r = byDate[date];
    // суми дробових чисел дають "хвости" на кшталт 5046.4400000000005 — грошові поля округлюємо до копійок
    ['spend', 'purchase_value', 'direct_spend'].forEach(function (k) {
      r[k] = Math.round((Number(r[k]) || 0) * 100) / 100;
    });
    return r;
  });
}

// ---- валюта рахунку -> UAH ----
// Рекламні акаунти можуть бути в USD, а замовлення KeyCRM — у гривнях. Без конвертації CPA і ROAS "за CRM"
// були б неправильними в десятки разів, тому витрати й цінність покупок переводяться в UAH до запису в Meta_Daily.

// Адреси НБУ (VERIFY: старий шлях /statdirective/exchange повертає 404). Пробуються по черзі.
function nbuUrls(cc, ymd) {
  const d = ymd.replace(/-/g, '');
  return [
    'https://bank.gov.ua/NBU_Exchange/exchange_site?start=' + d + '&end=' + d + '&valcode=' + encodeURIComponent(String(cc).toLowerCase()) + '&sort=exchangedate&order=desc&json', // працює (перевірено)
    'https://bank.gov.ua/NBUStatService/v1/statdirective/exchangenew?json&valcode=' + encodeURIComponent(cc) + '&date=' + d // 404 під час перевірки; лишено як запасну
  ];
}

// Відповідь НБУ -> курс (грн за 1 одиницю) або null
function parseNbuRate(body, cc) {
  if (!Array.isArray(body)) return null;
  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    if (String(r.cc).toUpperCase() === String(cc).toUpperCase() && Number(r.rate) > 0) return Number(r.rate);
  }
  return null;
}

// Курс НБУ на дату; якщо на дату даних немає (вихідні/свята) — найближча попередня (до 7 днів назад).
// Причину невдачі (HTTP-код / початок відповіді / виняток) додає в текст помилки.
function fetchNbuRate_(cc, ymd, cache) {
  let lastInfo = '';
  for (let back = 0; back <= 7; back++) {
    const d = addDays(ymd, -back);
    const key = cc + '|' + d;
    if (cache[key] === undefined) {
      let rate = null;
      const urls = nbuUrls(cc, d);
      for (let u = 0; u < urls.length && !rate; u++) {
        try {
          const resp = UrlFetchApp.fetch(urls[u], { muteHttpExceptions: true });
          const code = resp.getResponseCode();
          const text = resp.getContentText();
          if (code === 200) rate = parseNbuRate(JSON.parse(text), cc);
          if (!rate) lastInfo = 'HTTP ' + code + ': ' + String(text).slice(0, 120).replace(/\s+/g, ' ');
        } catch (e) {
          lastInfo = 'виняток: ' + String(e && e.message ? e.message : e).slice(0, 160);
        }
      }
      cache[key] = rate;
    }
    if (cache[key]) return cache[key];
  }
  throw new Error('Не вдалося отримати курс НБУ для ' + cc + ' на ' + ymd + (lastInfo ? ' (' + lastInfo + ')' : ''));
}

// {date: курс} для днів у валюті currency.
// Режим nbu: курс НБУ на кожну дату; якщо НБУ недоступний і заповнено meta_fx_fixed_rate — береться він
// (cache.fallbackUsed = true), інакше помилка. Режим fixed: лише meta_fx_fixed_rate.
function getFxRates_(currency, dates, settings, cache) {
  const out = {};
  if (String(currency).toUpperCase() === 'UAH') {
    dates.forEach(function (d) {
      out[d] = 1;
    });
    return out;
  }
  const fixed = settingNumOrNull(settings, 'meta_fx_fixed_rate');
  if (String(settings.meta_fx_mode).trim().toLowerCase() === 'fixed') {
    if (!(fixed > 0)) throw new Error('meta_fx_mode = fixed, але meta_fx_fixed_rate не заповнено');
    dates.forEach(function (d) {
      out[d] = fixed;
    });
    return out;
  }
  dates.forEach(function (d) {
    try {
      out[d] = fetchNbuRate_(currency, d, cache);
    } catch (e) {
      if (fixed > 0) {
        out[d] = fixed;
        cache.fallbackUsed = true;
      } else {
        throw e;
      }
    }
  });
  return out;
}

// Чисте: переводить грошові поля днів у UAH за курсами по датах. reach/покази/події не змінюються.
// Піксель інколи передає цінність покупки в гривнях, але Meta вважає її валютою акаунта (USD): тоді одна покупка
// "коштує" сотні й тисячі. Якщо середня цінність покупки за день > PURCHASE_VALUE_RAW_PER_ORDER (у валюті акаунта),
// вважаємо її вже в UAH і не множимо на курс.
const PURCHASE_VALUE_RAW_PER_ORDER = 150;

function convertDaysToUah(days, ratesByDate) {
  return days.map(function (d) {
    const k = ratesByDate[d.date];
    if (!(k > 0)) throw new Error('Немає курсу для ' + d.date);
    const valueIsUah = d.purchases > 0 && d.purchase_value / d.purchases > PURCHASE_VALUE_RAW_PER_ORDER;
    return Object.assign({}, d, {
      spend: Math.round(d.spend * k * 100) / 100,
      purchase_value: Math.round(d.purchase_value * (valueIsUah ? 1 : k) * 100) / 100,
      direct_spend: Math.round(d.direct_spend * k * 100) / 100
    });
  });
}

function fetchAccountCurrency_(accountId) {
  const body = metaFetchJson_(metaBase_() + '/' + accountId + '?fields=currency'); // VERIFY: поле currency рекламного акаунта
  if (!body || !body.currency) throw new Error('Meta: не вдалося визначити валюту акаунта ' + accountId);
  return body.currency;
}

// Доба в Insights рахується за часовою зоною рекламного акаунта, а звіт — за Києвом. Якщо зони різні, межі днів
// не збігаються з KeyCRM. Запит best-effort: помилка (або невідоме поле) не повинна ламати звіт — повертаємо ''.
function fetchAccountTimezone_(accountId) {
  try {
    const body = metaFetchJson_(metaBase_() + '/' + accountId + '?fields=timezone_name');
    return body && body.timezone_name ? String(body.timezone_name) : '';
  } catch (e) {
    return '';
  }
}

// Один акаунт: {days (у UAH), directCampaigns (з витратами за період), currency, timezone}
function fetchMetaAccountDays_(accountId, from, to, settings, fxCache, dirCache) {
  const accountRows = mergeInsightRowSets(
    META_ACCOUNT_FIELD_SETS.map(function (fields) {
      return { fields: fields, rows: fetchInsights({ accountId: accountId, level: 'account', since: from, until: to, fields: fields }) };
    })
  );
  const campaignRows = fetchInsights({ accountId: accountId, level: 'campaign', since: from, until: to, fields: META_CAMPAIGN_FIELDS });
  const override = settingList(settings, 'direct_campaign_ids');
  let directIds;
  if (override.length) {
    directIds = override.map(String);
  } else {
    // Лише кампанії з витратами за період; відомі беруться з кешу, для нових — один запит на кампанію
    const activeMap = {};
    campaignRows.forEach(function (r) {
      if ((Number(r.spend) || 0) > 0) activeMap[String(r.campaign_id)] = true;
    });
    directIds = resolveDirectCampaigns(Object.keys(activeMap), dirCache, fetchCampaignAdsets_);
  }
  const currency = fetchAccountCurrency_(accountId);
  const timezone = fetchAccountTimezone_(accountId);
  const days = assembleMetaDays(accountRows, campaignRows, directIds, from, to);
  const inconsistent = findInconsistentMetaDays(days);
  if (inconsistent.length) {
    const e = new Error('Meta повернула суперечливі дані: витрати й покази = 0, але є кліки/події за ' + inconsistent.length + ' дн. (' + inconsistent.slice(0, 8).join(', ') + ')');
    e.metaInconsistent = true;
    throw e;
  }
  const rates = getFxRates_(currency, dateRange(from, to), settings, fxCache);
  const active = {};
  campaignRows.forEach(function (r) {
    if ((Number(r.spend) || 0) > 0) active[String(r.campaign_id)] = true;
  });
  return {
    days: convertDaysToUah(days, rates),
    // у Лог — лише Direct-кампанії, що мали витрати за період (повний список може бути сотнями архівних)
    directCampaigns: directIds.filter(function (id) {
      return active[id];
    }),
    currency: currency,
    timezone: timezone
  };
}

// Усе, що потрібно щоденному звіту за [from, to], сума по всіх акаунтах (у UAH):
// {days, directCampaigns, currencies: {акаунт: валюта}}
function fetchMetaDays(from, to, settings) {
  const fxCache = {};
  const currencies = {};
  const timezones = {};
  const dirCache = loadDirectCache_();
  const per = getMetaAccountIds().map(function (id) {
    try {
      const r = fetchMetaAccountDays_(id, from, to, settings, fxCache, dirCache);
      currencies[id] = r.currency;
      timezones[id] = r.timezone;
      return r;
    } catch (e) {
      e.message = '[' + id + '] ' + e.message; // нехай алерт покаже, який акаунт підвів
      throw e;
    }
  });
  saveDirectCache_(dirCache);
  const direct = [];
  per.forEach(function (p) {
    p.directCampaigns.forEach(function (c) {
      if (direct.indexOf(c) === -1) direct.push(c);
    });
  });
  return {
    days: mergeAccountDays(
      per.map(function (p) {
        return p.days;
      })
    ),
    directCampaigns: direct,
    currencies: currencies,
    timezones: timezones,
    fxFallback: !!fxCache.fallbackUsed
  };
}
