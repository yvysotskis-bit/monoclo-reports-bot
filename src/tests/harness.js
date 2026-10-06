// Мінімальний тест-харнес без залежностей. Працює і в Node (tests/run.js), і в Apps Script (runTests()).

function textDiff_(actual, expected) {
  const a = String(actual).split('\n');
  const e = String(expected).split('\n');
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      return 'рядок ' + (i + 1) + ':\n  очікувалось: ' + JSON.stringify(e[i]) + '\n  отримано:    ' + JSON.stringify(a[i]);
    }
  }
  return 'тексти збігаються за рядками, але відрізняються кінцевими символами';
}

function makeTester_(results) {
  const t = {
    test: function (name, fn) {
      try {
        fn(t);
        results.passed++;
      } catch (e) {
        results.failed++;
        results.failures.push(name + ' — ' + (e && e.message ? e.message : e));
        console.log('✗ ' + name + '\n    ' + (e && e.message ? e.message : e));
      }
    },
    eq: function (actual, expected, msg) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error((msg ? msg + ': ' : '') + 'очікувалось ' + JSON.stringify(expected) + ', отримано ' + JSON.stringify(actual));
      }
    },
    near: function (actual, expected, eps, msg) {
      if (typeof actual !== 'number' || Math.abs(actual - expected) > (eps == null ? 1e-9 : eps)) {
        throw new Error((msg ? msg + ': ' : '') + 'очікувалось ≈' + expected + ', отримано ' + actual);
      }
    },
    ok: function (cond, msg) {
      if (!cond) throw new Error(msg || 'умова хибна');
    },
    text: function (actual, expected, msg) {
      if (actual !== expected) throw new Error((msg ? msg + ': ' : '') + textDiff_(actual, expected));
    },
    throws: function (fn, msg) {
      let threw = false;
      try {
        fn();
      } catch (e) {
        threw = true;
      }
      if (!threw) throw new Error(msg || 'очікувалась помилка');
    }
  };
  return t;
}

function runTests() {
  const results = { passed: 0, failed: 0, failures: [] };
  const t = makeTester_(results);
  getTestSuites_().forEach(function (suite) {
    suite(t);
  });
  console.log(
    '\nТести: пройдено ' + results.passed + ', провалено ' + results.failed + (results.failed ? '\n- ' + results.failures.join('\n- ') : '')
  );
  if (typeof Logger !== 'undefined') Logger.log('Тести: пройдено ' + results.passed + ', провалено ' + results.failed);
  return results;
}
