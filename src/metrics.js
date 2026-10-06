// Розрахунок метрик (розділ 5). Чисті функції.
// D — звітний день; AVG7 — 7 днів ДО нього (D-7…D-1); відносні метрики AVG7 — із сум.

const META_SUM_FIELDS = [
  'spend', 'impressions', 'link_clicks', 'view_content', 'add_to_cart', 'initiate_checkout',
  'purchases', 'purchase_value', 'conversations_started', 'first_replies', 'direct_spend'
];

function div_(a, b) {
  return isNum(a) && isNum(b) && b !== 0 ? a / b : null;
}

function mul_(a, k) {
  return isNum(a) ? a * k : null;
}

function sumMetaRows(rows) {
  const s = {};
  META_SUM_FIELDS.forEach(function (f) {
    s[f] = 0;
  });
  rows.forEach(function (r) {
    META_SUM_FIELDS.forEach(function (f) {
      s[f] += Number(r[f]) || 0;
    });
  });
  return s;
}

// Похідні метрики з сум (для одного дня або для суми 7 днів)
function metaDerived(s) {
  return {
    cpm: mul_(div_(s.spend, s.impressions), 1000),
    ctr: mul_(div_(s.link_clicks, s.impressions), 100),
    cpc: div_(s.spend, s.link_clicks),
    vcCost: div_(s.spend, s.view_content),
    atcCost: div_(s.spend, s.add_to_cart),
    atcPct: mul_(div_(s.add_to_cart, s.view_content), 100),
    icCost: div_(s.spend, s.initiate_checkout),
    icPct: mul_(div_(s.initiate_checkout, s.add_to_cart), 100),
    cpa: div_(s.spend, s.purchases),
    roas: div_(s.purchase_value, s.spend),
    costPerConv: div_(s.direct_spend, s.conversations_started),
    replyPct: mul_(div_(s.first_replies, s.conversations_started), 100)
  };
}

function crmSum_(rows, pred) {
  const r = { orders: 0, value: 0 };
  rows.forEach(function (x) {
    if (pred(x)) {
      r.orders += Number(x.orders) || 0;
      r.value += Number(x.value) || 0;
    }
  });
  return r;
}

const SITE_GROUPS_ = ['site', 'quickorders'];

// Метрики CRM за один день. rows — рядки CRM_Daily.
function crmDay(rows, date, pixelPurchases) {
  const day = rows.filter(function (r) {
    return r.date === date;
  });
  const site = crmSum_(day, function (r) {
    return r.channel === 'meta_ads' && r.source_group === 'site';
  });
  const quick = crmSum_(day, function (r) {
    return r.channel === 'meta_ads' && r.source_group === 'quickorders';
  });
  const direct = crmSum_(day, function (r) {
    return r.channel === 'meta_direct';
  });
  const total = {
    orders: site.orders + quick.orders + direct.orders,
    value: site.value + quick.value + direct.value
  };
  const noUtm = crmSum_(day, function (r) {
    return r.channel === 'no_utm' && SITE_GROUPS_.indexOf(r.source_group) !== -1;
  });
  const siteQoAll = crmSum_(day, function (r) {
    return SITE_GROUPS_.indexOf(r.source_group) !== -1;
  });
  const crmForPixel = site.orders + quick.orders;
  const mx = Math.max(pixelPurchases, crmForPixel);
  return {
    site: site,
    quickorders: quick,
    direct: direct,
    total: total,
    noUtm: { orders: noUtm.orders, sharePct: mul_(div_(noUtm.orders, siteQoAll.orders), 100) },
    pixelVsCrm: {
      pixel: pixelPurchases,
      crm: crmForPixel,
      diffPct: mx > 0 ? (Math.abs(pixelPurchases - crmForPixel) / mx) * 100 : null
    }
  };
}

// Усі дані для Повідомлення 1.
// metaRows — рядки Meta_Daily (мінімум D-7…D); crmRows — рядки CRM_Daily або null (KeyCRM недоступний).
function computeReport(date, metaRows, crmRows) {
  const byDate = {};
  metaRows.forEach(function (r) {
    byDate[r.date] = r;
  });
  const d1Date = addDays(date, -1);
  const avgDates = dateRange(addDays(date, -7), d1Date);

  const dRow = byDate[date] || null;
  const d1Row = byDate[d1Date] || null;
  const dSum = dRow ? sumMetaRows([dRow]) : sumMetaRows([]);
  const d1Sum = d1Row ? sumMetaRows([d1Row]) : null;
  const avgSum = sumMetaRows(
    avgDates.map(function (x) {
      return byDate[x];
    }).filter(Boolean)
  );

  const out = {
    date: date,
    hasData: !!dRow,
    d: Object.assign({}, dSum, metaDerived(dSum), {
      reach: dRow ? Number(dRow.reach) || 0 : 0,
      freq: dRow ? div_(Number(dRow.impressions) || 0, Number(dRow.reach) || 0) : null
    }),
    d1: d1Sum ? Object.assign({}, d1Sum, metaDerived(d1Sum)) : null,
    avg: Object.assign({}, metaDerived(avgSum), { spend: avgSum.spend / 7 }),
    crm: null
  };

  if (crmRows) {
    const crm = crmDay(crmRows, date, dSum.purchases);
    const directAvg = crmSum_(crmRows, function (r) {
      return r.channel === 'meta_direct' && avgDates.indexOf(r.date) !== -1;
    });
    crm.conv = {
      d: mul_(div_(crm.direct.orders, dSum.conversations_started), 100),
      avg: mul_(div_(directAvg.orders, avgSum.conversations_started), 100)
    };
    crm.cpa = div_(dSum.spend, crm.total.orders);
    crm.roas = div_(crm.total.value, dSum.spend);
    out.crm = crm;
  }
  return out;
}
