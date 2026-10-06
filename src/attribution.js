// Класифікація каналу замовлення (розділ 4.6). Чисті функції.

const UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// Стартове наповнення листа «Правила_UTM».
// Рядки з однаковими priority + channel поєднуються через І; різні priority — це АБО.
// Рядки 55, 61, 70–74 — розкладення вимог ТЗ ("fbclid без UTM -> meta_organic", "klaviyo АБО email",
// "будь-яка непорожня UTM-мітка") на правила, які вміє рушій (див. README).
const DEFAULT_UTM_RULES = [
  { priority: 10, channel: 'google_ads', field: 'gclid', operator: 'not_empty', values: '', comment: 'є gclid' },
  { priority: 20, channel: 'google_ads', field: 'utm_source', operator: 'in', values: 'google,adwords,googleads', comment: 'google + платний medium' },
  { priority: 20, channel: 'google_ads', field: 'utm_medium', operator: 'in', values: 'cpc,ppc,paid,paidsearch,pmax,shopping', comment: '' },
  { priority: 30, channel: 'meta_ads', field: 'utm_source', operator: 'in', values: 'facebook,fb,instagram,ig,meta,an,msg,messenger', comment: 'Meta + платний medium' },
  { priority: 30, channel: 'meta_ads', field: 'utm_medium', operator: 'in', values: 'paid,cpc,cpm,ppc,paid_social,paidsocial,ads', comment: '' },
  { priority: 40, channel: 'meta_ads', field: 'utm_campaign', operator: 'regex', values: '^\\d{10,}$', comment: 'динамічні параметри Meta з ID кампанії' },
  { priority: 40, channel: 'meta_ads', field: 'utm_source', operator: 'in', values: 'facebook,fb,instagram,ig,meta,an,msg', comment: '' },
  { priority: 50, channel: 'meta_organic', field: 'utm_source', operator: 'in', values: 'facebook,fb,instagram,ig,meta,linktree,linkin.bio', comment: 'без платного medium' },
  { priority: 55, channel: 'meta_organic', field: 'fbclid', operator: 'not_empty', values: '', comment: 'fbclid без UTM — не реклама Meta' },
  { priority: 60, channel: 'email', field: 'utm_source', operator: 'in', values: 'klaviyo', comment: '' },
  { priority: 61, channel: 'email', field: 'utm_medium', operator: 'in', values: 'email', comment: 'АБО до правила 60' },
  { priority: 70, channel: 'other_utm', field: 'utm_source', operator: 'not_empty', values: '', comment: 'будь-яка непорожня UTM-мітка' },
  { priority: 71, channel: 'other_utm', field: 'utm_medium', operator: 'not_empty', values: '', comment: '' },
  { priority: 72, channel: 'other_utm', field: 'utm_campaign', operator: 'not_empty', values: '', comment: '' },
  { priority: 73, channel: 'other_utm', field: 'utm_content', operator: 'not_empty', values: '', comment: '' },
  { priority: 74, channel: 'other_utm', field: 'utm_term', operator: 'not_empty', values: '', comment: '' },
  { priority: 99, channel: 'no_utm', field: 'utm_source', operator: 'regex', values: '^$', comment: 'міток немає (також запасний результат рушія)' }
];

function normUtm_(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function splitList_(s) {
  return String(s == null ? '' : s)
    .split(',')
    .map(normUtm_)
    .filter(function (x) {
      return x !== '';
    });
}

// Рядки листа -> типізовані правила
function parseRuleRows(rows) {
  return (rows || [])
    .map(function (r) {
      return {
        priority: Number(r.priority),
        channel: String(r.channel == null ? '' : r.channel).trim(),
        field: String(r.field == null ? '' : r.field).trim(),
        operator: String(r.operator == null ? '' : r.operator).trim().toLowerCase(),
        values: r.values == null ? '' : String(r.values),
        comment: r.comment || ''
      };
    })
    .filter(function (r) {
      return isFinite(r.priority) && r.channel && r.field && r.operator;
    });
}

function ruleMatches_(rule, utm) {
  const val = normUtm_(utm[rule.field]);
  switch (rule.operator) {
    case 'not_empty':
      return val !== '';
    case 'in':
      return splitList_(rule.values).indexOf(val) !== -1;
    case 'contains':
      return splitList_(rule.values).some(function (x) {
        return val.indexOf(x) !== -1;
      });
    case 'regex':
      return new RegExp(rule.values, 'i').test(val);
    default:
      return false;
  }
}

// utm: {utm_source, utm_medium, utm_campaign, utm_content, utm_term, gclid, fbclid}
function classifyChannel(sourceGroup, utm, rules) {
  if (sourceGroup === 'instagram') return 'meta_direct'; // Правило 0: джерело важливіше за мітки

  const groups = [];
  const byKey = {};
  rules.forEach(function (r) {
    const k = r.priority + '|' + r.channel;
    if (!byKey[k]) {
      byKey[k] = { priority: r.priority, channel: r.channel, rules: [] };
      groups.push(byKey[k]);
    }
    byKey[k].rules.push(r);
  });
  groups.sort(function (a, b) {
    return a.priority - b.priority;
  });
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (
      g.rules.every(function (r) {
        return ruleMatches_(r, utm);
      })
    ) {
      return g.channel;
    }
  }
  return 'no_utm';
}

// source_id -> site | quickorders | instagram | other (за налаштуваннями keycrm_source_*_ids)
function classifySource(sourceId, settings) {
  const id = String(sourceId == null ? '' : sourceId).trim();
  if (id !== '') {
    const map = [
      ['site', 'keycrm_source_site_ids'],
      ['quickorders', 'keycrm_source_quickorders_ids'],
      ['instagram', 'keycrm_source_instagram_ids']
    ];
    for (let i = 0; i < map.length; i++) {
      if (settingList(settings, map[i][1]).indexOf(id) !== -1) return map[i][0];
    }
  }
  return 'other';
}

function hasAnyUtm(utm) {
  return UTM_FIELDS.concat(['gclid', 'fbclid']).some(function (f) {
    return normUtm_(utm[f]) !== '';
  });
}

// Агрегат CRM_Daily: дата × source_group × channel, лише is_counted (розділ 2)
function buildCrmDaily(orders, dates) {
  const set = dates
    ? dates.reduce(function (o, d) {
        o[d] = true;
        return o;
      }, {})
    : null;
  const acc = {};
  const order = [];
  orders.forEach(function (o) {
    if (!toBool(o.is_counted)) return;
    if (set && !set[o.date]) return;
    const k = o.date + '|' + o.source_group + '|' + o.channel;
    if (!acc[k]) {
      acc[k] = { date: o.date, source_group: o.source_group, channel: o.channel, orders: 0, value: 0 };
      order.push(k);
    }
    acc[k].orders += 1;
    acc[k].value += Number(o.grand_total) || 0;
  });
  return order
    .map(function (k) {
      acc[k].value = Math.round(acc[k].value * 100) / 100;
      return acc[k];
    })
    .sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  return String(v).trim().toLowerCase() === 'true';
}

// Перерахунок для вже збережених замовлень (reclassifyOrders) — без запитів до API:
// channel (за правилами), а також source_group і is_counted (за поточними налаштуваннями)
function reclassifyRows(orders, rules, settings) {
  const excluded = settingList(settings, 'keycrm_excluded_status_ids');
  return orders.map(function (o) {
    const copy = {};
    Object.keys(o).forEach(function (k) {
      copy[k] = o[k];
    });
    copy.source_group = classifySource(o.source_id, settings);
    copy.is_counted = excluded.indexOf(String(o.status_id)) === -1;
    copy.channel = classifyChannel(copy.source_group, o, rules);
    return copy;
  });
}
