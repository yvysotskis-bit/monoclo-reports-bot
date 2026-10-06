// Тести чистих модулів: формат, дати, мапінг подій, UTM, метрики, світлофор, Telegram, upsert, ретраї.

function suiteFormat_(t) {
  t.test('форматування: тисячі та цілі', function () {
    t.eq(fmtInt(3400), '3 400');
    t.eq(fmtInt(41200), '41 200');
    t.eq(fmtInt(13050), '13 050');
    t.eq(fmtInt(17850), '17 850');
  });
  t.test('форматування: гривні (≥100 ціле, <100 один знак, ".0" прибирається)', function () {
    t.eq(fmtUah(377.78), '378');
    t.eq(fmtUah(154.545), '155');
    t.eq(fmtUah(6.64), '6,6');
    t.eq(fmtUah(5.097), '5,1');
    t.eq(fmtUah(24), '24');
    t.eq(fmtUah(99.96), '100');
    t.eq(fmtUah(53.125), '53');
    t.eq(fmtUah(9.96), '10');
    t.eq(fmtUah(82.52, { integer: true }), '83');
    t.eq(uah(261.54), '262 грн');
    t.eq(uah(null), '—');
  });
  t.test('форматування: відсотки (CTR 2 знаки; решта 1 знак / ціле від 20)', function () {
    t.eq(fmtPct(1.619, 'ctr'), '1,62%');
    t.eq(fmtPct(1.55, 'ctr'), '1,55%');
    t.eq(fmtPct(12.5), '12,5%');
    t.eq(fmtPct(34.375), '34%');
    t.eq(fmtPct(84.78), '85%');
    t.eq(fmtPct(8.696), '8,7%');
    t.eq(fmtPct(11.0), '11%');
    t.eq(fmtPct(null), '—');
  });
  t.test('форматування: ROAS, частота, ціль', function () {
    t.eq(fmtRatio(3.838), '3,84×');
    t.eq(fmtRatio(5.25), '5,25×');
    t.eq(fmtFreq(1.731), '1,73');
    t.eq(fmtTargetRatio(3), '3,0');
    t.eq(fmtTargetRatio(3.25), '3,25');
  });
}

function suiteDates_(t) {
  t.test('дата й день тижня українською', function () {
    t.eq(formatDdMm('2026-10-05'), '05.10');
    t.eq(weekdayUa('2026-10-05'), 'пн');
    t.eq(weekdayUa('2026-10-11'), 'нд');
    t.eq(addDays('2026-10-01', -1), '2026-09-30');
    t.eq(dateRange('2026-09-29', '2026-10-02').length, 4);
  });
  t.test('доба за Києвом: 23:50 потрапляє в цей день (різні формати часу API)', function () {
    t.eq(dateInTz(new Date(parseTimestamp('2026-10-05 23:50:00', 'Europe/Kyiv')), KYIV_TZ), '2026-10-05');
    t.eq(dateInTz(new Date(parseTimestamp('2026-10-05 20:50:00', 'UTC')), KYIV_TZ), '2026-10-05'); // 20:50 UTC = 23:50 Київ
    t.eq(dateInTz(new Date(parseTimestamp('2026-10-05T20:50:00Z', 'UTC')), KYIV_TZ), '2026-10-05');
    t.eq(dateInTz(new Date(parseTimestamp('2026-10-05T23:50:00+03:00', 'UTC')), KYIV_TZ), '2026-10-05');
    t.eq(dateInTz(new Date(parseTimestamp('2026-10-05 21:10:00', 'UTC')), KYIV_TZ), '2026-10-06'); // 00:10 Київ
    t.eq(dateInTz(new Date(parseTimestamp('2026-01-15 22:30:00', 'UTC')), KYIV_TZ), '2026-01-16'); // зима UTC+2
  });
}

function suiteActions_(t) {
  t.test('мапінг подій: якщо є omni_purchase і fb_pixel_purchase — рахується лише перший', function () {
    const row = {
      date_start: '2026-10-05', spend: '100', impressions: '1000', reach: '900', inline_link_clicks: '10',
      actions: [
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '7' },
        { action_type: 'omni_purchase', value: '9' },
        { action_type: 'purchase', value: '9' }
      ],
      action_values: [
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '7000' },
        { action_type: 'omni_purchase', value: '9000' }
      ]
    };
    const m = mapInsightRow(row);
    t.eq(m.purchases, 9);
    t.eq(m.purchase_value, 9000);
  });
  t.test('мапінг подій: запасні типи, відсутні події = 0, розмови й відповіді', function () {
    const m = mapInsightRow({
      date_start: '2026-10-05', spend: '1', impressions: '1', reach: '1', inline_link_clicks: '1',
      actions: [
        { action_type: 'offsite_conversion.fb_pixel_add_to_cart', value: '5' },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '46' },
        { action_type: 'onsite_conversion.messaging_first_reply', value: '39' }
      ]
    });
    t.eq(m.add_to_cart, 5);
    t.eq(m.view_content, 0);
    t.eq(m.conversations_started, 46);
    t.eq(m.first_replies, 39);
    t.eq(m.purchases, 0);
  });
}

function suiteAttribution_(t) {
  const rules = parseRuleRows(DEFAULT_UTM_RULES);
  function ch(sg, utm) {
    return classifyChannel(sg, utm, rules);
  }
  t.test('UTM 10: gclid -> google_ads (навіть із utm_source=facebook)', function () {
    t.eq(ch('site', { gclid: 'x' }), 'google_ads');
    t.eq(ch('site', { gclid: 'x', utm_source: 'facebook', utm_medium: 'paid' }), 'google_ads');
  });
  t.test('UTM 20: google + cpc -> google_ads; google без платного medium — ні', function () {
    t.eq(ch('site', { utm_source: 'google', utm_medium: 'cpc' }), 'google_ads');
    t.eq(ch('site', { utm_source: 'google', utm_medium: 'organic' }), 'other_utm');
  });
  t.test('UTM 30: ig + paid -> meta_ads; регістр і пробіли не мають значення', function () {
    t.eq(ch('site', { utm_source: 'ig', utm_medium: 'paid' }), 'meta_ads');
    t.eq(ch('site', { utm_source: 'Facebook', utm_medium: 'Paid' }), 'meta_ads');
    t.eq(ch('quickorders', { utm_source: ' FB ', utm_medium: 'PAID_SOCIAL' }), 'meta_ads');
  });
  t.test('UTM 40: динамічний utm_campaign = ID кампанії + джерело Meta -> meta_ads', function () {
    t.eq(ch('site', { utm_source: 'facebook', utm_medium: 'social', utm_campaign: '120200000001234' }), 'meta_ads');
    t.eq(ch('site', { utm_source: 'facebook', utm_medium: 'social', utm_campaign: 'summer' }), 'meta_organic');
  });
  t.test('UTM 50: Meta-джерело без платного medium -> meta_organic', function () {
    t.eq(ch('site', { utm_source: 'instagram', utm_medium: 'social' }), 'meta_organic');
    t.eq(ch('site', { utm_source: 'linktree' }), 'meta_organic');
  });
  t.test('fbclid без UTM -> meta_organic (не реклама Meta)', function () {
    t.eq(ch('site', { fbclid: 'abc' }), 'meta_organic');
  });
  t.test('UTM 60: klaviyo / medium=email -> email', function () {
    t.eq(ch('site', { utm_source: 'klaviyo' }), 'email');
    t.eq(ch('site', { utm_source: 'newsletter', utm_medium: 'email' }), 'email');
  });
  t.test('UTM 70: будь-яка інша мітка -> other_utm', function () {
    t.eq(ch('site', { utm_source: 'tiktok', utm_medium: 'paid' }), 'other_utm');
    t.eq(ch('site', { utm_term: 'худі' }), 'other_utm');
  });
  t.test('UTM 99: порожні мітки -> no_utm', function () {
    t.eq(ch('site', {}), 'no_utm');
    t.eq(ch('quickorders', { utm_source: '  ', utm_medium: '' }), 'no_utm');
  });
  t.test('Правило 0: джерело instagram з будь-якими UTM -> meta_direct', function () {
    t.eq(ch('instagram', {}), 'meta_direct');
    t.eq(ch('instagram', { utm_source: 'google', utm_medium: 'cpc', gclid: 'x' }), 'meta_direct');
  });
  t.test('рушій: оператори contains і regex, І в межах однакового priority', function () {
    const custom = parseRuleRows([
      { priority: 1, channel: 'a', field: 'utm_content', operator: 'contains', values: 'story,reel', comment: '' },
      { priority: 2, channel: 'b', field: 'utm_source', operator: 'in', values: 'x', comment: '' },
      { priority: 2, channel: 'b', field: 'utm_medium', operator: 'in', values: 'y', comment: '' }
    ]);
    t.eq(classifyChannel('site', { utm_content: 'my_REEL_1' }, custom), 'a');
    t.eq(classifyChannel('site', { utm_source: 'x' }, custom), 'no_utm'); // потрібні обидві умови
    t.eq(classifyChannel('site', { utm_source: 'x', utm_medium: 'y' }, custom), 'b');
  });
  t.test('source_group за ID джерел з налаштувань; невідоме -> other', function () {
    const s = fxSettings({ keycrm_source_site_ids: '5, 6', keycrm_source_quickorders_ids: 7, keycrm_source_instagram_ids: '8' });
    t.eq(classifySource(5, s), 'site');
    t.eq(classifySource('6', s), 'site');
    t.eq(classifySource(7, s), 'quickorders');
    t.eq(classifySource('8', s), 'instagram');
    t.eq(classifySource('999', s), 'other');
    t.eq(classifySource('', s), 'other');
  });
}

function suiteMetrics_(t) {
  t.test('формули розділу 5 на фікстурі D', function () {
    const data = computeReport(FX_DATE, fxMetaRows(), buildCrmDaily(fxOrders()));
    const d = data.d;
    t.near(d.freq, 41200 / 23800);
    t.near(d.cpm, 82.5243, 1e-3);
    t.near(d.ctr, 1.6188, 1e-3);
    t.near(d.cpc, 5.0975, 1e-3);
    t.near(d.vcCost, 6.6406, 1e-3);
    t.near(d.atcCost, 53.125, 1e-9);
    t.near(d.atcPct, 12.5, 1e-9);
    t.near(d.icCost, 154.5454, 1e-3);
    t.near(d.icPct, 34.375, 1e-9);
    t.near(d.cpa, 377.7778, 1e-3);
    t.near(d.roas, 3.8382, 1e-3);
    t.near(d.costPerConv, 24, 1e-9);
    t.near(d.replyPct, 84.7826, 1e-3);
  });
  t.test('AVG7 рахується із сум; spend — сума ÷ 7; D-1 береться окремо', function () {
    const data = computeReport(FX_DATE, fxMetaRows(), buildCrmDaily(fxOrders()));
    t.near(data.avg.spend, 3250);
    t.near(data.avg.ctr, (4160 / 281000) * 100, 1e-9);
    t.near(data.avg.cpm, (22750 / 281000) * 1000, 1e-9);
    t.near(data.avg.cpc, 22750 / 4160, 1e-9);
    t.near(data.avg.atcPct, (468 / 3600) * 100, 1e-9);
    t.eq(data.d1.spend, 3100);
    t.near(data.d1.cpm, 79.0816, 1e-3);
  });
  t.test('CRM: Meta разом 13 · 17 850 · CPA 262 · ROAS 5,25; піксель vs CRM 9│9; без UTM 3 (23%)', function () {
    const crm = computeReport(FX_DATE, fxMetaRows(), buildCrmDaily(fxOrders())).crm;
    t.eq(crm.site, { orders: 7, value: 9800 });
    t.eq(crm.quickorders, { orders: 2, value: 2450 });
    t.eq(crm.direct, { orders: 4, value: 5600 });
    t.eq(crm.total, { orders: 13, value: 17850 });
    t.near(crm.cpa, 3400 / 13);
    t.near(crm.roas, 5.25);
    t.eq(crm.pixelVsCrm.pixel, 9);
    t.eq(crm.pixelVsCrm.crm, 9);
    t.near(crm.pixelVsCrm.diffPct, 0);
    t.eq(crm.noUtm.orders, 3);
    t.near(crm.noUtm.sharePct, (3 / 13) * 100, 1e-9);
    t.near(crm.conv.d, (4 / 46) * 100, 1e-9);
    t.near(crm.conv.avg, 11.0, 1e-9); // 33 замовлення / 300 розмов
  });
  t.test('скасоване замовлення не враховано ніде', function () {
    const daily = buildCrmDaily(fxOrders());
    const sumSite = daily
      .filter(function (r) {
        return r.date === FX_DATE && r.source_group === 'site';
      })
      .reduce(function (s, r) {
        return s + r.orders;
      }, 0);
    t.eq(sumSite, 10); // 7 + 1 + 2, без скасованого
  });
  t.test('ділення на нуль -> null', function () {
    const m = metaDerived(sumMetaRows([{ date: 'x', spend: 100 }]));
    t.eq(m.cpa, null);
    t.eq(m.cpm, null);
    t.eq(m.ctr, null);
    t.eq(m.costPerConv, null);
  });
}

function suiteRules_(t) {
  t.test('стрілка тренду Spend', function () {
    t.eq(trendArrow(3400, 3250, 4), '↗');
    t.eq(trendArrow(3400, 3250, 5), '➖');
    t.eq(trendArrow(3000, 3250, 5), '↘');
    t.eq(trendArrow(3000, 0, 5), '');
  });
  t.test('«менше = краще»: зелений / жовтий / червоний (band 10, ціль 400)', function () {
    t.eq(colorLower(378, 392, 400, 10), '🟢');
    t.eq(colorLower(420, 380, 400, 10), '🟡'); // гірше за AVG7 на 10.5% та вище цілі на 5%
    t.eq(colorLower(470, 450, 400, 10), '🟡'); // вище цілі на 17,5%
    t.eq(colorLower(600, 450, 400, 10), '🔴');
    t.eq(colorLower(null, 450, 400, 10), '');
  });
  t.test('«більше = краще»: дзеркально', function () {
    t.eq(colorHigher(1.62, 1.48, null, 10), '🟢');
    t.eq(colorHigher(8.7, 11, null, 12), '🟡');
    t.eq(colorHigher(8.7, 11, null, 10), '🔴');
    t.eq(colorHigher(5.25, null, 3, 10), '🟢');
    t.eq(colorHigher(2.8, null, 3, 10), '🟡');
    t.eq(colorHigher(1.0, null, 3, 10), '🔴');
  });
  t.test('CPM: у межах band -> ➖; значно краще -> 🟢; значно гірше -> 🔴', function () {
    t.eq(colorCpm(82.5, 81, 10), '➖');
    t.eq(colorCpm(60, 81, 10), '🟢');
    t.eq(colorCpm(110, 81, 10), '🔴');
  });
  t.test('частота, піксель vs CRM, UTM', function () {
    t.eq(colorFreq(1.73, 2, 3), '🟢');
    t.eq(colorFreq(2.5, 2, 3), '🟡');
    t.eq(colorFreq(3.2, 2, 3), '🔴');
    t.eq(colorPixelCrm(0, 20, 40), '✅');
    t.eq(colorPixelCrm(25, 20, 40), '🟡');
    t.eq(colorPixelCrm(45, 20, 40), '🔴');
    t.eq(colorPixelCrm(null, 20, 40), '');
    t.eq(colorUtmMissing(23, 30), '');
    t.eq(colorUtmMissing(30, 30), '🟡');
  });
}

function suiteTelegram_(t) {
  t.test('екранування HTML і обгортка <pre>', function () {
    t.eq(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
    t.eq(wrapPre('x<y'), '<pre>x&lt;y</pre>');
  });
  t.test('розбиття довгого тексту по порожніх рядках; кожна частина ≤ ліміту', function () {
    const block = new Array(40).join('рядок звіту з текстом\n').trim(); // ~ 840 символів
    const text = [block, block, block, block, block, block].join('\n\n'); // ~5 тис. символів
    const parts = splitMessage(text, 4096);
    t.ok(parts.length >= 2, 'очікувалось ≥ 2 частин, отримано ' + parts.length);
    parts.forEach(function (p) {
      t.ok(htmlLen_(p) <= 4096, 'частина задовга: ' + htmlLen_(p));
    });
    t.eq(parts.join('\n\n'), text);
  });
  t.test('короткий текст — одна частина; екранування враховується в ліміті', function () {
    t.eq(splitMessage('привіт', 4096).length, 1);
    const amp = new Array(1500).join('&&'); // кожен & -> &amp; (5 символів)
    buildTelegramMessages(amp, 4096).forEach(function (m) {
      t.ok(m.length <= 4096, 'HTML задовгий: ' + m.length);
    });
  });
  t.test('один надто довгий рядок ріжеться по символах', function () {
    const parts = splitMessage(new Array(10000).join('я'), 4096);
    t.ok(parts.length >= 3);
    parts.forEach(function (p) {
      t.ok(htmlLen_(p) <= 4096);
    });
  });
}

function suiteStorage_(t) {
  t.test('upsert: повторний запис не створює дублів і оновлює значення', function () {
    const keys = SHEETS['Meta_Daily'].keys;
    let rows = upsertRows([], [{ date: '2026-10-01', spend: 1 }, { date: '2026-10-02', spend: 2 }], keys);
    rows = upsertRows(rows, [{ date: '2026-10-02', spend: 20 }, { date: '2026-10-03', spend: 3 }], keys);
    rows = upsertRows(rows, [{ date: '2026-10-02', spend: 20 }, { date: '2026-10-03', spend: 3 }], keys);
    t.eq(rows.length, 3);
    t.eq(rows[1].spend, 20);
  });
  t.test('upsert за складеним ключем (CRM_Daily); replaceByDates прибирає застарілі трійки', function () {
    const keys = SHEETS['CRM_Daily'].keys;
    const a = { date: 'd1', source_group: 'site', channel: 'meta_ads', orders: 1, value: 1 };
    const b = { date: 'd1', source_group: 'site', channel: 'no_utm', orders: 1, value: 1 };
    let rows = upsertRows([], [a, b], keys);
    rows = upsertRows(rows, [a], keys);
    t.eq(rows.length, 2);
    const replaced = replaceByDates(rows, [{ date: 'd1', source_group: 'site', channel: 'meta_ads', orders: 2, value: 2 }], ['d1']);
    t.eq(replaced.length, 1);
  });
  t.test('Звіт_Щодня: sent не перезаписується, крім force; ready/error перезаписуються', function () {
    const sent = { date: 'd', report: 'meta', message_no: 1, text: 'старий', status: 'sent', sent_at: 'x', tg_message_id: '1', error: '' };
    const fresh = { date: 'd', report: 'meta', message_no: 1, text: 'новий', status: 'ready', sent_at: '', tg_message_id: '', error: '' };
    t.eq(mergeReportRows([sent], [fresh], false)[0].text, 'старий');
    t.eq(mergeReportRows([sent], [fresh], true)[0].text, 'новий');
    const err = Object.assign({}, sent, { status: 'error' });
    t.eq(mergeReportRows([err], [fresh], false)[0].text, 'новий');
  });
  t.test('налаштування: дефолти, числа з комою, списки, булеві', function () {
    const s = parseSettingsRows([['target_roas', '3,5'], ['keycrm_source_site_ids', 12], ['report_send_enabled', false]]);
    t.near(settingNum(s, 'target_roas'), 3.5);
    t.near(settingNum(s, 'target_cpa_total'), 350);
    t.eq(settingList(s, 'keycrm_source_site_ids'), ['12']);
    t.eq(settingBool(s, 'report_send_enabled'), false);
    t.eq(settingBool(parseSettingsRows([]), 'report_send_enabled'), true);
  });
  t.test('redact прибирає секрети з тексту', function () {
    t.eq(redact('url https://x/botSECRET123/send', ['SECRET123']), 'url https://x/bot***/send');
  });
}

function suiteApis_(t) {
  t.test('ретраї: 3 повтори з паузами 2→5→10 с, потім помилка', function () {
    const sleeps = [];
    let calls = 0;
    t.throws(function () {
      withRetry(
        function () {
          calls++;
          throw new Error('x');
        },
        function () {
          return { retry: true };
        },
        { delays: [2000, 5000, 10000], sleep: function (ms) { sleeps.push(ms); } }
      );
    });
    t.eq(calls, 4);
    t.eq(sleeps, [2000, 5000, 10000]);
  });
  t.test('ретраї: успіх з другої спроби; не-ретрайна помилка падає одразу', function () {
    let n = 0;
    const r = withRetry(
      function () {
        if (++n < 2) throw new Error('x');
        return 'ok';
      },
      function () {
        return { retry: true };
      },
      { delays: [1, 1, 1], sleep: function () {} }
    );
    t.eq(r, 'ok');
    n = 0;
    t.throws(function () {
      withRetry(function () { n++; throw new Error('fatal'); }, function () { return { retry: false }; }, { delays: [1], sleep: function () {} });
    });
    t.eq(n, 1);
  });
  t.test('Meta: класифікація помилок (5xx і коди 4/17/32/613 — ретрай; 190 — токен)', function () {
    t.eq(classifyMetaError(makeMetaError_(500, null)).retry, true);
    [4, 17, 32, 613].forEach(function (c) {
      t.eq(classifyMetaError(makeMetaError_(400, { error: { code: c } })).retry, true, 'код ' + c);
    });
    const tok = makeMetaError_(400, { error: { code: 190, message: 'Invalid OAuth' } });
    t.eq(tok.isTokenError, true);
    t.eq(classifyMetaError(tok).retry, false);
    t.eq(classifyMetaError(makeMetaError_(400, { error: { code: 100 } })).retry, false);
  });
  t.test('Meta: Direct-кампанії (автовизначення та ручний список) і direct_spend за днями', function () {
    const adsets = [
      { campaign_id: '1', destination_type: 'WEBSITE' },
      { campaign_id: '2', destination_type: 'INSTAGRAM_DIRECT' },
      { campaign_id: '3', destination_type: 'MESSENGER' },
      { campaign_id: '2', destination_type: 'INSTAGRAM_DIRECT' }
    ];
    t.eq(detectDirectCampaigns(adsets, []).sort(), ['2', '3']);
    t.eq(detectDirectCampaigns(adsets, ['1']), ['1']);
    const sp = directSpendByDate(
      [
        { campaign_id: '2', date_start: 'd1', spend: '100.5' },
        { campaign_id: '3', date_start: 'd1', spend: '10' },
        { campaign_id: '1', date_start: 'd1', spend: '999' }
      ],
      ['2', '3']
    );
    t.near(sp.d1, 110.5);
  });
  t.test('Meta: дні без показів доповнюються нулями; direct_spend підставляється', function () {
    const days = assembleMetaDays(
      [{ date_start: '2026-10-05', spend: '50', impressions: '100', reach: '90', inline_link_clicks: '2' }],
      [{ campaign_id: '2', date_start: '2026-10-05', spend: '20' }],
      ['2'], '2026-10-04', '2026-10-05'
    );
    t.eq(days.length, 2);
    t.eq(days[0].spend, 0);
    t.eq(days[0].direct_spend, 0);
    t.eq(days[1].direct_spend, 20);
  });
}

function suiteMetaAccounts_(t) {
  t.test('META_AD_ACCOUNT_ID: кілька акаунтів через кому, голі числа -> act_', function () {
    t.eq(parseAccountIds('act_1, 22 ,act_3'), ['act_1', 'act_22', 'act_3']);
    t.eq(parseAccountIds('act_5'), ['act_5']);
    t.eq(parseAccountIds(''), []);
  });
  t.test('кілька акаунтів: метрики по датах складаються, дні без показів в одного акаунта не заважають', function () {
    const a = [{ date: 'd1', spend: 100, impressions: 1000, reach: 800, purchases: 2, direct_spend: 10.5 }, { date: 'd2', spend: 0, impressions: 0, reach: 0, purchases: 0, direct_spend: 0 }];
    const b = [{ date: 'd1', spend: 50, impressions: 500, reach: 400, purchases: 1, direct_spend: 0.25 }, { date: 'd2', spend: 20, impressions: 300, reach: 250, purchases: 0, direct_spend: 20 }];
    const m = mergeAccountDays([a, b]);
    t.eq(m.length, 2);
    t.eq(m[0].spend, 150);
    t.eq(m[0].impressions, 1500);
    t.eq(m[0].purchases, 3);
    t.near(m[0].direct_spend, 10.75);
    t.eq(m[1].spend, 20);
    t.eq(mergeAccountDays([a]).length, 2);
  });
}

function suiteFx_(t) {
  t.test('курс НБУ: розбір відповіді', function () {
    t.near(parseNbuRate([{ r030: 840, txt: 'Долар США', rate: 41.25, cc: 'USD', exchangedate: '05.10.2026' }], 'USD'), 41.25);
    t.eq(parseNbuRate([], 'USD'), null);
    t.eq(parseNbuRate([{ cc: 'EUR', rate: 45 }], 'USD'), null);
    t.eq(parseNbuRate({ error: 1 }, 'USD'), null);
  });
  t.test('конвертація в UAH: витрати, цінність покупок і direct_spend; покази/події не змінюються', function () {
    const days = [{ date: 'd1', spend: 10, purchase_value: 30, direct_spend: 4, impressions: 1000, purchases: 2, reach: 900 }];
    const r = convertDaysToUah(days, { d1: 41.5 });
    t.near(r[0].spend, 415);
    t.near(r[0].purchase_value, 1245);
    t.near(r[0].direct_spend, 166);
    t.eq(r[0].impressions, 1000);
    t.eq(r[0].purchases, 2);
    t.eq(days[0].spend, 10); // вхід не змінено
    t.throws(function () { convertDaysToUah(days, {}); });
  });
  t.test('курси: UAH = 1, fixed із налаштувань, fixed без значення — помилка', function () {
    t.eq(getFxRates_('UAH', ['d1', 'd2'], fxSettings(), {}), { d1: 1, d2: 1 });
    t.eq(getFxRates_('USD', ['d1'], fxSettings({ meta_fx_mode: 'fixed', meta_fx_fixed_rate: '41,5' }), {}), { d1: 41.5 });
    t.throws(function () { getFxRates_('USD', ['d1'], fxSettings({ meta_fx_mode: 'fixed', meta_fx_fixed_rate: '' }), {}); });
  });
  t.test('курс: НБУ недоступний -> запасний фіксований курс (з позначкою), без нього — помилка з причиною', function () {
    const cache = {};
    t.eq(getFxRates_('USD', ['2026-10-05'], fxSettings({ meta_fx_mode: 'nbu', meta_fx_fixed_rate: 41.5 }), cache), { '2026-10-05': 41.5 });
    t.eq(cache.fallbackUsed, true);
    t.throws(function () { getFxRates_('USD', ['2026-10-05'], fxSettings({ meta_fx_mode: 'nbu', meta_fx_fixed_rate: '' }), {}); });
  });
}

function suiteShopify_(t) {
  t.test('Shopify: домен, gid замовлення з source_uuid', function () {
    t.eq(parseShopifyDomain('https://ibvza0-1g.myshopify.com/'), 'ibvza0-1g.myshopify.com');
    t.eq(parseShopifyDomain('ibvza0-1g.myshopify.com'), 'ibvza0-1g.myshopify.com');
    t.eq(shopifyOrderGid({ source_uuid: '6012345678901' }), 'gid://shopify/Order/6012345678901');
    t.eq(shopifyOrderGid({ source_uuid: 'gid://shopify/Order/6012345678901' }), 'gid://shopify/Order/6012345678901');
    t.eq(shopifyOrderGid({ source_uuid: '1234' }), null);
    t.eq(shopifyOrderGid({ source_uuid: '' }), null);
    t.eq(shopifyOrderGid({}), null);
  });
  t.test('Shopify: ключ пошуку (номер замовлення M-CL6309, ID, QuickOrders не шукаємо)', function () {
    t.eq(shopifyLookupKey({ source_uuid: 'M-CL6309' }), 'name:M-CL6309');
    t.eq(shopifyLookupKey({ source_uuid: '#1001' }), 'name:1001');
    t.eq(shopifyLookupKey({ source_uuid: '6012345678901' }), 'gid:gid://shopify/Order/6012345678901');
    t.eq(shopifyLookupKey({ source_uuid: 'quick-20261006-152207' }), null);
    t.eq(shopifyLookupKey({ source_uuid: '' }), null);
    t.eq(shopifyLookupKey({ source_uuid: 'без цифр' }), null);
    t.eq(shopifyLookupKey({}), null);
  });
  t.test('Shopify: UTM із шляху клієнта (останній візит, потім перший; gclid/fbclid із landingPage)', function () {
    const last = { utmParameters: { source: 'ig', medium: 'paid', campaign: '123', content: '456', term: '789' }, landingPage: '/products/x?utm_source=ig' };
    t.eq(journeyToUtm({ lastVisit: last, firstVisit: null }).utm_source, 'ig');
    t.eq(journeyToUtm({ lastVisit: { utmParameters: null, landingPage: null }, firstVisit: last }).utm_medium, 'paid');
    const fromUrl = journeyToUtm({ lastVisit: { utmParameters: null, landingPage: '/?fbclid=AbC&utm_medium=social&utm_source=Facebook' } });
    t.eq(fromUrl.fbclid, 'AbC');
    t.eq(fromUrl.utm_source, 'Facebook');
    t.eq(journeyToUtm({ lastVisit: { utmParameters: { source: null }, landingPage: '/' }, firstVisit: null }), null);
    t.eq(journeyToUtm(null), null);
    t.eq(urlParams_('/p?a=1&b=x%20y#frag'), { a: '1', b: 'x y' });
  });
  t.test('Shopify-мітки проходять через normalizeOrder (utm_origin = shopify) і дають meta_ads', function () {
    const settings = fxSettings({ keycrm_source_site_ids: '212', keycrm_source_instagram_ids: '198' });
    const o = normalizeOrder(
      { id: 1, created_at: '2026-10-05T10:00:00.000000Z', source_id: 212, status_id: 1, grand_total: 1500, marketing: null, source_uuid: '6012345678901' },
      { settings: settings, rules: parseRuleRows(DEFAULT_UTM_RULES), statusNames: {}, utmFallback: function () { return journeyToUtm({ lastVisit: { utmParameters: { source: 'ig', medium: 'paid' } } }); } }
    );
    t.eq(o.utm_origin, 'shopify');
    t.eq(o.channel, 'meta_ads');
  });
  t.test('KeyCRM: дата з мікросекундами й Z розбирається; marketing = null не ламає нормалізацію', function () {
    const o = normalizeOrder(
      { id: 2, created_at: '2026-10-06T14:31:26.000000Z', source_id: 212, status_id: 1, grand_total: 100, marketing: null },
      { settings: fxSettings({ keycrm_source_site_ids: '212' }), rules: parseRuleRows(DEFAULT_UTM_RULES), statusNames: {} }
    );
    t.eq(o.date, '2026-10-06');
    t.eq(o.channel, 'no_utm');
    t.eq(o.utm_origin, 'none');
  });
}

function suiteDiag_(t) {
  t.test('діагностика дня: підсумок за джерелом/статусом і каналом', function () {
    const orders = fxOrders();
    const r = summarizeOrdersForDay(orders, FX_DATE);
    t.eq(r.total, 18);
    const cancelled = r.byStatus.filter(function (x) { return x.key.indexOf('НІ') !== -1; });
    t.eq(cancelled.length, 1);
    t.eq(cancelled[0].orders, 1);
    const metaAds = r.byChannel.filter(function (x) { return x.key.indexOf('site | канал meta_ads') === 0; });
    t.eq(metaAds[0].orders, 7);
  });
}

function suiteKeycrm_(t) {
  const settings = fxSettings({
    keycrm_source_site_ids: '5', keycrm_source_quickorders_ids: '6', keycrm_source_instagram_ids: '7',
    keycrm_excluded_status_ids: '99,98', keycrm_naive_timestamp_tz: 'Europe/Kyiv'
  });
  const rules = parseRuleRows(DEFAULT_UTM_RULES);
  function norm(raw, over) {
    return normalizeOrder(raw, { settings: Object.assign({}, settings, over || {}), rules: rules, statusNames: { '1': 'Новий', '99': 'Скасовано' } });
  }
  t.test('нормалізація замовлення: джерело, UTM, канал, сума, статус', function () {
    const o = norm({ id: 1001, created_at: '2026-10-05 14:00:00', source_id: 5, status_id: 1, grand_total: '1400.50', marketing: { utm_source: 'Facebook', utm_medium: 'Paid', utm_campaign: '123' } });
    t.eq(o.order_id, '1001');
    t.eq(o.source_group, 'site');
    t.eq(o.channel, 'meta_ads');
    t.eq(o.is_counted, true);
    t.eq(o.status_name, 'Новий');
    t.near(o.grand_total, 1400.5);
    t.eq(o.utm_origin, 'keycrm');
    t.eq(o.date, '2026-10-05');
  });
  t.test('скасований статус не рахується (is_counted = FALSE, у CRM_Daily немає)', function () {
    const o = norm({ id: 2, created_at: '2026-10-05 10:00:00', source_id: 5, status_id: 99, grand_total: 1200, marketing: { utm_source: 'fb', utm_medium: 'paid' } });
    t.eq(o.is_counted, false);
    t.eq(buildCrmDaily([o]).length, 0);
  });
  t.test('замовлення о 23:50 за Києвом потрапляє в цей день (UTC і Київ)', function () {
    t.eq(norm({ id: 3, created_at: '2026-10-05 23:50:00', source_id: 5, status_id: 1 }).date, '2026-10-05');
    t.eq(norm({ id: 4, created_at: '2026-10-05 20:50:00', source_id: 5, status_id: 1 }, { keycrm_naive_timestamp_tz: 'UTC' }).date, '2026-10-05');
    t.eq(norm({ id: 5, created_at: '2026-10-05 21:10:00', source_id: 5, status_id: 1 }, { keycrm_naive_timestamp_tz: 'UTC' }).date, '2026-10-06');
  });
  t.test('джерело instagram -> meta_direct, невідоме -> other, без міток -> no_utm', function () {
    t.eq(norm({ id: 6, created_at: '2026-10-05 10:00:00', source_id: 7, status_id: 1, marketing: { utm_source: 'google', utm_medium: 'cpc' } }).channel, 'meta_direct');
    t.eq(norm({ id: 7, created_at: '2026-10-05 10:00:00', source_id: 42, status_id: 1 }).source_group, 'other');
    t.eq(norm({ id: 8, created_at: '2026-10-05 10:00:00', source_id: 6, status_id: 1 }).channel, 'no_utm');
    t.eq(norm({ id: 8, created_at: '2026-10-05 10:00:00', source_id: 6, status_id: 1 }).utm_origin, 'none');
  });
  t.test('резервне джерело UTM (utmFallback) -> utm_origin = shopify', function () {
    const o = normalizeOrder(
      { id: 9, created_at: '2026-10-05 10:00:00', source_id: 5, status_id: 1 },
      { settings: settings, rules: rules, statusNames: {}, utmFallback: function () { return { utm_source: 'ig', utm_medium: 'paid' }; } }
    );
    t.eq(o.utm_origin, 'shopify');
    t.eq(o.channel, 'meta_ads');
  });
  t.test('reclassifyRows: зміна правила змінює channel, зміна налаштувань — source_group/is_counted', function () {
    const orders = fxOrders();
    const cutRules = rules.filter(function (r) {
      return r.priority !== 30 && r.priority !== 40;
    });
    const re = reclassifyRows(orders, cutRules, fxSettings());
    const fb = re.filter(function (o) {
      return o.utm_source === 'facebook' && o.is_counted;
    });
    t.ok(fb.length === 7 && fb.every(function (o) { return o.channel === 'meta_organic'; }));
    t.eq(orders.filter(function (o) { return o.channel === 'meta_ads' && o.source_group === 'site'; }).length, 8); // оригінал не змінено
  });
}

function getTestSuites_() {
  return [suiteFormat_, suiteDates_, suiteActions_, suiteAttribution_, suiteMetrics_, suiteRules_, suiteTelegram_, suiteStorage_, suiteApis_, suiteMetaAccounts_, suiteFx_, suiteShopify_, suiteDiag_, suiteKeycrm_, suiteMsg1_, suiteFlow_];
}
