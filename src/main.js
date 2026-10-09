// Точки входу (розділ 8) і оркестрація. Уся логіка працює через об'єкт deps (залежності),
// тому сценарії "KeyCRM недоступний", "Meta недоступна", захист від дублів тестуються без GAS.

// Розклад. Частина Б додасть сюди тижневий (пн 09:30) і місячний (1-ше число 09:30) звіти.
const TRIGGERS = [{ handler: 'runDailyReport', hour: 9, minute: 0 }];

const LOG_MAX_ROWS = 5000;

function defaultDeps() {
  RUN_START_MS = Date.now();
  const store = sheetStore();
  const now = function () {
    return new Date();
  };
  const props = PropertiesService.getScriptProperties();
  return {
    now: now,
    store: store,
    log: makeLogger(store, now),
    getSettings: function () {
      return loadSettings(store);
    },
    getRules: function () {
      return loadUtmRules(store);
    },
    fetchMeta: fetchMetaDays,
    fetchOrders: fetchKeycrmOrders,
    sendText: sendTelegramText,
    chatId: function (secretName) {
      return getSecret(secretName) || requireSecret('TG_CHAT_ID');
    },
    alert: function (text) {
      sendTelegramPlain(getSecret('TG_ALERT_CHAT_ID') || requireSecret('TG_CHAT_ID'), text);
    },
    state: {
      get: function (k) {
        return props.getProperty('state_' + k);
      },
      set: function (k, v) {
        props.setProperty('state_' + k, String(v));
      }
    }
  };
}

function yesterday_(deps) {
  return addDays(dateInTz(deps.now(), KYIV_TZ), -1);
}

function normDate_(arg, deps) {
  if (arg == null || arg === '') return yesterday_(deps);
  if (arg instanceof Date) return dateInTz(arg, KYIV_TZ);
  return String(arg);
}

function errText_(e) {
  return redactSecrets_(e && e.message ? e.message : String(e));
}

// Текст алерта про збій Meta: окремі підказки для недійсного токена та заблокованого доступу
function metaAlertText_(e) {
  if (e && e.isTokenError) return '🚨 Токен Meta недійсний — потрібно оновити META_ACCESS_TOKEN';
  const base = '🚨 Дані Meta недоступні, звіт не надіслано: ' + errText_(e);
  if (e && (e.metaCode === 200 || e.metaCode === 10)) {
    return base + '\n👉 Перевірте: Налаштування бізнесу → Системні користувачі → Reports Bot → Призначені ресурси (чи є цей акаунт) і чи не обмежено додаток Monoclo Reports. Діагностика: функція checkMeta.';
  }
  return base;
}

function alertSafe_(deps, text) {
  try {
    deps.alert(text);
  } catch (e) {
    deps.log('ERROR', 'Не вдалося надіслати алерт: ' + errText_(e));
  }
}

function rebuildCrmDaily_(store, dates) {
  const rows = buildCrmDaily(store.read('KeyCRM_Orders'), dates);
  store.write('CRM_Daily', replaceByDates(store.read('CRM_Daily'), rows, dates));
}

// Нове невідоме джерело: попередження в Лог і не частіше разу на добу — в алерт-чат
function warnUnknownSources_(deps, orders) {
  const ids = {};
  const ignored = settingList(deps.getSettings(), 'keycrm_source_other_ids');
  orders.forEach(function (o) {
    if (o.source_group === 'other' && ignored.indexOf(String(o.source_id)) === -1) ids[o.source_id || '(порожньо)'] = true;
  });
  const list = Object.keys(ids);
  if (!list.length) return;
  const msg = 'Невідомі джерела KeyCRM (source_group = other): ' + list.join(', ') + '. Додайте їх у «Налаштування» (keycrm_source_*_ids).';
  deps.log('WARN', msg);
  const today = dateInTz(deps.now(), KYIV_TZ);
  if (deps.state.get('unknown_source_alert') !== today) {
    deps.state.set('unknown_source_alert', today);
    alertSafe_(deps, '⚠️ ' + msg);
  }
}

// Збирає дані Meta і KeyCRM за [from, to] у таблицю. Повертає {metaOk, crmOk}.
function collectData(deps, from, to) {
  const settings = deps.getSettings();
  const rules = deps.getRules();
  const stamp = dateTimeInTz(deps.now(), KYIV_TZ);
  const res = { metaOk: false, crmOk: false };
  const sec = function (t0) {
    return Math.round((deps.now().getTime() - t0) / 1000) + ' с';
  };
  let t0 = deps.now().getTime();

  try {
    const m = deps.fetchMeta(from, to, settings);
    upsertSheet(
      deps.store,
      'Meta_Daily',
      m.days.map(function (d) {
        return Object.assign({}, d, { updated_at: stamp });
      })
    );
    deps.log('INFO', 'Meta: етап тривав ' + sec(t0));
    deps.log('INFO', 'Meta: оновлено ' + m.days.length + ' дн. (' + from + '…' + to + '). Валюти акаунтів: ' + JSON.stringify(m.currencies || {}) + '. Direct-кампанії з витратами: ' + (m.directCampaigns.join(', ') || 'немає'));
    if (m.fxFallback) deps.log('WARN', 'Курс НБУ недоступний — використано фіксований курс з налаштувань (meta_fx_fixed_rate)');
    res.metaOk = true;
  } catch (e) {
    deps.log('ERROR', 'Meta: ' + errText_(e));
    alertSafe_(deps, metaAlertText_(e));
  }

  t0 = deps.now().getTime();
  deps.log('INFO', 'KeyCRM: завантаження замовлень…');
  try {
    const existing = {};
    deps.store.read('KeyCRM_Orders').forEach(function (r) {
      existing[String(r.order_id)] = r;
    });
    const orders = deps.fetchOrders(from, to, settings, rules, existing);
    if (orders.shopifyError) {
      deps.log('WARN', 'Shopify (резерв UTM) недоступний: ' + orders.shopifyError);
      alertSafe_(deps, '⚠️ Резерв UTM із Shopify недоступний: ' + orders.shopifyError);
    }
    upsertSheet(
      deps.store,
      'KeyCRM_Orders',
      orders.map(function (o) {
        return Object.assign({}, o, { updated_at: stamp });
      })
    );
    rebuildCrmDaily_(deps.store, dateRange(from, to));
    deps.log('INFO', 'KeyCRM (разом із Shopify та записом у таблицю): етап тривав ' + sec(t0));
    deps.log('INFO', 'KeyCRM: оновлено ' + orders.length + ' замовл. (' + from + '…' + to + ')');
    warnUnknownSources_(deps, orders);
    res.crmOk = true;
  } catch (e) {
    deps.log('ERROR', 'KeyCRM: ' + errText_(e));
    alertSafe_(deps, '🚨 KeyCRM недоступний, звіт надіслано без даних CRM: ' + errText_(e));
  }
  return res;
}

function buildDailyReportWith(deps, date, opts) {
  opts = opts || {};
  const settings = deps.getSettings();
  const from = addDays(date, -7);
  const metaRows = deps.store.read('Meta_Daily').filter(function (r) {
    return r.date >= from && r.date <= date;
  });
  const crmRows = deps.store.read('CRM_Daily');
  const def = getReportRegistry().meta;
  // Поки в «Налаштуваннях» не задано жодного ID джерела KeyCRM, усі замовлення були б "other" і дали б хибні нулі
  const sourcesConfigured = ['site', 'quickorders', 'instagram'].some(function (g) {
    return settingList(settings, 'keycrm_source_' + g + '_ids').length > 0;
  });
  if (!sourcesConfigured) deps.log('WARN', 'Не заповнено keycrm_source_*_ids у «Налаштуваннях» — блок CRM у звіті показано як недоступний');
  const msgs = def.build({ date: date, settings: settings, metaRows: metaRows, crmRows: crmRows, crmAvailable: opts.crmAvailable !== false && sourcesConfigured });
  const rows = msgs.map(function (m) {
    return { date: date, report: def.id, message_no: m.message_no, text: m.text, status: 'ready', sent_at: '', tg_message_id: '', error: '' };
  });
  deps.store.write('Звіт_Щодня', mergeReportRows(deps.store.read('Звіт_Щодня'), rows, !!opts.force));
  deps.log('INFO', 'Звіт ' + def.id + ' за ' + date + ' сформовано в листі «Звіт_Щодня» (' + rows.length + ' повідомл.)');
}

// Читає готовий текст З ЛИСТА і надсилає. Рядки зі статусом sent пропускає (захист від дублів), крім opts.force.
function sendReportFromSheetWith(deps, date, opts) {
  opts = opts || {};
  const report = opts.report || 'meta';
  const settings = deps.getSettings();
  if (!settingBool(settings, 'report_send_enabled')) {
    deps.log('INFO', 'Відправку вимкнено (report_send_enabled = FALSE)');
    return { sent: 0, skipped: 'disabled' };
  }
  const def = getReportRegistry()[report];
  const all = deps.store.read('Звіт_Щодня');
  const targets = all
    .filter(function (r) {
      return String(r.date) === date && r.report === report && (opts.force || String(r.status) !== 'sent');
    })
    .sort(function (a, b) {
      return Number(a.message_no) - Number(b.message_no);
    });
  if (!targets.length) {
    deps.log('INFO', 'Нічого надсилати за ' + date + ' (' + report + '): рядків немає або все вже sent');
    return { sent: 0, skipped: 'nothing' };
  }
  let sent = 0;
  const chat = deps.chatId(def.chatSecret);
  targets.forEach(function (row) {
    try {
      const res = deps.sendText(chat, String(row.text));
      row.status = 'sent';
      row.sent_at = dateTimeInTz(deps.now(), KYIV_TZ);
      row.tg_message_id = res.messageIds.join(',');
      row.error = '';
      sent++;
    } catch (e) {
      row.status = 'error';
      row.error = errText_(e);
      deps.log('ERROR', 'Telegram: ' + row.error);
      alertSafe_(deps, '🚨 Не вдалося надіслати звіт ' + report + ' за ' + date + ': ' + row.error);
    }
  });
  deps.store.write('Звіт_Щодня', all);
  return { sent: sent };
}

function runDailyReportWith(deps, opts) {
  try {
    return runDailyReportInner_(deps, opts);
  } catch (e) {
    deps.log('ERROR', 'runDailyReport: непередбачений збій: ' + errText_(e) + (e && e.stack ? ' | ' + redactSecrets_(String(e.stack)).slice(0, 300) : ''));
    alertSafe_(deps, '🚨 Збій щоденного запуску: ' + errText_(e));
    throw e;
  }
}

function runDailyReportInner_(deps, opts) {
  const date = yesterday_(deps);
  deps.log('INFO', 'Запуск звіту за ' + date + (opts.send ? '' : ' (dryRun, без відправки)'));
  const res = collectData(deps, addDays(date, -7), date);
  if (!res.metaOk) return { status: 'meta_failed', date: date };
  buildDailyReportWith(deps, date, { crmAvailable: res.crmOk });
  if (opts.send) sendReportFromSheetWith(deps, date, {});
  trimLog(deps.store, LOG_MAX_ROWS);
  return { status: 'ok', date: date, crmOk: res.crmOk };
}

function reclassifyOrdersWith(deps) {
  const orders = reclassifyRows(deps.store.read('KeyCRM_Orders'), deps.getRules(), deps.getSettings());
  deps.store.write('KeyCRM_Orders', orders);
  const dates = {};
  orders.forEach(function (o) {
    dates[o.date] = true;
  });
  rebuildCrmDaily_(deps.store, Object.keys(dates));
  deps.log('INFO', 'reclassifyOrders: перераховано ' + orders.length + ' замовл.');
  return orders.length;
}

function backfillWith(deps, days) {
  const n = Math.max(1, Number(days) || 30);
  const to = yesterday_(deps);
  const res = collectData(deps, addDays(to, -(n - 1)), to);
  deps.log('INFO', 'backfill(' + n + '): meta=' + res.metaOk + ', keycrm=' + res.crmOk);
  return res;
}

// ---- Точки входу з розділу 8 ----

function runDailyReport() {
  return runDailyReportWith(defaultDeps(), { send: true });
}

function dryRun() {
  return runDailyReportWith(defaultDeps(), { send: false });
}

function buildDailyReport(date) {
  const deps = defaultDeps();
  return buildDailyReportWith(deps, normDate_(date, deps), {});
}

function sendReportFromSheet(date) {
  const deps = defaultDeps();
  return sendReportFromSheetWith(deps, normDate_(date, deps), {});
}

function resendReport(date) {
  const deps = defaultDeps();
  return sendReportFromSheetWith(deps, normDate_(date, deps), { force: true });
}

// У редакторі Apps Script функції не можна запускати з аргументами — для ручного запуску:
function resendYesterdayReport() {
  return resendReport();
}

function backfill(days) {
  return backfillWith(defaultDeps(), days);
}

function backfill30() {
  return backfill(30);
}

function reclassifyOrders() {
  return reclassifyOrdersWith(defaultDeps());
}

function installTrigger() {
  const handlers = TRIGGERS.map(function (t) {
    return t.handler;
  });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  TRIGGERS.forEach(function (t) {
    ScriptApp.newTrigger(t.handler).timeBased().everyDays(1).atHour(t.hour).nearMinute(t.minute || 0).inTimezone(KYIV_TZ).create();
  });
  console.log('Тригери встановлено: ' + handlers.join(', ') + ' (щодня ~' + TRIGGERS[0].hour + ':00 Europe/Kyiv)');
}

// Створює всі листи, заголовки, формати, валідацію, значення за замовчуванням. Безпечно запускати повторно.
function setupSpreadsheet() {
  const ss = getSpreadsheet_();
  const created = [];
  Object.keys(SHEETS).forEach(function (name) {
    const spec = SHEETS[name];
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      created.push(name);
    }
    sh.getRange(1, 1, 1, spec.headers.length).setValues([spec.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    (spec.textCols || []).forEach(function (h) {
      sh.getRange(1, spec.headers.indexOf(h) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });

  const store = sheetStore();
  // Налаштування: додаємо лише відсутні ключі
  const have = {};
  store.readRaw('Налаштування').forEach(function (r) {
    have[String(r[0]).trim()] = true;
  });
  const sSheet = ss.getSheetByName('Налаштування');
  const missing = DEFAULT_SETTINGS.filter(function (r) {
    return !have[r[0]];
  });
  if (missing.length) {
    const start = Math.max(sSheet.getLastRow(), 1) + 1;
    sSheet.getRange(start, 1, missing.length, 3).setValues(missing);
  }
  sSheet.setColumnWidth(1, 240);
  sSheet.setColumnWidth(3, 520);
  const keys = sSheet.getRange(2, 1, Math.max(sSheet.getLastRow() - 1, 1), 1).getValues();
  keys.forEach(function (k, i) {
    const key = String(k[0]).trim();
    const cell = sSheet.getRange(i + 2, 2);
    if (key === 'report_send_enabled') cell.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    else if (/^(target_|freq_|trend_|color_|pixel_|utm_)/.test(key)) cell.setDataValidation(SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build());
  });

  // Правила_UTM: стартові правила, якщо лист порожній
  if (!store.read('Правила_UTM').length) store.write('Правила_UTM', DEFAULT_UTM_RULES);
  const rSheet = ss.getSheetByName('Правила_UTM');
  rSheet.getRange(2, 3, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid'], true).build());
  rSheet.getRange(2, 4, 500, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['in', 'contains', 'not_empty', 'regex'], true).build());
  rSheet.getRange(2, 5, 500, 1).setNumberFormat('@');

  ss.getSheetByName('Звіт_Щодня').getRange(2, 5, 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['ready', 'sent', 'error'], true).build());

  // прибрати порожній стандартний аркуш
  ['Sheet1', 'Аркуш1'].forEach(function (n) {
    const d = ss.getSheetByName(n);
    if (d && ss.getSheets().length > 1 && d.getLastRow() === 0) ss.deleteSheet(d);
  });
  console.log('Таблицю налаштовано. Створено листів: ' + (created.join(', ') || 'жодного (вже були)'));
}
