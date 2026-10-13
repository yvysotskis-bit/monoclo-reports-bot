// Тести надійності: повторні запуски, часткові збої, одночасні запуски, дублі, реальні формати відповідей API.
// Сценарії з підміною глобальних сервісів Apps Script (SpreadsheetApp, LockService…) виконуються лише в Node:
// в Apps Script ці глобальні об'єкти справжні, і чіпати їх не можна.

function inNode_() {
  return typeof SpreadsheetApp === 'undefined' && typeof PropertiesService === 'undefined' && typeof LockService === 'undefined' && typeof UrlFetchApp === 'undefined';
}

// Тимчасово підмінює глобальні імена; після fn повертає як було
function withGlobals_(over, fn) {
  const g = globalThis;
  const saved = {};
  Object.keys(over).forEach(function (k) {
    saved[k] = { had: Object.prototype.hasOwnProperty.call(g, k), val: g[k] };
    g[k] = over[k];
  });
  try {
    return fn();
  } finally {
    Object.keys(saved).forEach(function (k) {
      if (saved[k].had) g[k] = saved[k].val;
      else delete g[k];
    });
  }
}

// Імітація аркуша Google Sheets: зберігає клітинки й журнал операцій (щоб перевіряти ПОРЯДОК записів)
function makeFakeSheet_(width, dataRows, opts) {
  opts = opts || {};
  const cells = [];
  const sheet = {
    ops: [],
    cells: cells,
    maxRows: 1000,
    getLastRow: function () {
      for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i] && cells[i].some(function (c) { return c !== ''; })) return i + 1;
      }
      return 0;
    },
    getMaxRows: function () { return sheet.maxRows; },
    insertRowsAfter: function (pos, n) { sheet.maxRows += n; },
    getLastColumn: function () { return width; },
    getRange: function (r, c, nr, nc) {
      return {
        getValues: function () {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = cells[r - 1 + i] || [];
            const o = [];
            for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] == null ? '' : row[c - 1 + j]);
            out.push(o);
          }
          return out;
        },
        setValues: function (vals) {
          sheet.ops.push('set:' + r + '+' + nr);
          if (opts.failSet) throw new Error('збій запису');
          vals.forEach(function (row, i) {
            cells[r - 1 + i] = cells[r - 1 + i] || [];
            row.forEach(function (v, j) { cells[r - 1 + i][c - 1 + j] = v; });
          });
        },
        clearContent: function () {
          sheet.ops.push('clear:' + r + '+' + nr);
          for (let i = 0; i < nr; i++) {
            for (let j = 0; j < nc; j++) {
              if (cells[r - 1 + i]) cells[r - 1 + i][c - 1 + j] = '';
            }
          }
        }
      };
    }
  };
  cells.push(new Array(width).fill('h'));
  (dataRows || []).forEach(function (r) { cells.push(r.slice()); });
  return sheet;
}

function fakeSpreadsheetApp_(sheet) {
  const ss = {
    getSheetByName: function () { return sheet; },
    insertSheet: function () { return sheet; },
    getSpreadsheetTimeZone: function () { return 'Europe/Kyiv'; }
  };
  return { getActiveSpreadsheet: function () { return ss; } };
}

function metaDailyRow_(date, spend) {
  const r = { date: date, spend: spend };
  SHEETS['Meta_Daily'].headers.forEach(function (h) { if (r[h] === undefined) r[h] = 0; });
  return r;
}

function suiteStoreSafety_(t) {
  if (!inNode_()) return;
  const width = SHEETS['Meta_Daily'].headers.length;
  function dataRow(d, spend) {
    const row = SHEETS['Meta_Daily'].headers.map(function () { return 0; });
    row[0] = d;
    row[1] = spend;
    return row;
  }
  t.test('запис листа: спершу нові дані, потім очищення зайвого "хвоста" (скорочення 5 -> 2 рядки)', function () {
    const sheet = makeFakeSheet_(width, [dataRow('d1', 1), dataRow('d2', 2), dataRow('d3', 3), dataRow('d4', 4), dataRow('d5', 5)]);
    withGlobals_({ SpreadsheetApp: fakeSpreadsheetApp_(sheet) }, function () {
      sheetStore().write('Meta_Daily', [metaDailyRow_('n1', 10), metaDailyRow_('n2', 20)]);
      t.eq(sheet.ops, ['set:2+2', 'clear:4+3']);
      const back = sheetStore().read('Meta_Daily');
      t.eq(back.map(function (r) { return r.date; }), ['n1', 'n2']);
    });
  });
  t.test('запис листа: збільшення не очищує нічого; порожній набір очищає все без запису', function () {
    const sheet = makeFakeSheet_(width, [dataRow('d1', 1), dataRow('d2', 2)]);
    withGlobals_({ SpreadsheetApp: fakeSpreadsheetApp_(sheet) }, function () {
      sheetStore().write('Meta_Daily', [metaDailyRow_('a', 1), metaDailyRow_('b', 2), metaDailyRow_('c', 3), metaDailyRow_('d', 4)]);
      t.eq(sheet.ops, ['set:2+4']);
      sheet.ops.length = 0;
      sheetStore().write('Meta_Daily', []);
      t.eq(sheet.ops, ['clear:2+4']);
      t.eq(sheetStore().read('Meta_Daily').length, 0);
    });
  });
  t.test('збій під час запису НЕ стирає старі дані (раніше лист спершу очищався)', function () {
    const sheet = makeFakeSheet_(width, [dataRow('d1', 1), dataRow('d2', 2), dataRow('d3', 3)], { failSet: true });
    withGlobals_({ SpreadsheetApp: fakeSpreadsheetApp_(sheet) }, function () {
      t.throws(function () {
        sheetStore().write('Meta_Daily', [metaDailyRow_('n1', 10)]);
      });
      t.eq(sheet.ops, ['set:2+1']); // до очищення справа не дійшло
      t.eq(
        sheetStore().read('Meta_Daily').map(function (r) { return r.date; }),
        ['d1', 'd2', 'd3']
      );
    });
  });
}

function suiteLocks_(t) {
  t.test('розклад: повторні запуски о 11:00 і 14:00; кожен обробник існує як функція', function () {
    const handlers = TRIGGERS.map(function (x) { return x.handler; });
    t.eq(handlers.filter(function (h) { return h === 'runDailyReportRetry'; }).length, 2);
    t.ok(handlers.indexOf('runDailyReport') !== -1);
    TRIGGERS.forEach(function (x) {
      t.eq(typeof globalThis[x.handler], 'function', x.handler);
      t.ok(x.hour >= 0 && x.hour <= 23);
    });
  });
  if (!inNode_()) return;
  function lockEnv(canLock) {
    const state = { locked: 0, released: 0 };
    const sheet = makeFakeSheet_(3, []);
    return {
      state: state,
      globals: {
        SpreadsheetApp: fakeSpreadsheetApp_(sheet),
        PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return null; }, setProperty: function () {} }; } },
        LockService: {
          getScriptLock: function () {
            return {
              tryLock: function () { state.locked++; return canLock; },
              releaseLock: function () { state.released++; }
            };
          }
        }
      }
    };
  }
  t.test('замок: якщо інший запуск триває — запуск пропускається, робота не виконується', function () {
    const env = lockEnv(false);
    withGlobals_(env.globals, function () {
      let ran = false;
      const r = lockedRun_('тест', function () { ran = true; });
      t.eq(r, { status: 'locked' });
      t.eq(ran, false);
      t.eq(env.state.released, 0);
    });
  });
  t.test('замок: звільняється і після помилки в роботі; результат передається', function () {
    const env = lockEnv(true);
    withGlobals_(env.globals, function () {
      t.eq(lockedRun_('тест', function () { return 42; }), 42);
      t.throws(function () {
        lockedRun_('тест', function () { throw new Error('збій'); });
      });
      t.eq(env.state.locked, 2);
      t.eq(env.state.released, 2);
    });
  });
}

function suiteKeycrmReal_(t) {
  // Рядки взято з реальної відповіді KeyCRM (персональні дані прибрано)
  const comment =
    'Client: X\n\nPhone: +380000000000\n\nSessionId: 6acabe\n\nUTM: utm_source: facebook; utm_medium: cpc; utm_campaign: warm; fbclid: PAZXh0bgNh\n\n__ref_id: f$Db"xOh[#[H1+\\gQ4T\n\nDraftOrderId: 1626320011485';
  t.test('UTM з коментаря: реальний формат інтеграції сайту', function () {
    t.eq(utmFromComment(comment), { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'warm', fbclid: 'PAZXh0bgNh' });
  });
  t.test('UTM з коментаря: пробіли в значенні, службові рядки після мітки не підхоплюються', function () {
    const c = 'Prepayment: Yes\nUTM: utm_source: google; utm_medium: cpc; utm_campaign: Google Shopping\n__ref_id: vR+j$HoD\nPrepayment method: x';
    t.eq(utmFromComment(c), { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'Google Shopping' });
  });
  t.test('UTM з коментаря: без рядка "UTM:" або з чужим текстом — порожньо; невідомі ключі ігноруються', function () {
    t.eq(utmFromComment(''), {});
    t.eq(utmFromComment(null), {});
    t.eq(utmFromComment('utm_source: evil\nклієнт просив utm_medium: x'), {});
    t.eq(utmFromComment('UTM: foo: bar; utm_source: ig; utm_medium: '), { utm_source: 'ig' });
    t.eq(utmFromComment('UTM:'), {});
  });
  const settings = fxSettings({ keycrm_source_site_ids: '212', keycrm_source_quickorders_ids: '216', keycrm_source_instagram_ids: '198', keycrm_excluded_status_ids: '' });
  const rules = parseRuleRows(DEFAULT_UTM_RULES);
  function norm(raw) {
    return normalizeOrder(raw, { settings: settings, rules: rules, statusNames: {} });
  }
  t.test('замовлення сайту з marketing = null, але з UTM у коментарі -> meta_ads, utm_origin = comment (раніше no_utm)', function () {
    const o = norm({ id: 45027, created_at: '2026-10-10T22:41:34.000000Z', ordered_at: '2026-10-10T22:41:27.000000Z', source_id: 212, status_id: 44, grand_total: 999, marketing: null, manager_comment: comment });
    t.eq(o.utm_origin, 'comment');
    t.eq(o.channel, 'meta_ads');
    t.eq(o.utm_source, 'facebook');
    t.eq(o.fbclid, 'PAZXh0bgNh');
    t.eq(o.date, '2026-10-11'); // ordered_at 22:41Z = 01:41 11.10 за Києвом
  });
  t.test('marketing має пріоритет над коментарем; google cpc з коментаря -> google_ads', function () {
    const both = norm({ id: 1, created_at: '2026-10-10T10:00:00.000000Z', source_id: 212, status_id: 1, marketing: { utm_source: 'google', utm_medium: 'cpc' }, manager_comment: comment });
    t.eq(both.utm_origin, 'keycrm');
    t.eq(both.channel, 'google_ads');
    const g = norm({ id: 2, created_at: '2026-10-10T10:00:00.000000Z', source_id: 212, status_id: 1, marketing: null, manager_comment: 'UTM: utm_source: google; utm_medium: cpc; utm_campaign: Google Shopping' });
    t.eq(g.channel, 'google_ads');
  });
  t.test('Shopify-резерв не запитує замовлення, у яких мітки вже є в коментарі (економія часу й ліміту)', function () {
    const raw = { id: 7, source_id: 212, source_uuid: 'M-CL6342', marketing: null, manager_comment: comment };
    const fb = buildShopifyFallback_([raw], settings, {}, '2026-10-12'); // якби запит був — shopifyGraphql_ кинув би помилку про секрети
    t.eq(fb(raw), null);
  });
  t.test('Keycrm: параметри запиту (вікно ±1 доба, include) і пагінація за реальною формою відповіді', function () {
    const calls = [];
    withGlobals_(
      {
        keycrmGetAll: function (path, params) {
          calls.push({ path: path, params: params });
          if (path === KEYCRM_ENDPOINTS.statuses) return [{ id: 44, name: 'Передано на друк' }];
          return [{ id: 1, created_at: '2026-10-06T10:00:00.000000Z', ordered_at: '2026-10-06T10:00:00.000000Z', source_id: 212, status_id: 44, grand_total: 1 }];
        }
      },
      function () {
        const orders = fetchKeycrmOrders('2026-10-05', '2026-10-06', Object.assign({}, settings, { shopify_utm_fallback: false }), rules, {});
        const ord = calls.filter(function (c) { return c.path === KEYCRM_ENDPOINTS.orders; })[0];
        t.eq(ord.params['filter[created_between]'], '2026-10-04 00:00:00,2026-10-07 23:59:59');
        t.eq(ord.params.include, 'marketing');
        t.eq(orders.length, 1);
        t.eq(orders[0].status_name, 'Передано на друк');
      }
    );
  });
  t.test('Keycrm: пагінація зупиняється за last_page (в т.ч. коли остання сторінка повна) і не робить зайвих запитів', function () {
    function page(n, count, last) {
      const data = [];
      for (let i = 0; i < count; i++) data.push({ id: n * 1000 + i });
      return { current_page: n, data: data, last_page: last, per_page: 50, total: 100 };
    }
    withGlobals_({ Utilities: { sleep: function () {} } }, function () {
      let calls = 0;
      withGlobals_({ keycrmGet_: function (path, params) { calls++; return page(params.page, 50, 2); } }, function () {
        t.eq(keycrmGetAll('/order', {}).length, 100);
      });
      t.eq(calls, 2, 'рівно 2 запити');
      calls = 0;
      withGlobals_({ keycrmGet_: function (path, params) { calls++; return params.page === 1 ? page(1, 50, 3) : params.page === 2 ? page(2, 50, 3) : page(3, 20, 3); } }, function () {
        t.eq(keycrmGetAll('/order', {}).length, 120);
      });
      t.eq(calls, 3);
      calls = 0;
      withGlobals_({ keycrmGet_: function (path, params) { calls++; return params.page === 1 ? { data: [{ id: 1 }, { id: 2 }] } : { data: [] }; } }, function () {
        t.eq(keycrmGetAll('/order', {}).length, 2); // без last_page: неповна сторінка завершує читання
      });
      t.eq(calls, 1);
    });
  });
  t.test('Keycrm: одне биття замовлення (без дати) пропускається з повідомленням, решта завантажується', function () {
    withGlobals_(
      {
        keycrmGetAll: function (path) {
          if (path === KEYCRM_ENDPOINTS.statuses) return [];
          return [
            { id: 1, created_at: '2026-10-06T10:00:00.000000Z', source_id: 212, status_id: 1 },
            { id: 2, created_at: 'не дата', source_id: 212, status_id: 1 },
            { id: 3, created_at: '2026-10-06T11:00:00.000000Z', source_id: 212, status_id: 1 }
          ];
        }
      },
      function () {
        const orders = fetchKeycrmOrders('2026-10-06', '2026-10-06', Object.assign({}, settings, { shopify_utm_fallback: false }), rules, {});
        t.eq(
          orders.map(function (o) { return o.order_id; }),
          ['1', '3']
        );
        t.eq(orders.skipped.length, 1);
        t.ok(orders.skipped[0].indexOf('2') === 0);
      }
    );
  });
}

function suiteMergeRound_(t) {
  t.test('мультиакаунт: суми по датах без дробових "хвостів"; різні дати не змішуються', function () {
    const mk = function (date, spend, pv) {
      return { date: date, spend: spend, impressions: 10, reach: 5, link_clicks: 1, view_content: 0, add_to_cart: 0, initiate_checkout: 0, purchases: 1, purchase_value: pv, conversations_started: 0, first_replies: 0, direct_spend: 0 };
    };
    const merged = mergeAccountDays([
      [mk('2026-10-04', 1998.1, 3000.1), mk('2026-10-05', 5, 1)],
      [mk('2026-10-04', 3048.34, 4469.58)]
    ]);
    t.eq(merged.length, 2);
    t.eq(merged[0].spend, 5046.44);
    t.eq(merged[0].purchase_value, 7469.68);
    t.eq(merged[0].impressions, 20);
    t.eq(merged[1].spend, 5);
  });
}

function suiteConfigRobust_(t) {
  t.test('налаштування: порожній дубль ключа не стирає значення (в обидва боки), різні значення -> діє останнє + попередження', function () {
    t.eq(parseSettingsRows([['keycrm_source_site_ids', ''], ['keycrm_source_site_ids', 212]]).keycrm_source_site_ids, 212);
    t.eq(parseSettingsRows([['keycrm_source_site_ids', 212], ['keycrm_source_site_ids', '']]).keycrm_source_site_ids, 212);
    t.eq(parseSettingsRows([['keycrm_source_site_ids', 1], ['keycrm_source_site_ids', 2]]).keycrm_source_site_ids, 2);
    t.eq(findDuplicateSettings([['a', 1], ['a', 2], ['b', 3], ['b', 3], ['c', ''], ['c', 5]]), ['a: 1 / 2']);
  });
  t.test('Правила_UTM: некоректний regex не валить класифікацію, а потрапляє у список попереджень', function () {
    const rules = parseRuleRows([
      { priority: 10, channel: 'google_ads', field: 'utm_source', operator: 'regex', values: '([', comment: '' },
      { priority: 20, channel: 'meta_ads', field: 'utm_source', operator: 'in', values: 'facebook', comment: '' },
      { priority: 30, channel: 'x', field: 'utm_source', operator: 'схожий', values: 'a', comment: '' },
      { priority: 40, channel: 'y', field: 'utm_source', operator: 'in', values: ' , ', comment: '' }
    ]);
    t.eq(classifyChannel('site', { utm_source: 'facebook' }, rules), 'meta_ads');
    const bad = findInvalidRules(rules);
    t.eq(bad.length, 3);
    t.ok(bad[0].indexOf('regex') !== -1 && bad[1].indexOf('оператор') !== -1 && bad[2].indexOf('порожній') !== -1);
    t.eq(findInvalidRules(parseRuleRows(DEFAULT_UTM_RULES)), []);
  });
  t.test('Звіт_Щодня: примусова перебудова зберігає статус sent і id повідомлення (інакше наступна відправка дублювала б)', function () {
    const existing = [{ date: 'd', report: 'meta', message_no: 1, text: 'старий', status: 'sent', sent_at: '2026-10-06 09:00:00', tg_message_id: '8', error: '' }];
    const incoming = [{ date: 'd', report: 'meta', message_no: 1, text: 'новий', status: 'ready', sent_at: '', tg_message_id: '', error: '' }];
    const forced = mergeReportRows(existing, incoming, true);
    t.eq(forced.length, 1);
    t.eq(forced[0].text, 'новий');
    t.eq(forced[0].status, 'sent');
    t.eq(forced[0].tg_message_id, '8');
    t.ok(forced[0].error.indexOf('перебудовано') !== -1);
    t.eq(mergeReportRows(existing, incoming, false)[0].text, 'старий'); // без force sent не змінюється
    const same = mergeReportRows(existing, [Object.assign({}, incoming[0], { text: 'старий' })], true);
    t.eq(same[0].error, '');
  });
}

function suiteTelegramRobust_(t) {
  if (!inNode_()) return;
  const longText = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000);
  t.test('Telegram: збій на 2-й частині довгого звіту -> у помилці id уже надісланої частини; повтор надсилає лише решту', function () {
    t.eq(buildTelegramMessages(longText).length, 2);
    let n = 0;
    const stubs = {
      requireSecret: function () { return 'T'; },
      tgCall_: function () {
        n++;
        if (n === 2) {
          const e = new Error('Telegram sendMessage: HTTP 400 Bad Request');
          e.http = 400;
          throw e;
        }
        return { message_id: 100 + n };
      }
    };
    withGlobals_(stubs, function () {
      let err = null;
      try {
        sendTelegramText('-1', longText);
      } catch (e) {
        err = e;
      }
      t.ok(err, 'очікувалась помилка');
      t.eq(err.sentIds, [101]);
      n = 5;
      const res = sendTelegramText('-1', longText, 1);
      t.eq(res.messageIds, [106]); // лише друга частина
      t.eq(sendTelegramText('-1', longText, 2).messageIds, []);
    });
  });
  t.test('Telegram: довгий алерт обрізається до ліміту, а не відхиляється', function () {
    let sent = null;
    withGlobals_(
      {
        requireSecret: function () { return 'T'; },
        tgCall_: function (token, method, payload) { sent = payload.text; return { message_id: 1 }; }
      },
      function () {
        sendTelegramPlain('-1', 'x'.repeat(5000));
      }
    );
    t.eq(sent.length, TG_LIMIT);
  });
}

function suiteFlowRobust_(t) {
  t.test('довгий звіт: часткова відправка зберігається, повтор не дублює вже доставлену частину', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: false });
    const sendsSeen = [];
    let failOnce = true;
    deps.sendText = function (chat, text, skip) {
      sendsSeen.push(skip);
      if (failOnce) {
        failOnce = false;
        const e = new Error('Telegram: HTTP 500');
        e.sentIds = [41];
        throw e;
      }
      return { messageIds: [42] };
    };
    sendReportFromSheetWith(deps, '2026-10-05', {});
    let row = deps.store.read('Звіт_Щодня')[0];
    t.eq(row.status, 'error');
    t.eq(row.tg_message_id, '41');
    sendReportFromSheetWith(deps, '2026-10-05', {});
    row = deps.store.read('Звіт_Щодня')[0];
    t.eq(row.status, 'sent');
    t.eq(row.tg_message_id, '41,42');
    t.eq(sendsSeen, [0, 1], 'друга спроба пропускає 1 вже доставлену частину');
  });
  t.test('статус sent записується одразу після кожного повідомлення, а не в кінці', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: false });
    const rows = deps.store.read('Звіт_Щодня');
    rows.push(Object.assign({}, rows[0], { message_no: 2, text: 'друга частина' }));
    deps.store.write('Звіт_Щодня', rows);
    let statusBeforeSecond = null;
    let n = 0;
    deps.sendText = function () {
      n++;
      if (n === 2) {
        statusBeforeSecond = deps.store.read('Звіт_Щодня').filter(function (r) { return Number(r.message_no) === 1; })[0].status;
        throw new Error('аварійне завершення запуску');
      }
      return { messageIds: [n] };
    };
    sendReportFromSheetWith(deps, '2026-10-05', {});
    t.eq(statusBeforeSecond, 'sent', 'перше повідомлення вже позначене sent до відправки другого');
  });
  t.test('однаковий алерт не повторюється протягом доби, наступної доби — надсилається знову', function () {
    const deps = makeMemDeps_({ metaError: new Error('Meta API: HTTP 500') });
    runDailyReportWith(deps, { send: true });
    runDailyReportWith(deps, { send: true });
    t.eq(deps.calls.alerts.length, 1);
    deps.now = function () { return new Date('2026-10-07T06:00:00Z'); };
    runDailyReportWith(deps, { send: true });
    t.eq(deps.calls.alerts.length, 2);
  });
  t.test('повторний запуск: звіт уже надіслано -> без звернень до API; не надіслано -> надсилає', function () {
    const deps = makeMemDeps_({ metaError: new Error('Meta API: HTTP 500') });
    t.eq(runDailyReportWith(deps, { send: true }).status, 'meta_failed');
    const good = makeMemDeps_();
    deps.fetchMeta = good.fetchMeta; // Meta "відновилась"
    const r = runDailyReportRetryWith(deps);
    t.eq(r.status, 'ok');
    t.eq(deps.calls.send.length, 1);
    t.eq(runDailyReportRetryWith(deps).status, 'already_sent');
    t.eq(good.calls.fetchMeta, 1, 'другий повтор не викликав Meta');
    t.eq(deps.calls.send.length, 1, 'дубль не надіслано');
  });
  t.test('KeyCRM: видалене замовлення зникає з таблиці й CRM_Daily; повторний запуск стабільний', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: false });
    const before = deps.store.read('KeyCRM_Orders').length;
    const crmBefore = deps.store.read('CRM_Daily').filter(function (r) { return r.date === FX_DATE && r.source_group === 'site' && r.channel === 'meta_ads'; })[0];
    const orig = deps.fetchOrders;
    deps.fetchOrders = function (f, to) {
      return orig(f, to).filter(function (o) { return o.order_id !== '1'; }); // замовлення №1 (сайт, Meta) видалили в KeyCRM
    };
    runDailyReportWith(deps, { send: false });
    t.eq(deps.store.read('KeyCRM_Orders').length, before - 1);
    const crmAfter = deps.store.read('CRM_Daily').filter(function (r) { return r.date === FX_DATE && r.source_group === 'site' && r.channel === 'meta_ads'; })[0];
    t.eq(crmAfter.orders, crmBefore.orders - 1);
    runDailyReportWith(deps, { send: false });
    t.eq(deps.store.read('KeyCRM_Orders').length, before - 1);
  });
  t.test('KeyCRM: порожня або підозріло коротка відповідь не стирає накопичені замовлення', function () {
    const deps = makeMemDeps_();
    runDailyReportWith(deps, { send: false });
    const before = deps.store.read('KeyCRM_Orders').length;
    const orig = deps.fetchOrders;
    deps.fetchOrders = function () { return []; };
    runDailyReportWith(deps, { send: false });
    t.eq(deps.store.read('KeyCRM_Orders').length, before, 'порожня відповідь');
    deps.fetchOrders = function (f, to) {
      return orig(f, to).filter(function (o, i) { return i % 5 === 0; }); // лише 20% замовлень
    };
    runDailyReportWith(deps, { send: false });
    t.eq(deps.store.read('KeyCRM_Orders').length, before, 'підозріло коротка відповідь');
    t.ok(deps.calls.logs.some(function (l) { return l.indexOf('підозрілою') !== -1; }));
  });
  t.test('staleOrderIds: враховує лише замовлення, створені у вікні; старіші й новіші не чіпає', function () {
    const rows = [
      { order_id: '1', created_at_kyiv: '2026-10-01 10:00:00' },
      { order_id: '2', created_at_kyiv: '2026-10-05 10:00:00' },
      { order_id: '3', created_at_kyiv: '2026-10-20 10:00:00' },
      { order_id: '4', created_at_kyiv: '2026-10-06 10:00:00' }
    ];
    t.eq(staleOrderIds(rows, [{ order_id: '4' }], '2026-10-05', '2026-10-10'), { '2': true });
  });
  t.test('акаунт Meta не в київській зоні -> попередження в Лог; київська або невідома — без попередження', function () {
    function logsFor(timezones) {
      const deps = makeMemDeps_();
      const orig = deps.fetchMeta;
      deps.fetchMeta = function (f, to) {
        return Object.assign({}, orig(f, to), { timezones: timezones });
      };
      runDailyReportWith(deps, { send: false });
      return deps.calls.logs.filter(function (l) { return l.indexOf('часовій зоні') !== -1; });
    }
    t.eq(logsFor({ act_1: 'America/Los_Angeles' }).length, 1);
    t.eq(logsFor({ act_1: 'Europe/Kyiv', act_2: '' }).length, 0);
  });
  t.test('часова зона акаунта: помилка запиту не ламає звіт (повертається порожній рядок)', function () {
    if (!inNode_()) return;
    withGlobals_({ metaBase_: function () { return 'https://x'; }, metaFetchJson_: function () { throw new Error('(#100) Tried accessing nonexisting field'); } }, function () {
      t.eq(fetchAccountTimezone_('act_1'), '');
    });
    withGlobals_({ metaBase_: function () { return 'https://x'; }, metaFetchJson_: function () { return { timezone_name: 'Europe/Kyiv' }; } }, function () {
      t.eq(fetchAccountTimezone_('act_1'), 'Europe/Kyiv');
    });
  });
}
