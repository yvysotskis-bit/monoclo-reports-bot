// Повідомлення 1 «Загальна картина» (розділи 6–7). Чиста функція: дані + налаштування -> текст.

const CRM_UNAVAILABLE = 'дані KeyCRM недоступні';

function withIcon_(text, icon) {
  return icon ? text + ' ' + icon : text;
}

// data — результат computeReport(); settings — з листа «Налаштування»
function buildMetaMsg1(data, settings) {
  const head = formatDdMm(data.date);
  if (!data.hasData || !(data.d.spend > 0)) {
    return head + ' реклама не крутилась (spend 0)';
  }

  const band = settingNum(settings, 'color_band_pct');
  const trend = settingNum(settings, 'trend_band_pct');
  const d = data.d;
  const d1 = data.d1;
  const a = data.avg;
  const crm = data.crm;
  const L = [];

  function d1v(key, fmt) {
    return d1 ? fmt(d1[key]) : DASH;
  }
  const pctCtr = function (v) {
    return fmtPct(v, 'ctr');
  };
  const cpmFmt = function (v) {
    return fmtUah(v, { integer: true });
  };

  L.push('🎯 MONOCLO · META · ' + head + ' (' + weekdayUa(data.date) + ')');
  L.push('порівняння: вчора │ середнє 7 днів');
  L.push('');

  L.push('💸 ВИТРАТИ');
  L.push(
    withIcon_(
      'Spend: ' + fmtInt(d.spend) + ' грн │ ' + d1v('spend', fmtInt) + ' │ ' + fmtInt(a.spend),
      trendArrow(d.spend, a.spend, trend)
    )
  );
  L.push('Показів: ' + fmtInt(d.impressions) + ' · Охоплення: ' + fmtInt(d.reach));
  L.push(
    withIcon_(
      'Частота акаунта: ' + fmtFreq(d.freq),
      colorFreq(d.freq, settingNum(settings, 'freq_yellow'), settingNum(settings, 'freq_red'))
    )
  );
  L.push(
    withIcon_(
      'CPM: ' + uah(d.cpm, { integer: true }) + ' │ ' + d1v('cpm', cpmFmt) + ' │ ' + cpmFmt(a.cpm),
      colorCpm(d.cpm, a.cpm, band)
    )
  );
  L.push(
    withIcon_(
      'CTR (link): ' + pctCtr(d.ctr) + ' │ ' + d1v('ctr', pctCtr) + ' │ ' + pctCtr(a.ctr),
      colorHigher(d.ctr, a.ctr, null, band)
    )
  );
  L.push(
    withIcon_(
      'CPC (link): ' + uah(d.cpc) + ' │ ' + d1v('cpc', fmtUah) + ' │ ' + fmtUah(a.cpc),
      colorLower(d.cpc, a.cpc, null, band)
    )
  );
  L.push('');

  L.push('🛒 САЙТ (піксель)');
  L.push('Перегляд товару: ' + fmtInt(d.view_content) + ' · ' + uah(d.vcCost));
  L.push(
    withIcon_(
      'Додали в кошик: ' + fmtInt(d.add_to_cart) + ' · ' + uah(d.atcCost) + ' · ' + fmtPct(d.atcPct),
      colorHigher(d.atcPct, a.atcPct, null, band)
    )
  );
  L.push(
    withIcon_(
      'Оформлення: ' + fmtInt(d.initiate_checkout) + ' · ' + uah(d.icCost) + ' · ' + fmtPct(d.icPct) + ' від кошика',
      colorHigher(d.icPct, a.icPct, null, band)
    )
  );
  L.push(
    withIcon_(
      'Покупки: ' + fmtInt(d.purchases) + ' · CPA ' + uah(d.cpa),
      colorLower(d.cpa, a.cpa, settingNum(settings, 'target_cpa_site'), band)
    )
  );
  L.push('Цінність: ' + fmtInt(d.purchase_value) + ' грн · ROAS ' + fmtRatio(d.roas));
  L.push('');

  L.push('💬 INSTAGRAM DIRECT');
  L.push(
    withIcon_(
      'Нових розмов: ' + fmtInt(d.conversations_started) + ' · ' + (isNum(d.costPerConv) ? fmtUah(d.costPerConv) + ' грн/розмова' : DASH),
      colorLower(d.costPerConv, a.costPerConv, settingNum(settings, 'target_cost_per_conversation'), band)
    )
  );
  L.push('Перших відповідей клієнта: ' + fmtInt(d.first_replies) + ' (' + fmtPct(d.replyPct) + ')');
  if (crm) {
    L.push('Замовлень з Direct: ' + fmtInt(crm.direct.orders) + ' · сума ' + fmtInt(crm.direct.value) + ' грн');
    L.push(
      withIcon_('Конверсія розмова → замовлення: ' + fmtPct(crm.conv.d), colorHigher(crm.conv.d, crm.conv.avg, null, band)) +
        ' (7 днів: ' + fmtPct(crm.conv.avg) + ')'
    );
  } else {
    L.push('Замовлень з Direct: ' + CRM_UNAVAILABLE);
    L.push('Конверсія розмова → замовлення: ' + CRM_UNAVAILABLE);
  }
  L.push('');

  L.push('📥 ЗАМОВЛЕННЯ З META (KeyCRM)');
  if (crm) {
    L.push('Сайт: ' + fmtInt(crm.site.orders) + ' · ' + fmtInt(crm.site.value) + ' грн');
    L.push('QuickOrders: ' + fmtInt(crm.quickorders.orders) + ' · ' + fmtInt(crm.quickorders.value) + ' грн');
    L.push('Instagram Direct: ' + fmtInt(crm.direct.orders) + ' · ' + fmtInt(crm.direct.value) + ' грн');
    const pc = crm.pixelVsCrm;
    const pcIcon = colorPixelCrm(pc.diffPct, settingNum(settings, 'pixel_crm_diff_yellow_pct'), settingNum(settings, 'pixel_crm_diff_red_pct'));
    L.push(withIcon_('Піксель vs CRM (сайт): ' + fmtInt(pc.pixel) + ' │ ' + fmtInt(pc.crm), pcIcon));
    if (pcIcon === '🟡' || pcIcon === '🔴') L.push('👉 перевірити UTM в оголошеннях і роботу пікселя');
    const utmIcon = colorUtmMissing(crm.noUtm.sharePct, settingNum(settings, 'utm_missing_warn_pct'));
    L.push(withIcon_('Без UTM-мітки: ' + fmtInt(crm.noUtm.orders) + ' замовл. (не враховано)', utmIcon));
    if (utmIcon) L.push('👉 ' + fmtPct(crm.noUtm.sharePct) + ' замовлень сайту без міток — перевірити URL parameters в оголошеннях');
  } else {
    L.push(CRM_UNAVAILABLE);
  }
  L.push('');

  L.push('📊 РАЗОМ META (за CRM)');
  if (crm) {
    const tCpa = settingNum(settings, 'target_cpa_total');
    const tRoas = settingNum(settings, 'target_roas');
    L.push(withIcon_('Замовлень: ' + fmtInt(crm.total.orders) + ' · CPA ' + uah(crm.cpa), colorLower(crm.cpa, null, tCpa, band)));
    L.push(withIcon_('Сума: ' + fmtInt(crm.total.value) + ' грн · ROAS ' + fmtRatio(crm.roas), colorHigher(crm.roas, null, tRoas, band)));
    L.push('Ціль: CPA ≤ ' + fmtUah(tCpa) + ' · ROAS ≥ ' + fmtTargetRatio(tRoas));
  } else {
    L.push(CRM_UNAVAILABLE);
  }

  return L.join('\n');
}

// Збирання повідомлень звіту «meta» для реєстру звітів
function buildMetaReport(ctx) {
  const data = computeReport(ctx.date, ctx.metaRows, ctx.crmAvailable === false ? null : ctx.crmRows);
  return [{ message_no: 1, text: buildMetaMsg1(data, ctx.settings) }];
}
