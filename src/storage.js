// Сховище: схеми листів, чистий upsert і GAS-реалізація store (читання/запис листів).
// Новий лист (Частина Б: Товари, KeyCRM_OrderItems, ...) = новий запис у SHEETS.

const SHEETS = {
  'Налаштування': { headers: ['key', 'value', 'description'], keys: ['key'] },
  'Правила_UTM': { headers: ['priority', 'channel', 'field', 'operator', 'values', 'comment'], keys: [] },
  'Meta_Daily': {
    headers: ['date', 'spend', 'impressions', 'reach', 'link_clicks', 'view_content', 'add_to_cart', 'initiate_checkout', 'purchases', 'purchase_value', 'conversations_started', 'first_replies', 'direct_spend', 'updated_at'],
    keys: ['date'],
    textCols: ['date']
  },
  'KeyCRM_Orders': {
    headers: ['order_id', 'created_at_kyiv', 'date', 'source_id', 'source_group', 'status_id', 'status_name', 'is_counted', 'grand_total', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'utm_origin', 'channel', 'manager', 'updated_at'],
    keys: ['order_id'],
    textCols: ['order_id', 'created_at_kyiv', 'date', 'source_id', 'status_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid']
  },
  'CRM_Daily': {
    headers: ['date', 'source_group', 'channel', 'orders', 'value'],
    keys: ['date', 'source_group', 'channel'],
    textCols: ['date']
  },
  'Звіт_Щодня': {
    headers: ['date', 'report', 'message_no', 'text', 'status', 'sent_at', 'tg_message_id', 'error'],
    keys: ['date', 'report', 'message_no'],
    textCols: ['date', 'sent_at', 'tg_message_id']
  },
  'Лог': { headers: ['timestamp', 'level', 'message'], keys: [], textCols: ['timestamp'] },
  'Discover': { headers: ['section', 'a', 'b', 'c', 'd', 'e', 'f'], keys: [], textCols: ['a', 'b', 'c', 'd', 'e', 'f'] }
};

function rowKey_(row, keys) {
  return keys
    .map(function (k) {
      return String(row[k] == null ? '' : row[k]);
    })
    .join('|');
}

// Чистий upsert: існуючі рядки з тим самим ключем замінюються (на місці), нові додаються в кінець.
// Дублікати всередині incoming за ключем схлопуються (останній виграє).
function upsertRows(existing, incoming, keys) {
  const out = existing.slice();
  const index = {};
  out.forEach(function (r, i) {
    index[rowKey_(r, keys)] = i;
  });
  incoming.forEach(function (r) {
    const k = rowKey_(r, keys);
    if (k in index) {
      out[index[k]] = r;
    } else {
      index[k] = out.length;
      out.push(r);
    }
  });
  return out;
}

// Видаляє існуючі рядки з датами з dates і додає нові (для CRM_Daily: скасування прибирають старі трійки)
function replaceByDates(existing, incoming, dates) {
  const set = {};
  dates.forEach(function (d) {
    set[d] = true;
  });
  return existing
    .filter(function (r) {
      return !set[r.date];
    })
    .concat(incoming);
}

// Звіт_Щодня: рядки зі статусом sent не змінюються, крім force (resendReport)
function mergeReportRows(existing, incoming, force) {
  const keys = SHEETS['Звіт_Щодня'].keys;
  const sent = {};
  existing.forEach(function (r) {
    if (String(r.status) === 'sent') sent[rowKey_(r, keys)] = true;
  });
  const toWrite = incoming.filter(function (r) {
    return force || !sent[rowKey_(r, keys)];
  });
  return upsertRows(existing, toWrite, keys);
}

function upsertSheet(store, name, rows) {
  store.write(name, upsertRows(store.read(name), rows, SHEETS[name].keys));
}

// ---- GAS-реалізація store ----

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet_(name) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function cellOut_(v, header) {
  if (v instanceof Date) {
    const tz = getSpreadsheet_().getSpreadsheetTimeZone();
    return Utilities.formatDate(v, tz, header === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
  }
  return v;
}

function sheetStore() {
  return {
    // сирі значення листа без заголовка (для «Налаштування»)
    readRaw: function (name) {
      const sh = getOrCreateSheet_(name);
      const n = sh.getLastRow();
      if (n < 2) return [];
      return sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues();
    },
    read: function (name) {
      const headers = SHEETS[name].headers;
      const sh = getOrCreateSheet_(name);
      const n = sh.getLastRow();
      if (n < 2) return [];
      const vals = sh.getRange(2, 1, n - 1, headers.length).getValues();
      return vals
        .filter(function (row) {
          return row.some(function (c) {
            return c !== '';
          });
        })
        .map(function (row) {
          const o = {};
          headers.forEach(function (h, i) {
            o[h] = cellOut_(row[i], h);
          });
          return o;
        });
    },
    // повна заміна даних листа (рядки 2…)
    write: function (name, rows) {
      const headers = SHEETS[name].headers;
      const sh = getOrCreateSheet_(name);
      const last = sh.getLastRow();
      if (last > 1) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), headers.length)).clearContent();
      if (!rows.length) return;
      const need = rows.length + 1;
      if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
      const values = rows.map(function (r) {
        return headers.map(function (h) {
          return r[h] == null ? '' : r[h];
        });
      });
      sh.getRange(2, 1, values.length, headers.length).setValues(values);
    },
    append: function (name, rows) {
      if (!rows.length) return;
      const headers = SHEETS[name].headers;
      const sh = getOrCreateSheet_(name);
      const start = Math.max(sh.getLastRow(), 1) + 1;
      const need = start + rows.length - 1;
      if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
      const values = rows.map(function (r) {
        return headers.map(function (h) {
          return r[h] == null ? '' : r[h];
        });
      });
      sh.getRange(start, 1, values.length, headers.length).setValues(values);
    }
  };
}

// Лог (листу «Лог»): ніколи не пише секрети
function makeLogger(store, now) {
  return function (level, message) {
    store.append('Лог', [{ timestamp: dateTimeInTz(now(), KYIV_TZ), level: level, message: redactSecrets_(message) }]);
  };
}

// Обрізає Лог до останніх maxRows рядків
function trimLog(store, maxRows) {
  const rows = store.read('Лог');
  if (rows.length > maxRows) store.write('Лог', rows.slice(rows.length - maxRows));
}
