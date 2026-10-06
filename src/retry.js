// Загальні ретраї (розділ 9). Чиста функція: sleep передається ззовні, щоб тестувати без пауз.

// fn(attempt) викидає помилку -> classify(e) -> {retry, waitMs?}
// delays — паузи між спробами (за ТЗ 2 → 5 → 10 с); спроб усього delays.length + 1
function withRetry(fn, classify, opts) {
  const delays = opts.delays;
  let attempt = 0;
  for (;;) {
    try {
      return fn(attempt);
    } catch (e) {
      const c = classify(e);
      if (!c.retry || attempt >= delays.length) throw e;
      opts.sleep(c.waitMs != null ? c.waitMs : delays[attempt]);
      attempt++;
    }
  }
}
