// Тести повідомлення 1 (еталон 7.1) і наскрізних сценаріїв (через залежності-імітації, без GAS).

function fxData_(over) {
  return computeReport(FX_DATE, fxMetaRows(), buildCrmDaily(fxOrders()));
}

function suiteMsg1_(t) {
  t.test('повний текст metaMsg1 збігається з еталоном 7.1 посимвольно', function () {
    t.text(buildMetaMsg1(fxData_(), fxSettings()), fxReferenceMsg1());
  });
  t.test('buildMetaReport (реєстр звітів) повертає повідомлення №1', function () {
    const msgs = buildMetaReport({ date: FX_DATE, settings: fxSettings(), metaRows: fxMetaRows(), crmRows: buildCrmDaily(fxOrders()), crmAvailable: true });
    t.eq(msgs.length, 1);
    t.eq(msgs[0].message_no, 1);
    t.text(msgs[0].text, fxReferenceMsg1());
  });
  t.test('із дефолтними порогами ТЗ правила розділу 6 дають ➖ у Spend і 🔴 у конверсії (задокументований конфлікт з еталоном)', function () {
    const text = buildMetaMsg1(fxData_(), fxSettings({ trend_band_pct: 5, color_band_pct: 10 }));
    t.ok(text.indexOf('Spend: 3 400 грн │ 3 100 │ 3 250 ➖') !== -1, 'Spend');
    t.ok(text.indexOf('Конверсія розмова → замовлення: 8,7% 🔴 (7 днів: 11%)') !== -1, 'Конверсія');
  });
  t.test('ділення на нуль: purchases = 0 -> «CPA —» без кольору', function () {
    const rows = fxMetaRows();
    rows[rows.length - 1].purchases = 0;
    rows[rows.length - 1].purchase_value = 0;
    const text = buildMetaMsg1(computeReport(FX_DATE, rows, buildCrmDaily(fxOrders())), fxSettings());
    t.ok(text.indexOf('\nПокупки: 0 · CPA —\n') !== -1, 'CPA');
  });
  t.test('spend за D = 0 -> коротке повідомлення', function () {
    const rows = fxMetaRows();
    rows[rows.length - 1].spend = 0;
    t.eq(buildMetaMsg1(computeReport(FX_DATE, rows, null), fxSettings()), '05.10 реклама не крутилась (spend 0)');
    const noRow = fxMetaRows().filter(function (r) { return r.date !== FX_DATE; });
    t.eq(buildMetaMsg1(computeReport(FX_DATE, noRow, null), fxSettings()), '05.10 реклама не крутилась (spend 0)');
  });
  t.test('KeyCRM недоступний: рядки Direct, блок CRM і «Разом» -> «дані KeyCRM недоступні», нулі не підставляються', function () {
    const text = buildMetaMsg1(computeReport(FX_DATE, fxMetaRows(), null), fxSettings());
    t.ok(text.indexOf('Замовлень з Direct: дані KeyCRM недоступні') !== -1);
    t.ok(text.indexOf('Конверсія розмова → замовлення: дані KeyCRM недоступні') !== -1);
    t.ok(text.indexOf('📥 ЗАМОВЛЕННЯ З META (KeyCRM)\nдані KeyCRM недоступні') !== -1);
    t.ok(text.indexOf('📊 РАЗОМ META (за CRM)\nдані KeyCRM недоступні') !== -1);
    t.ok(text.indexOf('Нових розмов: 46') !== -1, 'дані Meta лишаються');
  });
  t.test('день без замовлень з Direct -> «Замовлень з Direct: 0» (звичайний нуль)', function () {
    const orders = fxOrders().filter(function (o) { return !(o.date === FX_DATE && o.source_group === 'instagram'); });
    const text = buildMetaMsg1(computeReport(FX_DATE, fxMetaRows(), buildCrmDaily(orders)), fxSettings());
    t.ok(text.indexOf('Замовлень з Direct: 0 · сума 0 грн') !== -1);
    t.ok(text.indexOf('Instagram Direct: 0 · 0 грн') !== -1);
  });
  t.test('розбіжність піксель vs CRM 🟡/🔴 додає підказку; Без UTM ≥ порога -> 🟡 + підказка', function () {
    const orders = fxOrders().filter(function (o) { return !(o.date === FX_DATE && o.source_group === 'quickorders' && o.channel === 'meta_ads'); }); // CRM 7 проти пікселя 9 -> 22%
    const text = buildMetaMsg1(computeReport(FX_DATE, fxMetaRows(), buildCrmDaily(orders)), fxSettings());
    t.ok(text.indexOf('Піксель vs CRM (сайт): 9 │ 7 🟡\n👉 перевірити UTM в оголошеннях і роботу пікселя') !== -1, text);

    const noUtmHeavy = fxOrders().concat([
      fxOrder_(9001, FX_DATE, 'site', {}, true, 1000), fxOrder_(9002, FX_DATE, 'site', {}, true, 1000),
      fxOrder_(9003, FX_DATE, 'site', {}, true, 1000), fxOrder_(9004, FX_DATE, 'site', {}, true, 1000)
    ]); // 7 без UTM з 17 = 41%
    const text2 = buildMetaMsg1(computeReport(FX_DATE, fxMetaRows(), buildCrmDaily(noUtmHeavy)), fxSettings());
    t.ok(text2.indexOf('Без UTM-мітки: 7 замовл. (не враховано) 🟡\n👉 41% замовлень сайту без міток — перевірити URL parameters в оголошеннях') !== -1, text2);
  });
}

// ---- наскрізні сценарії ----

function makeMemStore_() {
  const data = {};
  return {
    data: data,
    readRaw: function () { return []; },
    read: function (n) { return (data[n] || []).map(function (r) { return Object.assign({}, r); }); },
    write: function (n, rows) { data[n] = rows.map(function (r) { return Object.assign({}, r); }); },
    append: function (n, rows) { data[n] = (data[n] || []).concat(rows); }
  };
}

// opts: metaError, crmError, settings, rules
function makeMemDeps_(opts) {
  opts = opts || {};
  const calls = { fetchMeta: 0, fetchOrders: 0, send: [], alerts: [], logs: [] };
  const state = {};
  const deps = {
    calls: calls,
    store: makeMemStore_(),
    now: function () { return new Date('2026-10-06T06:00:00Z'); }, // 09:00 Київ
    log: function (level, msg) { calls.logs.push(level + ': ' + msg); },
    getSettings: function () { return opts.settings || fxSettings(); },
    getRules: function () { return opts.rules || parseRuleRows(DEFAULT_UTM_RULES); },
    fetchMeta: function (from, to) {
      calls.fetchMeta++;
      if (opts.metaError) throw opts.metaError;
      return { days: fxMetaRows().filter(function (r) { return r.date >= from && r.date <= to; }), directCampaigns: ['111'] };
    },
    fetchOrders: function (from, to) {
      calls.fetchOrders++;
      if (opts.crmError) throw opts.crmError;
      return fxOrders().filter(function (o) { return o.date >= from && o.date <= to; });
    },
    sendText: function (chat, text) { calls.send.push({ chat: chat, text: text }); return { messageIds: [calls.send.length] }; },
    chatId: function () { return '-100'; },
    alert: function (text) { calls.alerts.push(text); },
    state: { get: function (k) { return state[k]; }, set: function (k, v) { state[k] = v; } }
  };
  return deps;
}

function suiteFlow_(t) {
  t.test('повний запуск: дані -> таблиця -> текст у «Звіт_Щодня» -> відправка тексту З ЛИСТА', function () {
    const deps = makeMemDeps_();
    const r = runDailyReportWith(deps, { send: true });
    t.eq(r.status, 'ok');
    t.eq(r.date, '2026-10-05');
    t.eq(deps.calls.send.length, 1);
    t.text(deps.calls.send[0].text, fxReferenceMsg1());
    const rows = deps.store.read('Звіт_Щодня');
    t.eq(rows.length, 1);
    t.eq(rows[0].status, 'sent');
    t.eq(rows[0].tg_message_id, '1');
    t.eq(deps.calls.alerts.length, 0);
  });
  t.test('правка тексту в таблиці перед відправкою потрапляє в Telegram (бот читає лист)', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: false });
    const rows = deps.store.read('Звіт_Щодня');
    t.eq(rows[0].status, 'ready');
    rows[0].text = 'виправлено вручну';
    deps.store.write('Звіт_Щодня', rows);
    sendReportFromSheetWith(deps, '2026-10-05', {});
    t.eq(deps.calls.send[0].text, 'виправлено вручну');
  });
  t.test('захист від дублів: другий запуск за ту саму дату нічого не надсилає; resend надсилає знову', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: true });
    runDailyReportWith(deps, { send: true });
    t.eq(deps.calls.send.length, 1);
    sendReportFromSheetWith(deps, '2026-10-05', { force: true });
    t.eq(deps.calls.send.length, 2);
  });
  t.test('upsert: повторний запуск не створює дублів у жодному листі', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: false });
    const first = {};
    Object.keys(deps.store.data).forEach(function (n) { if (n !== 'Лог') first[n] = deps.store.data[n].length; });
    runDailyReportWith(deps, { send: false });
    Object.keys(first).forEach(function (n) {
      t.eq(deps.store.data[n].length, first[n], 'лист ' + n);
    });
    t.eq(deps.store.data['Meta_Daily'].length, 8);
    t.eq(deps.store.data['Звіт_Щодня'].length, 1);
    Object.keys(SHEETS).forEach(function (n) {
      const keys = SHEETS[n].keys;
      if (!keys.length || !deps.store.data[n]) return;
      const seen = {};
      deps.store.data[n].forEach(function (r) {
        const k = rowKey_(r, keys);
        t.ok(!seen[k], 'дубль ключа ' + k + ' у ' + n);
        seen[k] = true;
      });
    });
  });
  t.test('KeyCRM недоступний: звіт відправлено з «дані KeyCRM недоступні» і надіслано алерт', function () {
    const deps = makeMemDeps_({ crmError: new Error('KeyCRM API: HTTP 500') });
    const r = runDailyReportWith(deps, { send: true });
    t.eq(r.status, 'ok');
    t.eq(r.crmOk, false);
    t.eq(deps.calls.send.length, 1);
    t.ok(deps.calls.send[0].text.indexOf('дані KeyCRM недоступні') !== -1);
    t.ok(deps.calls.send[0].text.indexOf('Нових розмов: 46') !== -1);
    t.eq(deps.calls.alerts.length, 1);
    t.ok(deps.calls.alerts[0].indexOf('KeyCRM') !== -1);
  });
  t.test('ID джерел KeyCRM не задано: у звіті «дані KeyCRM недоступні» замість хибних нулів', function () {
    const deps = makeMemDeps_({ settings: fxSettings({ keycrm_source_site_ids: '', keycrm_source_quickorders_ids: '', keycrm_source_instagram_ids: '' }) });
    runDailyReportWith(deps, { send: false });
    const text = deps.store.read('Звіт_Щодня')[0].text;
    t.ok(text.indexOf('📥 ЗАМОВЛЕННЯ З META (KeyCRM)\nдані KeyCRM недоступні') !== -1);
    t.ok(text.indexOf('ROAS 0,00×') === -1);
    t.ok(deps.calls.logs.some(function (l) { return l.indexOf('keycrm_source_') !== -1; }));
  });
  t.test('Meta недоступна: звіт НЕ надсилається, є алерт', function () {
    const deps = makeMemDeps_({ metaError: new Error('Meta API: HTTP 500') });
    const r = runDailyReportWith(deps, { send: true });
    t.eq(r.status, 'meta_failed');
    t.eq(deps.calls.send.length, 0);
    t.eq(deps.calls.alerts.length, 1);
  });
  t.test('недійсний токен Meta (код 190) -> спеціальний алерт', function () {
    const e = makeMetaError_(400, { error: { code: 190, message: 'Invalid OAuth access token' } });
    const deps = makeMemDeps_({ metaError: e });
    runDailyReportWith(deps, { send: true });
    t.ok(deps.calls.alerts[0].indexOf('Токен Meta недійсний — потрібно оновити META_ACCESS_TOKEN') !== -1);
  });
  t.test('report_send_enabled = FALSE: текст у таблиці є, відправки немає', function () {
    const deps = makeMemDeps_({ settings: fxSettings({ report_send_enabled: false }) });
    runDailyReportWith(deps, { send: true });
    t.eq(deps.calls.send.length, 0);
    t.eq(deps.store.read('Звіт_Щодня')[0].status, 'ready');
  });
  t.test('помилка Telegram -> status = error + алерт; наступна відправка повторює', function () {
    const deps = makeMemDeps_();
    let fail = true;
    const orig = deps.sendText;
    deps.sendText = function (c, x) { if (fail) throw new Error('Telegram sendMessage: HTTP 400'); return orig(c, x); };
    runDailyReportWith(deps, { send: true });
    t.eq(deps.store.read('Звіт_Щодня')[0].status, 'error');
    t.eq(deps.calls.alerts.length, 1);
    fail = false;
    sendReportFromSheetWith(deps, '2026-10-05', {});
    t.eq(deps.store.read('Звіт_Щодня')[0].status, 'sent');
  });
  t.test('невідоме джерело KeyCRM: попередження в Лог, алерт не частіше разу на добу', function () {
    const deps = makeMemDeps_();
    const orig = deps.fetchOrders;
    deps.fetchOrders = function (f, to) {
      return orig(f, to).concat([Object.assign(fxOrder_(777, FX_DATE, 'other', {}, true, 100), { source_id: '42' })]);
    };
    runDailyReportWith(deps, { send: false });
    runDailyReportWith(deps, { send: false });
    t.eq(deps.calls.alerts.length, 1);
    t.ok(deps.calls.logs.some(function (l) { return l.indexOf('WARN') === 0 && l.indexOf('42') !== -1; }));
  });
  t.test('reclassifyOrders: зміна правил перераховує channel і CRM_Daily без запитів до API', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: false });
    const fetches = deps.calls.fetchOrders;
    const before = deps.store.read('CRM_Daily').filter(function (r) { return r.date === FX_DATE && r.channel === 'meta_ads'; });
    t.ok(before.length > 0);
    const cut = parseRuleRows(DEFAULT_UTM_RULES).filter(function (r) { return r.priority !== 30 && r.priority !== 40; });
    deps.getRules = function () { return cut; };
    reclassifyOrdersWith(deps);
    t.eq(deps.calls.fetchOrders, fetches, 'API не викликалось');
    t.eq(deps.store.read('CRM_Daily').filter(function (r) { return r.date === FX_DATE && r.channel === 'meta_ads'; }).length, 0);
    t.ok(deps.store.read('CRM_Daily').some(function (r) { return r.date === FX_DATE && r.channel === 'meta_organic'; }));
  });
  t.test('backfill: підтягує N днів і не дублює при повторі', function () {
    const deps = makeMemDeps_();
    backfillWith(deps, 30);
    const n = deps.store.read('Meta_Daily').length;
    backfillWith(deps, 30);
    t.eq(deps.store.read('Meta_Daily').length, n);
  });
}
