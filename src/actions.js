// Мапінг Meta action_type -> внутрішні метрики (розділ 4.2). Чисті функції.
// Реальні action_type акаунта показує discoverActions().

const ACTION_MAP = {
  view_content: ['omni_view_content', 'offsite_conversion.fb_pixel_view_content', 'view_content'],
  add_to_cart: ['omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart'],
  initiate_checkout: ['omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'],
  purchases: ['omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'purchase'],
  conversations_started: ['onsite_conversion.messaging_conversation_started_7d'],
  first_replies: ['onsite_conversion.messaging_first_reply']
};
// purchase_value беремо з action_values за тими самими типами, що й purchases
const ACTION_VALUE_TYPES = ACTION_MAP.purchases;

// Значення першого знайденого типу (у порядку пріоритету types). Лише ОДИН тип — без подвійного підрахунку.
function pickActionValue(list, types) {
  if (!Array.isArray(list)) return 0;
  for (let i = 0; i < types.length; i++) {
    for (let j = 0; j < list.length; j++) {
      if (list[j].action_type === types[i]) return Number(list[j].value) || 0;
    }
  }
  return 0;
}

// Рядок Insights API (level=account) -> сирі метрики дня
function mapInsightRow(row) {
  return {
    date: row.date_start,
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    link_clicks: Number(row.inline_link_clicks) || 0,
    view_content: pickActionValue(row.actions, ACTION_MAP.view_content),
    add_to_cart: pickActionValue(row.actions, ACTION_MAP.add_to_cart),
    initiate_checkout: pickActionValue(row.actions, ACTION_MAP.initiate_checkout),
    purchases: pickActionValue(row.actions, ACTION_MAP.purchases),
    purchase_value: pickActionValue(row.action_values, ACTION_VALUE_TYPES),
    conversations_started: pickActionValue(row.actions, ACTION_MAP.conversations_started),
    first_replies: pickActionValue(row.actions, ACTION_MAP.first_replies)
  };
}

// Усі action_type з набору рядків Insights: {type: {count, sum}} (для discoverActions)
function collectActionTypes(rows) {
  const out = {};
  rows.forEach(function (row) {
    ['actions', 'action_values'].forEach(function (key) {
      (row[key] || []).forEach(function (a) {
        const k = key + ':' + a.action_type;
        if (!out[k]) out[k] = { kind: key, action_type: a.action_type, days: 0, sum: 0 };
        out[k].days += 1;
        out[k].sum += Number(a.value) || 0;
      });
    });
  });
  return out;
}
