// Telegram: екранування HTML, <pre>, розбиття довгих повідомлень (розділ 7.4) + відправка.

const TG_LIMIT = 4096;
const PRE_OVERHEAD = '<pre></pre>'.length;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrapPre(s) {
  return '<pre>' + escapeHtml(s) + '</pre>';
}

function htmlLen_(s) {
  return escapeHtml(s).length + PRE_OVERHEAD;
}

function hardSplit_(s, limit) {
  const out = [];
  let rest = s;
  while (rest.length) {
    let n = Math.min(rest.length, limit);
    while (n > 1 && htmlLen_(rest.slice(0, n)) > limit) n--;
    out.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  return out;
}

// Розбиває текст на частини так, щоб кожна в обгортці <pre> вкладалась у limit.
// Спершу по порожніх рядках між блоками, потім по рядках, потім по символах.
function splitMessage(text, limit) {
  limit = limit || TG_LIMIT;
  const out = [];
  let cur = '';
  function flush() {
    if (cur) out.push(cur);
    cur = '';
  }
  function pushUnit(unit, sep) {
    const cand = cur ? cur + sep + unit : unit;
    if (htmlLen_(cand) <= limit) {
      cur = cand;
      return true;
    }
    return false;
  }
  text.split(/\n{2,}/).forEach(function (block) {
    if (pushUnit(block, '\n\n')) return;
    flush();
    if (htmlLen_(block) <= limit) {
      cur = block;
      return;
    }
    block.split('\n').forEach(function (line) {
      if (pushUnit(line, '\n')) return;
      flush();
      if (htmlLen_(line) <= limit) {
        cur = line;
        return;
      }
      hardSplit_(line, limit).forEach(function (piece) {
        flush();
        cur = piece;
      });
    });
  });
  flush();
  return out;
}

// Готові HTML-повідомлення для sendMessage
function buildTelegramMessages(text, limit) {
  return splitMessage(text, limit).map(wrapPre);
}

// ---- I/O ----

function tgCall_(token, method, payload) {
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  let body = null;
  try {
    body = JSON.parse(resp.getContentText());
  } catch (e) {
    body = null;
  }
  const code = resp.getResponseCode();
  if (code !== 200 || !body || !body.ok) {
    const err = new Error('Telegram ' + method + ': HTTP ' + code + ' ' + (body && body.description ? body.description : ''));
    err.http = code;
    err.retryAfter = body && body.parameters ? body.parameters.retry_after : null;
    throw err;
  }
  return body.result;
}

function classifyTelegramError(e) {
  if (e.http === 429) return { retry: true, waitMs: (e.retryAfter || 2) * 1000 };
  if (e.http >= 500 || e.http == null) return { retry: true };
  return { retry: false };
}

// Надсилає текст у чат; повертає {messageIds: [..]}
function sendTelegramText(chatId, text) {
  const token = requireSecret('TG_BOT_TOKEN');
  const ids = [];
  buildTelegramMessages(text).forEach(function (html) {
    const res = withRetry(
      function () {
        return tgCall_(token, 'sendMessage', {
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
      },
      classifyTelegramError,
      { delays: [2000, 5000, 10000], sleep: function (ms) { Utilities.sleep(ms); } }
    );
    ids.push(res.message_id);
  });
  return { messageIds: ids };
}

// Звичайний текст без <pre> (алерти)
function sendTelegramPlain(chatId, text) {
  const token = requireSecret('TG_BOT_TOKEN');
  tgCall_(token, 'sendMessage', { chat_id: chatId, text: text, disable_web_page_preview: true });
}
