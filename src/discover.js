// discoverActions() і discoverKeycrm(): показують РЕАЛЬНІ дані акаунтів, щоб звірити мапінг і поля
// (замість припущень про документацію). Результат — лист «Discover» (дописується) і «Лог».
// У вивід не потрапляють персональні дані покупців: лише структура полів, ID, статуси, UTM.

function hasUtmMarks_(utm) {
  return UTM_FIELDS.some(function (f) {
    return normUtm_(utm[f]) !== '';
  });
}

function extractUtm_(raw) {
  const u = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'].forEach(function (k) {
    u[k] = String(pickPath(raw, KEYCRM_FIELDS[k]));
  });
  return u;
}

// Структура об'єкта: ["path: тип", ...] без значень
function describeStructure(obj, prefix, depth) {
  const out = [];
  if (obj == null || typeof obj !== 'object' || depth < 0) return out;
  Object.keys(obj).forEach(function (k) {
    const path = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (Array.isArray(v)) {
      out.push(path + ': array(' + v.length + ')');
      if (v.length && typeof v[0] === 'object') describeStructure(v[0], path + '[0]', depth - 1).forEach(function (x) {
        out.push(x);
      });
    } else if (v !== null && typeof v === 'object') {
      out.push(path + ': object');
      describeStructure(v, path, depth - 1).forEach(function (x) {
        out.push(x);
      });
    } else {
      out.push(path + ': ' + (v === null ? 'null' : typeof v));
    }
  });
  return out;
}

// За source_id: {orders, withUtm}
function utmShareBySource(rawOrders) {
  const by = {};
  rawOrders.forEach(function (raw) {
    const sid = String(pickPath(raw, KEYCRM_FIELDS.sourceId));
    if (!by[sid]) by[sid] = { orders: 0, withUtm: 0 };
    by[sid].orders += 1;
    if (hasUtmMarks_(extractUtm_(raw))) by[sid].withUtm += 1;
  });
  return by;
}

// Частотна таблиця utm_source × utm_medium: [{source, medium, count}] за спаданням
function utmFrequency(rawOrders) {
  const acc = {};
  rawOrders.forEach(function (raw) {
    const u = extractUtm_(raw);
    const k = normUtm_(u.utm_source) + '\u0001' + normUtm_(u.utm_medium);
    acc[k] = (acc[k] || 0) + 1;
  });
  return Object.keys(acc)
    .map(function (k) {
      const p = k.split('\u0001');
      return { source: p[0] || '(порожньо)', medium: p[1] || '(порожньо)', count: acc[k] };
    })
    .sort(function (a, b) {
      return b.count - a.count;
    });
}

function discoverOut_(store, label, rows) {
  const out = [{ section: '▶ ' + label, a: '', b: '', c: '', d: '', e: '', f: '' }].concat(
    rows.map(function (r) {
      return { section: label, a: r[0], b: r[1], c: r[2], d: r[3], e: r[4], f: r[5] };
    })
  );
  store.append('Discover', out);
}

function discoverActions() {
  const deps = defaultDeps();
  const to = yesterday_(deps);
  const from = addDays(to, -6);
  const stamp = dateTimeInTz(deps.now(), KYIV_TZ);

  let rows = [];
  let adsets = [];
  getMetaAccountIds().forEach(function (id) {
    rows = rows.concat(fetchInsights({ accountId: id, level: 'account', since: from, until: to, fields: META_ACCOUNT_FIELDS }));
    adsets = adsets.concat(fetchAdsets_(id));
  });
  const types = collectActionTypes(rows);
  const picked = {};
  Object.keys(ACTION_MAP).forEach(function (metric) {
    const present = ACTION_MAP[metric].filter(function (t) {
      return types['actions:' + t];
    });
    picked[metric] = present[0] || '(НЕ ЗНАЙДЕНО)';
  });
  const sheetRows = Object.keys(types)
    .sort()
    .map(function (k) {
      const t = types[k];
      return [t.kind, t.action_type, 'днів: ' + t.days, 'сума: ' + t.sum, '', ''];
    });
  Object.keys(picked).forEach(function (m) {
    sheetRows.push(['мапінг', m, picked[m], 'варіанти: ' + ACTION_MAP[m].join(' > '), '', '']);
  });

  const dest = {};
  adsets.forEach(function (a) {
    dest[a.destination_type || '(немає)'] = (dest[a.destination_type || '(немає)'] || 0) + 1;
  });
  Object.keys(dest).forEach(function (k) {
    sheetRows.push(['destination_type', k, 'адсетів: ' + dest[k], '', '', '']);
  });
  const direct = detectDirectCampaigns(adsets, settingList(deps.getSettings(), 'direct_campaign_ids'));
  sheetRows.push(['Direct-кампанії', direct.join(', ') || '(немає)', '', '', '', '']);
  sheetRows.push(['акаунти Meta', getMetaAccountIds().join(', '), '', '', '', '']);
  const fxCache = {};
  getMetaAccountIds().forEach(function (id) {
    try {
      const cur = fetchAccountCurrency_(id);
      let rate = 'курс не потрібен';
      if (String(cur).toUpperCase() !== 'UAH') {
        try {
          rate = String(getFxRates_(cur, [to], deps.getSettings(), fxCache)[to]);
        } catch (e) {
          rate = 'помилка курсу: ' + errText_(e);
        }
      }
      sheetRows.push(['валюта акаунта', id, cur, 'курс на ' + to + ': ' + rate, '', '']);
    } catch (e) {
      sheetRows.push(['валюта акаунта', id, 'помилка: ' + errText_(e), '', '', '']);
    }
  });

  discoverOut_(deps.store, 'discoverActions ' + stamp + ' (' + from + '…' + to + ')', sheetRows);
  sheetRows.forEach(function (r) {
    deps.log('INFO', 'discoverActions: ' + r.filter(Boolean).join(' | '));
  });
  console.log('discoverActions: результат у листі «Discover» і «Лог»');
}

function discoverKeycrm() {
  const deps = defaultDeps();
  const settings = deps.getSettings();
  const to = yesterday_(deps);
  const from = addDays(to, -29);
  const stamp = dateTimeInTz(deps.now(), KYIV_TZ);
  const out = [];

  const sources = keycrmGetAll(KEYCRM_ENDPOINTS.sources, {});
  const sourceName = {};
  sources.forEach(function (s) {
    sourceName[String(s.id)] = s.name || '';
    out.push(['джерело', s.id, s.name, '', '', '']);
  });

  keycrmGetAll(KEYCRM_ENDPOINTS.statuses, {}).forEach(function (st) {
    const scalars = Object.keys(st)
      .filter(function (k) {
        return st[k] === null || typeof st[k] !== 'object';
      })
      .map(function (k) {
        return k + '=' + st[k];
      })
      .join('; ');
    out.push(['статус', st.id, st.name, scalars, '', '']);
  });

  const raw = fetchKeycrmRawOrders(from, to, settings);
  out.push(['замовлень за 30 днів (з запасом ±1 доба)', raw.length, '', '', '', '']);
  if (raw.length) {
    describeStructure(raw[0], '', 3).forEach(function (line) {
      out.push(['структура замовлення', line, '', '', '', '']);
    });
  }

  // 10 останніх замовлень кожного джерела з UTM-полями
  const bySource = {};
  raw.forEach(function (o) {
    const sid = String(pickPath(o, KEYCRM_FIELDS.sourceId));
    (bySource[sid] = bySource[sid] || []).push(o);
  });
  Object.keys(bySource).forEach(function (sid) {
    bySource[sid]
      .sort(function (a, b) {
        return parseTimestamp(pickPath(b, KEYCRM_FIELDS.createdAt), 'UTC') - parseTimestamp(pickPath(a, KEYCRM_FIELDS.createdAt), 'UTC');
      })
      .slice(0, 10)
      .forEach(function (o) {
        const u = extractUtm_(o);
        out.push([
          'останні замовлення ' + sid + ' (' + sourceName[sid] + ')',
          'id=' + pickPath(o, KEYCRM_FIELDS.id) + ' created_at=' + pickPath(o, KEYCRM_FIELDS.createdAt) + ' status=' + pickPath(o, KEYCRM_FIELDS.statusId),
          'src=' + u.utm_source + ' med=' + u.utm_medium + ' camp=' + u.utm_campaign,
          'content=' + u.utm_content + ' term=' + u.utm_term,
          'gclid=' + (u.gclid ? 'є' : '') + ' fbclid=' + (u.fbclid ? 'є' : ''),
          'marketing(raw)=' + JSON.stringify(o.marketing === undefined ? null : o.marketing)
        ]);
      });
  });

  // зв'язок із зовнішньою системою (Shopify): ідентифікатори, що не є персональними даними
  const linkSources = settingList(settings, 'keycrm_source_site_ids').concat(settingList(settings, 'keycrm_source_quickorders_ids'));
  linkSources.forEach(function (sid) {
    (bySource[sid] || []).slice(0, 5).forEach(function (o) {
      out.push([
        "зв'язок з Shopify, джерело " + sid,
        'id=' + o.id,
        'source_uuid=' + o.source_uuid,
        'global_source_uuid=' + o.global_source_uuid,
        'status_on_source=' + o.status_on_source,
        'ordered_at=' + o.ordered_at
      ]);
    });
  });

  // частка замовлень з UTM за джерелами + висновок про Shopify (4.7)
  const share = utmShareBySource(raw);
  Object.keys(share).forEach(function (sid) {
    const pct = share[sid].orders ? Math.round((share[sid].withUtm / share[sid].orders) * 1000) / 10 : 0;
    const verdict = pct >= 70 ? 'Shopify-резерв НЕ потрібен' : 'ПОТРІБЕН резерв UTM з Shopify (<70%)';
    out.push(['частка з UTM', sid + ' (' + sourceName[sid] + ')', 'замовлень: ' + share[sid].orders, 'з UTM: ' + share[sid].withUtm, pct + '%', verdict]);
  });

  utmFrequency(raw).forEach(function (r) {
    out.push(['utm_source × utm_medium', r.source, r.medium, r.count, '', '']);
  });

  discoverOut_(deps.store, 'discoverKeycrm ' + stamp, out);
  deps.log('INFO', 'discoverKeycrm: результат (' + out.length + ' рядків) у листі «Discover»');
  console.log('discoverKeycrm: результат у листі «Discover»');
}

// Діагностика курсу НБУ: що саме повертає bank.gov.ua при запиті з Apps Script (усі адреси з nbuUrls)
function checkFxRate() {
  const deps = defaultDeps();
  const ymd = yesterday_(deps);
  const rows = [];
  nbuUrls('USD', ymd).forEach(function (url, i) {
    rows.push(['запит ' + (i + 1), url, '', '', '', '']);
    try {
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const text = resp.getContentText();
      rows.push(['  HTTP-код', resp.getResponseCode(), '', '', '', '']);
      rows.push(['  початок відповіді', String(text).slice(0, 300), '', '', '', '']);
      let rate = null;
      try {
        rate = parseNbuRate(JSON.parse(text), 'USD');
      } catch (e) {
        rate = null;
      }
      rows.push(['  розібраний курс USD', rate === null ? 'НЕ РОЗІБРАНО' : rate, '', '', '', '']);
    } catch (e) {
      rows.push(['  виняток', errText_(e), '', '', '', '']);
    }
  });
  discoverOut_(deps.store, 'checkFxRate ' + dateTimeInTz(deps.now(), KYIV_TZ), rows);
  console.log('checkFxRate: результат у листі «Discover»');
}

// Діагностика Shopify: автентифікація, зв'язок замовлень KeyCRM -> Shopify і мітки з "шляху клієнта".
// У вивід не потрапляють персональні дані: лише ID/номер замовлення, джерело переходу, UTM, шлях сторінки.
function checkShopify() {
  const deps = defaultDeps();
  const settings = deps.getSettings();
  const to = yesterday_(deps);
  const rows = [];
  try {
    shopifyToken_();
    rows.push(['автентифікація', 'OK', '', '', '', '']);
  } catch (e) {
    rows.push(['автентифікація', 'ПОМИЛКА', errText_(e), '', '', '']);
    discoverOut_(deps.store, 'checkShopify ' + dateTimeInTz(deps.now(), KYIV_TZ), rows);
    return;
  }
  const siteIds = settingList(settings, 'keycrm_source_site_ids').concat(settingList(settings, 'keycrm_source_quickorders_ids'));
  const raws = fetchKeycrmRawOrders(addDays(to, -6), to, settings).filter(function (r) {
    return siteIds.indexOf(String(pickPath(r, KEYCRM_FIELDS.sourceId))) !== -1;
  });
  rows.push(['замовлень KeyCRM (сайт+QuickOrders) за 7 днів', raws.length, '', '', '', '']);
  const sample = raws.slice(0, 12);
  sample.forEach(function (r) {
    rows.push(['KeyCRM order', 'id=' + r.id, 'source_uuid=' + r.source_uuid, 'ключ пошуку=' + (shopifyLookupKey(r) || 'немає (не Shopify)'), '', '']);
  });
  const keys = sample
    .map(shopifyLookupKey)
    .filter(Boolean);
  if (keys.length) {
    try {
      const journeys = fetchShopifyJourneys(keys);
      keys.forEach(function (key) {
        const j = journeys[key];
        if (!j) {
          rows.push(['Shopify', key, 'замовлення не знайдено або немає journey', '', '', '']);
          return;
        }
        const utm = journeyToUtm(j);
        rows.push([
          'Shopify',
          key,
          'ready=' + j.ready,
          utm ? 'src=' + utm.utm_source + ' med=' + utm.utm_medium + ' camp=' + utm.utm_campaign + ' content=' + utm.utm_content : 'UTM НЕМАЄ',
          'last: ' + String(j.lastVisit && j.lastVisit.landingPage).slice(0, 150) + ' | src=' + String(j.lastVisit && j.lastVisit.source),
          'first: ' + String(j.firstVisit && j.firstVisit.landingPage).slice(0, 150)
        ]);
      });
    } catch (e) {
      rows.push(['Shopify GraphQL', 'ПОМИЛКА', errText_(e), '', '', '']);
    }
  }
  discoverOut_(deps.store, 'checkShopify ' + dateTimeInTz(deps.now(), KYIV_TZ), rows);
  console.log('checkShopify: результат у листі «Discover»');
}

// Чисте: підсумок замовлень за день для діагностики.
// Повертає {byStatus: [{key, orders, sum}], byChannel: [{key, orders}], total}
function summarizeOrdersForDay(orders, date) {
  const day = orders.filter(function (o) {
    return o.date === date;
  });
  const st = {};
  const ch = {};
  day.forEach(function (o) {
    const k = o.source_group + ' | статус ' + o.status_id + ' ' + (o.status_name || '') + ' | враховується: ' + (toBool(o.is_counted) ? 'так' : 'НІ');
    st[k] = st[k] || { key: k, orders: 0, sum: 0 };
    st[k].orders += 1;
    st[k].sum += Number(o.grand_total) || 0;
    if (toBool(o.is_counted)) {
      const k2 = o.source_group + ' | канал ' + o.channel + ' | мітки: ' + o.utm_origin;
      ch[k2] = ch[k2] || { key: k2, orders: 0 };
      ch[k2].orders += 1;
    }
  });
  function arr(o) {
    return Object.keys(o)
      .sort()
      .map(function (k) {
        return o[k];
      });
  }
  return { byStatus: arr(st), byChannel: arr(ch), total: day.length };
}

// Діагностика дня: замовлення за джерелами/статусами/каналами + останні попередження з Лог (причини збоїв)
function checkDay() {
  const deps = defaultDeps();
  const date = yesterday_(deps);
  const orders = deps.store.read('KeyCRM_Orders');
  const sum = summarizeOrdersForDay(orders, date);
  const rows = [['день', date, 'усього замовлень у таблиці за день: ' + sum.total, '', '', '']];
  sum.byStatus.forEach(function (r) {
    rows.push(['джерело/статус', r.key, 'замовлень: ' + r.orders, 'сума: ' + Math.round(r.sum), '', '']);
  });
  sum.byChannel.forEach(function (r) {
    rows.push(['канал/мітки', r.key, 'замовлень: ' + r.orders, '', '', '']);
  });
  const origins = {};
  orders.forEach(function (o) {
    origins[o.utm_origin] = (origins[o.utm_origin] || 0) + 1;
  });
  rows.push(['усього рядків KeyCRM_Orders', orders.length, 'за походженням міток: ' + JSON.stringify(origins), '', '', '']);
  deps.store
    .read('Лог')
    .filter(function (r) {
      return r.level === 'WARN' || r.level === 'ERROR';
    })
    .slice(-12)
    .forEach(function (r) {
      rows.push(['Лог ' + r.level, r.timestamp, String(r.message).slice(0, 400), '', '', '']);
    });
  // список замовлень Monoclo за день з датою створення і датою замовлення (для звірки з KeyCRM)
  try {
    const settings = deps.getSettings();
    const ids = settingList(settings, 'keycrm_source_site_ids')
      .concat(settingList(settings, 'keycrm_source_quickorders_ids'))
      .concat(settingList(settings, 'keycrm_source_instagram_ids'));
    const listed = [];
    fetchKeycrmRawOrders(addDays(date, -1), addDays(date, 1), settings).forEach(function (r) {
      const sid = String(pickPath(r, KEYCRM_FIELDS.sourceId));
      if (ids.indexOf(sid) === -1) return;
      const c = parseTimestamp(pickPath(r, KEYCRM_FIELDS.createdAt), 'UTC');
      const od = parseTimestamp(r.ordered_at, 'UTC');
      const cDay = isFinite(c) ? dateInTz(new Date(c), KYIV_TZ) : '';
      const oDay = isFinite(od) ? dateInTz(new Date(od), KYIV_TZ) : '';
      if (cDay !== date && oDay !== date) return;
      listed.push([
        'замовлення ' + classifySource(sid, settings),
        'id=' + r.id + ' статус=' + r.status_id,
        'створено(Київ)=' + (isFinite(c) ? dateTimeInTz(new Date(c), KYIV_TZ) : '?'),
        'замовлено(Київ)=' + (isFinite(od) ? dateTimeInTz(new Date(od), KYIV_TZ) : '?'),
        'сума=' + r.grand_total,
        cDay !== oDay ? 'ДАТИ РІЗНІ' : ''
      ]);
    });
    listed.sort(function (a, b) {
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    listed.slice(0, 70).forEach(function (r) {
      rows.push(r);
    });
  } catch (e) {
    rows.push(['список замовлень', 'ПОМИЛКА', errText_(e), '', '', '']);
  }
  discoverOut_(deps.store, 'checkDay ' + dateTimeInTz(deps.now(), KYIV_TZ), rows);
  console.log('checkDay: результат у листі «Discover»');
}
