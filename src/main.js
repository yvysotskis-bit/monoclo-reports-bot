// Точки входу (розділ 8) і оркестрація. Уся логіка працює через об'єкт deps (залежності),
// тому сценарії "KeyCRM недоступний", "Meta недоступна", захист від дублів тестуються без GAS.

// Розклад. Частина Б додасть сюди тижневий (пн 09:30) і місячний (1-ше число 09:30) звіти.
// runDailyReportRetry о 11:00 і 14:00 нічого не робить, якщо звіт за вчора вже надіслано, а якщо ранковий запуск
// не вдався (Meta/Telegram тимчасово недоступні) — пробує ще раз, тож день не пропадає мовчки.
const TRIGGERS = [
  { handler: 'runDailyReport', hour: 9, minute: 0 },
  { handler: 'runDailyReportRetry', hour: 11, minute: 0 },
  { handler: 'runDailyReportRetry', hour: 14, minute: 0 }
];

const LOCK_WAIT_MS = 90000;
// Якщо KeyCRM недоступний, а Meta працює, ранковий звіт не надсилається без блоку CRM одразу: повторні запуски
// (11:00, 14:00) ще можуть його отримати. З цієї години (Київ) звіт надсилається в будь-якому разі (ТЗ, розділ 9).
const CRM_WAIT_UNTIL_HOUR = 14;

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

// Короткий хеш тексту (djb2) для журналу відправлених алертів
function hashText_(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Той самий алерт не повторюється протягом доби (інакше тригери 9:00/11:00/14:00 і ручні запуски засипали б чат).
// Пам'ятаємо ВСІ алерти доби, а не лише останній: інакше два різні алерти, що повторюються щодня, чергувались би.
function alertSafe_(deps, text) {
  try {
    const today = dateInTz(deps.now(), KYIV_TZ);
    const h = hashText_(String(text).slice(0, 300));
    let seen = { d: today, h: [] };
    try {
      const raw = JSON.parse(deps.state.get('alerts_sent') || 'null');
      if (raw && raw.d === today && Array.isArray(raw.h)) seen = raw;
    } catch (e) {
      // пошкоджений запис — починаємо день заново
    }
    if (seen.h.indexOf(h) !== -1) {
      deps.log('INFO', 'Алерт не повторено (сьогодні вже надсилався): ' + String(text).slice(0, 100));
      return;
    }
    deps.alert(text);
    seen.h.push(h);
    deps.state.set('alerts_sent', JSON.stringify({ d: today, h: seen.h.slice(-30) }));
  } catch (e) {
    deps.log('ERROR', 'Не вдалося надіслати алерт: ' + errText_(e));
  }
}

function rebuildCrmDaily_(store, dates) {
  const rows = buildCrmDaily(store.read('KeyCRM_Orders'), dates);
  store.write('CRM_Daily', replaceByDates(store.read('CRM_Daily'), rows, dates));
}

// Рядки KeyCRM_Orders, створені у вікні [from, to] (за Києвом), яких API не повернув взагалі (keepIds — ВСІ id з відповіді):
// замовлення видалили. Без прибирання вони лишались би в CRM_Daily назавжди.
// УВАГА: порівнювати треба з усіма id відповіді, а не лише з замовленнями, чия дата (ordered_at) у вікні:
// ordered_at може бути на тижні раніше за created_at, такі замовлення існують і видаляти їх не можна.
// Повертає {order_id: true}.
function staleOrderIds(existingRows, keepIds, from, to) {
  const keep = {};
  keepIds.forEach(function (id) {
    keep[String(id)] = true;
  });
  const stale = {};
  existingRows.forEach(function (r) {
    const created = String(r.created_at_kyiv || '').slice(0, 10);
    if (created >= from && created <= to && !keep[String(r.order_id)]) stale[String(r.order_id)] = true;
  });
  return stale;
}

// Meta повертає старий псевдонім зони — Europe/Kiev (перевірено на реальних акаунтах); це та сама зона, що й Europe/Kyiv
function isKyivZone_(tz) {
  return ['Europe/Kyiv', 'Europe/Kiev'].indexOf(String(tz)) !== -1;
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
    deps.log('INFO', 'Meta: оновлено ' + m.days.length + ' дн. (' + from + '…' + to + '). Валюти акаунтів: ' + JSON.stringify(m.currencies || {}) + '. Часові зони акаунтів: ' + JSON.stringify(m.timezones || {}) + ' (порожньо = не вдалося визначити). Direct-кампанії з витратами: ' + (m.directCampaigns.join(', ') || 'немає'));
    if (m.fxFallback) deps.log('WARN', 'Курс НБУ недоступний — використано фіксований курс з налаштувань (meta_fx_fixed_rate)');
    Object.keys(m.timezones || {}).forEach(function (id) {
      const tz = m.timezones[id];
      if (tz && !isKyivZone_(tz)) deps.log('WARN', 'Рекламний акаунт ' + id + ' працює в часовій зоні ' + tz + ', а звіт — за ' + KYIV_TZ + ': межі доби в Meta і KeyCRM можуть не збігатися');
    });
    res.metaOk = true;
  } catch (e) {
    deps.log('ERROR', 'Meta: ' + errText_(e));
    alertSafe_(deps, metaAlertText_(e));
  }

  t0 = deps.now().getTime();
  deps.log('INFO', 'KeyCRM: завантаження замовлень…');
  try {
    findInvalidRules(rules).forEach(function (w) {
      deps.log('WARN', 'Правила_UTM: ' + w + ' — правило ігнорується');
    });
    findDuplicateSettings(deps.store.readRaw('Налаштування')).forEach(function (w) {
      deps.log('WARN', 'Налаштування: ключ повторюється з різними значеннями (діє останнє) — ' + w);
    });
    const existingRows = deps.store.read('KeyCRM_Orders');
    const existing = {};
    existingRows.forEach(function (r) {
      existing[String(r.order_id)] = r;
    });
    const orders = deps.fetchOrders(from, to, settings, rules, existing);
    if (orders.shopifyError) {
      deps.log('WARN', 'Shopify (резерв UTM) недоступний: ' + orders.shopifyError);
      alertSafe_(deps, '⚠️ Резерв UTM із Shopify недоступний: ' + orders.shopifyError);
    }
    if (orders.cancelStatusWarnings && orders.cancelStatusWarnings.length) {
      const m = 'Статуси скасування/повернення KeyCRM не виключені з підрахунку: ' + orders.cancelStatusWarnings.join('; ') + '. Додайте їх ID у «Налаштування» → keycrm_excluded_status_ids, інакше такі замовлення рахуються продажами.';
      deps.log('WARN', m);
      alertSafe_(deps, '⚠️ ' + m);
    }
    if (orders.skipped && orders.skipped.length) {
      deps.log('WARN', 'KeyCRM: пропущено ' + orders.skipped.length + ' замовл. через помилку даних: ' + orders.skipped.slice(0, 3).join(' | '));
    }
    let merged = upsertRows(
      existingRows,
      orders.map(function (o) {
        return Object.assign({}, o, { updated_at: stamp });
      }),
      SHEETS['KeyCRM_Orders'].keys
    );
    const fetchedIds = orders.rawIds || orders.map(function (o) {
      return o.order_id;
    });
    const stale = staleOrderIds(existingRows, fetchedIds, from, to);
    const staleCount = Object.keys(stale).length;
    const inWindow = existingRows.filter(function (r) {
      const c = String(r.created_at_kyiv || '').slice(0, 10);
      return c >= from && c <= to;
    }).length;
    if (staleCount) {
      if (!fetchedIds.length || (staleCount > 5 && staleCount > inWindow * 0.3)) {
        deps.log('WARN', 'KeyCRM: ' + staleCount + ' із ' + inWindow + ' замовлень вікна відсутні у відповіді API — вважаю відповідь підозрілою і нічого не прибираю');
      } else {
        merged = merged.filter(function (r) {
          return !stale[String(r.order_id)];
        });
        deps.log('WARN', 'KeyCRM: прибрано ' + staleCount + ' замовл., яких більше немає у вікні ' + from + '…' + to + ' (видалені або змінена дата): ' + Object.keys(stale).slice(0, 10).join(', '));
      }
    }
    deps.store.write('KeyCRM_Orders', merged);
    rebuildCrmDaily_(deps.store, dateRange(from, to));
    deps.log('INFO', 'KeyCRM (разом із Shopify та записом у таблицю): етап тривав ' + sec(t0));
    deps.log('INFO', 'KeyCRM: оновлено ' + orders.length + ' замовл. (' + from + '…' + to + ')');
    warnUnknownSources_(deps, orders);
    res.crmOk = true;
  } catch (e) {
    deps.log('ERROR', 'KeyCRM: ' + errText_(e));
    alertSafe_(deps, '🚨 KeyCRM недоступний: ' + errText_(e) + '. Звіт чекає на відновлення (повтор о 11:00); о 14:00 піде в будь-якому разі — без блоку CRM.');
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
    // Довгий звіт іде кількома повідомленнями: якщо збій стався посередині, при повторі вже доставлені частини
    // (їхні id лишились у tg_message_id рядка зі статусом error) не надсилаються вдруге.
    const prior = !opts.force && String(row.status) === 'error' && String(row.tg_message_id || '') ? String(row.tg_message_id).split(',') : [];
    try {
      const res = deps.sendText(chat, String(row.text), prior.length);
      row.status = 'sent';
      row.sent_at = dateTimeInTz(deps.now(), KYIV_TZ);
      row.tg_message_id = prior.concat(res.messageIds).join(',');
      row.error = '';
      sent++;
    } catch (e) {
      row.status = 'error';
      row.tg_message_id = prior.concat((e && e.sentIds) || []).join(',');
      row.error = errText_(e);
      deps.log('ERROR', 'Telegram: ' + row.error);
      alertSafe_(deps, '🚨 Не вдалося надіслати звіт ' + report + ' за ' + date + ': ' + row.error);
    }
    // Статус записується одразу після кожного повідомлення: якщо запуск обірветься, "sent" уже збережено і дубля не буде
    deps.store.write('Звіт_Щодня', all);
  });
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
  trimLog(deps.store, LOG_MAX_ROWS);
  const hour = Number(dateTimeInTz(deps.now(), KYIV_TZ).slice(11, 13));
  if (opts.send && !res.crmOk && hour < CRM_WAIT_UNTIL_HOUR) {
    deps.log('WARN', 'KeyCRM недоступний: звіт за ' + date + ' збережено в листі, але не надіслано — чекаю на відновлення (повторні запуски; з ' + CRM_WAIT_UNTIL_HOUR + ':00 піде без блоку CRM)');
    return { status: 'crm_wait', date: date, crmOk: false };
  }
  if (opts.send) sendReportFromSheetWith(deps, date, {});
  return { status: 'ok', date: date, crmOk: res.crmOk };
}

// Повторний запуск (11:00, 14:00): якщо звіт за вчора вже надіслано — нічого не робить і не звертається до API
function runDailyReportRetryWith(deps) {
  const date = yesterday_(deps);
  const done = deps.store.read('Звіт_Щодня').some(function (r) {
    return r.date === date && r.report === 'meta' && String(r.status) === 'sent';
  });
  if (done) return { status: 'already_sent', date: date };
  deps.log('INFO', 'Повторна спроба: звіт за ' + date + ' ще не надіслано');
  return runDailyReportWith(deps, { send: true });
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

// Усі точки входу, що пишуть у таблицю або надсилають у Telegram, виконуються під спільним замком скрипта:
// ручний запуск, що збігся з тригером (або два тригери), інакше читали б і перезаписували листи одночасно
// (втрата рядків) та могли б обидва надіслати звіт (дубль). Хто не отримав замок за LOCK_WAIT_MS — пропускає запуск.
function lockedRun_(label, fn) {
  const deps = defaultDeps();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    try {
      deps.log('WARN', label + ': пропущено — інший запуск ще виконується');
    } catch (e) {
      console.log(label + ': пропущено — інший запуск ще виконується');
    }
    return { status: 'locked' };
  }
  try {
    RUN_START_MS = Date.now(); // бюджет часу рахується від початку роботи, а не від очікування замка
    return fn(deps);
  } finally {
    lock.releaseLock();
  }
}

function runDailyReport() {
  return lockedRun_('runDailyReport', function (deps) {
    return runDailyReportWith(deps, { send: true });
  });
}

function runDailyReportRetry() {
  return lockedRun_('runDailyReportRetry', runDailyReportRetryWith);
}

function dryRun() {
  return lockedRun_('dryRun', function (deps) {
    return runDailyReportWith(deps, { send: false });
  });
}

function buildDailyReport(date) {
  return lockedRun_('buildDailyReport', function (deps) {
    return buildDailyReportWith(deps, normDate_(date, deps), {});
  });
}

function sendReportFromSheet(date) {
  return lockedRun_('sendReportFromSheet', function (deps) {
    return sendReportFromSheetWith(deps, normDate_(date, deps), {});
  });
}

function resendReport(date) {
  return lockedRun_('resendReport', function (deps) {
    return sendReportFromSheetWith(deps, normDate_(date, deps), { force: true });
  });
}

// У редакторі Apps Script функції не можна запускати з аргументами — для ручного запуску:
function resendYesterdayReport() {
  return resendReport();
}

// Після виправлення формул: перебудувати тексти звітів за останні n днів у листі (без відправки в Telegram).
// Спершу потрібен backfill30 — він оновлює Meta_Daily. Уже відправлені рядки лишаються зі статусом sent.
function rebuildReportsWith(deps, n) {
  const last = yesterday_(deps);
  for (let i = n - 1; i >= 0; i--) buildDailyReportWith(deps, addDays(last, -i), { force: true });
}

function rebuildLast7Reports() {
  return lockedRun_('rebuildLast7Reports', function (deps) {
    return rebuildReportsWith(deps, 7);
  });
}

// Надіслати в Telegram виправлені звіти за останні 3 дні (позначки «sent» ігноруються).
function resendLast3Reports() {
  return lockedRun_('resendLast3Reports', function (deps) {
    const last = yesterday_(deps);
    for (let i = 2; i >= 0; i--) sendReportFromSheetWith(deps, addDays(last, -i), { force: true });
  });
}

function backfill(days) {
  return lockedRun_('backfill', function (deps) {
    return backfillWith(deps, days);
  });
}

function backfill30() {
  return backfill(30);
}

// Глибше завантаження: замовлення з ordered_at на тиждень-два раніше за створення потрапляють лише у великі вікна
function backfill60() {
  return backfill(60);
}

function reclassifyOrders() {
  return lockedRun_('reclassifyOrders', reclassifyOrdersWith);
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
  console.log('Тригери встановлено: ' + TRIGGERS.map(function (t) { return t.handler + ' ~' + t.hour + ':' + pad2_(t.minute || 0); }).join(', ') + ' (Europe/Kyiv)');
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
