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
  const out = [{ section: '=== ' + label, a: '', b: '', c: '', d: '', e: '', f: '' }].concat(
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
