# Monoclo — звіти таргетолога (Частина А)

Google Apps Script, прив'язаний до Google-таблиці. Щодня о ~09:00 (Europe/Kyiv):
**Meta Ads + KeyCRM → Google Sheets (сирі дані → розрахунок → готовий текст) → Telegram-бот → чат таргетолога.**
Таблиця — джерело правди: бот надсилає текст, прочитаний **з листа `Звіт_Щодня`**.

Реалізовано: ядро + щоденний звіт Meta, **Повідомлення 1 «Загальна картина»**. Частина Б (товарний звіт) не чіпалась, але закладена (див. «Розширення»).

## Статус звірки з документацією API — прочитайте першим

З середовища розробки документація Meta та KeyCRM була недоступна, тому **назви полів API не вигадувались і не вважаються звіреними**:

* Усе, що стосується KeyCRM (ендпоінти, фільтр дати, `include`, шляхи до UTM-полів, пагінація, ліміти), — **гіпотеза** в одному місці: константи `KEYCRM_*` у `src/keycrmApi.js` (позначені `VERIFY`).
* Meta: використано поля з ТЗ (`spend, impressions, reach, inline_link_clicks, actions, action_values`, `destination_type`) і стандартну пагінацію `paging.next`. Версія Graph API береться лише з `META_API_VERSION` (у коді дефолту немає — перевірте актуальну версію).
* Реальні дані покажуть `discoverActions()` і `discoverKeycrm()` → лист `Discover`. Після їх запуску поля в `keycrmApi.js` уточнюються (це робиться разом, до `backfill`).

Заповніть після `discoverKeycrm` (ТЗ, розд. 11):

| Що | Результат |
|---|---|
| Фактичні ендпоінти й поля KeyCRM | _заповнити_ |
| Частка замовлень з UTM: Сайт / QuickOrders / Instagram (за 30 днів) | _заповнити_ |
| Чи потрібен резерв Shopify (поріг 70% для `site`) | _заповнити_ |
| Чи передаються UTM у QuickOrders | _заповнити_ |
| Часова зона дат KeyCRM (`keycrm_naive_timestamp_tz`) | _заповнити_ |
| Розбіжності мапінгу подій Meta | _заповнити після `discoverActions`_ |

## Відхилення від ТЗ (знайдені під час реалізації)

Еталон 7.1 і тест «посимвольно» проходять, але **сам ТЗ місцями суперечить собі**. Рішення ухвалені так, щоб правила розділу 6 не змінювались:

1. **Округлення гривень.** ТЗ каже «< 100 — 1 знак», але еталон показує `53 грн` (53,125) і `24 грн`. Застосовано: < 10 — 1 знак (`6,6`, `5,1`), від 10 — ціле (`24`, `53`, `155`, `378`). Константа `UAH_DEC_BELOW` у `src/format.js`.
2. **Округлення відсотків.** ТЗ каже «1 знак», але еталон показує `34%` (34,375) і `85%` (84,78). Застосовано: від 20% — ціле, менше — 1 знак без `.0` (`12,5%`, `8,7%`, `11%`). CTR — завжди 2 знаки. Константа `PCT_INT_FROM`.
3. **D-1 CPC.** В еталоні `CPM 79`, `CTR 1,55%`, `CPC 5,3` одночасно неможливі: CPC = CPM ÷ (CTR × 10) ≈ 5,10. У тесті D-1 CPC = `5,1` — **єдина текстова відмінність** тестового еталона від ТЗ.
4. **Стрілка Spend і колір конверсії.** За дефолтних порогів (`trend_band_pct = 5`, `color_band_pct = 10`) еталонні числа дають `➖` (3 400 vs 3 250 = +4,6%) і `🔴` (8,7% vs 11%), а не `↗` і `🟡`. Тест еталона використовує `trend_band_pct = 4` і `color_band_pct = 12`; окремий тест фіксує поведінку на дефолтних порогах. Дефолти в листі `Налаштування` лишились за ТЗ — їх вирішує бізнес.
5. **Правила UTM, яких рушій ТЗ не вміє виразити напряму.** Додано рядки: `55` (`fbclid not_empty → meta_organic`, інакше «лише fbclid → meta_organic» не працює), `61` («klaviyo **або** medium=email» = два правила з різним priority), `70–74` («будь-яка непорожня UTM-мітка» = по правилу на кожне поле), `99` (`no_utm`; також це запасний результат рушія).
6. **`reclassifyOrders`** додатково перераховує `source_group` та `is_counted` за поточними налаштуваннями (ТЗ вимагає лише `channel` і `CRM_Daily`) — корисно, коли змінюєте ID джерел чи статусів.
7. **`source_group = other`** (невідоме джерело) класифікується за UTM так само, як `site`; у Повідомлення 1 такі замовлення не входять (лише `site`, `quickorders`, `instagram`).
8. **Кілька рекламних акаунтів Meta.** `META_AD_ACCOUNT_ID` приймає список через кому; дні, витрати, покупки, розмови й `direct_spend` складаються по датах (так CPA/ROAS за CRM порівнянні із загальними замовленнями). **Охоплення (reach) додається як є** — люди, що бачили рекламу з кількох акаунтів, враховуються двічі, тому «Частота акаунта» при кількох акаунтах трохи занижена. Якщо один з акаунтів недоступний, звіт не надсилається (часткова сума вводила б в оману), а в алерті вказано акаунт.
9. **День замовлення = `ordered_at`**, а не `created_at`. Саме так групують замовлення звіти KeyCRM (на реальних даних 05.10: Сайт 11 · 17 498,4 грн, Instagram 4 · 7 340 грн збіглися до копійки). Час створення запису лишається в `created_at_kyiv`. Запит до API розширено на добу в обидва боки за `created_at`, а точну межу доби робить фільтр за `ordered_at`; замовлення, заднім числом ввідні менеджером більш ніж на добу назад, у вікно дати не потрапляють.
10. **Валюта рекламних акаунтів.** Акаунти Mono Clo ведуться в USD, а KeyCRM — у гривнях. Тому `spend`, `purchase_value` і `direct_spend` **переводяться в UAH до запису в `Meta_Daily`** (там лежать уже гривні, а не «сирі» долари). Курс — офіційний НБУ на кожну дату (`meta_fx_mode = nbu`, дефолт); для вихідних береться найближчий попередній курс. Альтернатива — фіксований курс: `meta_fx_mode = fixed` і `meta_fx_fixed_rate`. Валюту кожного акаунта скрипт визначає сам (`discoverActions` показує її в листі `Discover`). Формат відповіді НБУ не звірено з документацією (`VERIFY` у `metaApi.js`). Якщо НБУ недоступний з Apps Script, а в `meta_fx_fixed_rate` заповнено курс, використовується він (у `Лог` — попередження). Діагностика: функція `checkFxRate` (лист `Discover`).
11. **`CRM_Daily`** оновлюється заміною всіх рядків за 8 днів (а не поштучним upsert), щоб скасування прибирали застарілі комбінації.

## Припущення (ТЗ 4.6)

Усі замовлення з джерела `Інстаграм | Monoclo` вважаються наслідком реклами Meta (`meta_direct`). Органічні звернення в Direct за даними CRM відокремити неможливо.

**Правило для менеджера:** замовлення з Direct створювати в KeyCRM **лише** з джерелом `Інстаграм | Monoclo`.

## UTM для реклами (ТЗ 4.8)

Без UTM канал `meta_ads` визначити неможливо.

**Meta Ads → рівень оголошення → URL parameters:**
```
utm_source={{site_source_name}}&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}
```
`utm_content={{ad.id}}` знадобиться в Повідомленні 2 (прив'язка замовлень до креативу).

**Google Ads → акаунт → Tracking template / Final URL suffix:**
```
utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_term={keyword}&utm_content={creative}
```
плюс увімкнене автотегування (`gclid`).

## Розгортання крок за кроком

> Токени й ключі **нікуди не вставляйте в код і не надсилайте в чат** — лише в Script Properties (крок 5).

### 1. clasp
```bash
npm install -g @google/clasp
clasp login                      # відкриє браузер; увійдіть у потрібний Google-акаунт
```
Увімкніть **Google Apps Script API**: https://script.google.com/home/usersettings → «Google Apps Script API» → Увімк.

### 2. Таблиця і проєкт
```bash
clasp create --type sheets --title "Monoclo Reports" --rootDir src
```
Команда створить таблицю з прив'язаним скриптом і файл `.clasp.json` (він у `.gitignore`). Якщо `.clasp.json` вийшов без `"rootDir": "src"` — додайте (див. `.clasp.json.example`). Потім:
```bash
clasp push
```
Таблицю відкриває `clasp open --addon` або через Drive.

### 3. Telegram
1. У Telegram → `@BotFather` → `/newbot` → отримайте токен (`TG_BOT_TOKEN`).
2. Створіть окремий чат (група) для таргетолога, додайте туди бота.
3. `TG_CHAT_ID`: напишіть щось у чат, відкрийте у браузері `https://api.telegram.org/bot<ТОКЕН>/getUpdates` і візьміть `chat.id` (для груп — від'ємне число, часто починається з `-100`). **Не публікуйте цей URL разом із токеном.**
4. `TG_ALERT_CHAT_ID` — чат для помилок (може збігатися з `TG_CHAT_ID`).

### 4. Ключі
* **Meta (System User token):** business.facebook.com → Налаштування бізнесу → Користувачі → **Системні користувачі** → створіть (роль Admin або Employee) → «Додати активи» → рекламний акаунт (доступ до перегляду/керування) → **Згенерувати токен**, права `ads_read`, термін «Never» (за наявності). `META_AD_ACCOUNT_ID` — `act_XXXXXXXX` (Ads Manager → ID акаунта). `META_API_VERSION` — актуальна версія Graph API (https://developers.facebook.com/docs/graph-api/changelog), напр. `v24.0`.
* **KeyCRM:** Налаштування → Інтеграції → API → скопіюйте ключ (потрібні права адміністратора). `KEYCRM_API_BASE` — базова адреса Open API (за ТЗ напр. `https://openapi.keycrm.app/v1` — звірте з документацією).

### 5. Script Properties (самостійно)
Apps Script → ⚙ **Налаштування проєкту** → **Властивості скрипта** → «Додати властивість»:

| Ключ | Значення |
|---|---|
| `META_ACCESS_TOKEN` | токен System User |
| `META_AD_ACCOUNT_ID` | `act_…`; **кілька акаунтів — через кому:** `act_111, act_222, act_333, act_444` (звіт рахується за сумою) |
| `META_API_VERSION` | напр. `v24.0` |
| `TG_BOT_TOKEN` | токен бота |
| `TG_CHAT_ID` | ID чату таргетолога |
| `TG_ALERT_CHAT_ID` | ID чату для алертів |
| `KEYCRM_API_KEY` | ключ KeyCRM |
| `KEYCRM_API_BASE` | базова адреса Open API |

**Shopify (резервне джерело UTM, розділ 4.7):** `SHOPIFY_STORE_DOMAIN` (`xxx.myshopify.com`), `SHOPIFY_API_VERSION` (напр. `2026-07`) і одне з двох: `SHOPIFY_ADMIN_TOKEN` (старий постійний токен) або `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` (застосунок Dev Dashboard з правом `read_orders`; токен на 24 год скрипт отримує й кешує сам). Порядок: `checkShopify` → перевірити лист `Discover` → у `Налаштуваннях` поставити `shopify_utm_fallback = TRUE` → `reclassifyOrders` не потрібен, мітки підтягнуться при наступному завантаженні (`backfill30`). Права `read_orders` дають лише 60 днів історії замовлень.
Для Частини Б згодом: `TG_PRODUCTS_CHAT_ID`.

### 6. Перший запуск (порядок з ТЗ)
У редакторі Apps Script оберіть функцію зі списку й натисніть «Запустити» (перший раз потрібно дати дозволи):

1. `setupSpreadsheet` — створить усі листи, заголовки, формати, валідацію, налаштування за замовчуванням і стартові `Правила_UTM`.
2. `discoverActions` — реальні `action_type` акаунта, Direct-кампанії → лист `Discover` і `Лог`. Звірте мапінг (4.2).
3. `discoverKeycrm` — джерела, статуси, структура замовлення, частка UTM, таблиця `utm_source × utm_medium` → `Discover`. **Не надсилайте в чат нічого, крім ID/назв джерел і статусів та структури полів.** За результатом уточнюються `KEYCRM_*` у коді.
4. Заповніть `Налаштування`: `keycrm_source_site_ids`, `keycrm_source_quickorders_ids`, `keycrm_source_instagram_ids`, `keycrm_excluded_status_ids` (усі статуси групи «Скасовано»), цілі (CPA, ROAS …).
5. `backfill30` (= `backfill(30)`) — історія Meta і KeyCRM за 30 днів. Якщо потім змінили `Правила_UTM` чи ID джерел — `reclassifyOrders`.
6. `dryRun` — збирає дані й формує текст у `Звіт_Щодня` **без відправки**. Перегляньте текст у таблиці.
7. `resendYesterdayReport` — тестова відправка (форсована). Потім `installTrigger` — тригер щодня о ~09:00 Europe/Kyiv (Apps Script запускає в межах години).

Інші функції: `runDailyReport`, `buildDailyReport`, `sendReportFromSheet`, `resendReport(date)` (з аргументом викликається з коду; з редактора — `resendYesterdayReport`), `runTests`.

## Як це працює

* Щоденний запуск тягне Meta за 8 днів і KeyCRM за 8 днів (Meta/CRM доуточнюються), робить upsert у `Meta_Daily`, `KeyCRM_Orders`, перераховує `CRM_Daily`, формує текст у `Звіт_Щодня` (`ready`) і надсилає (`sent`). Повторний запуск того ж дня не дублює надсилання.
* Помилки: Meta недоступна → звіт не надсилається, алерт; токен недійсний (190) → окремий алерт; KeyCRM недоступний → звіт іде з `дані KeyCRM недоступні` + алерт; нове невідоме джерело → попередження в `Лог` і алерт не частіше разу на добу; `spend = 0` → коротке повідомлення.
* Direct-кампанії визначаються автоматично за `destination_type` адсетів (4.4); список — у `Лог`. Кампанії, адсети яких уже архівовані й не повертаються API, задайте вручну в `direct_campaign_ids`.
* Секрети читаються лише з Script Properties і вирізаються з логів/алертів. Токен Meta передається заголовком `Authorization`, не в URL.

## Тести

```bash
npm test          # Node ≥ 18, без залежностей
```
У Apps Script — функція `runTests()`. Покрито: формули розділу 5, форматування 7.2, **еталон 7.1 посимвольно**, ділення на нуль, класифікація UTM (кожне правило), мапінг подій Meta, KeyCRM (скасовані, 23:50 за Києвом, нуль Direct, недоступність), upsert без дублів, `reclassifyOrders` без запитів до API, розбиття Telegram, ретраї, наскрізні сценарії.

## Структура

```
src/                  # clasp rootDir (дані в GAS — плоский глобальний простір, без import/export)
  config.js           # Script Properties, «Налаштування», секрети, redact
  dates.js            # доба за Києвом, парсинг часу API (чисте)
  format.js           # числа й дати (чисте)
  actions.js          # мапінг Meta action_type (чисте)
  attribution.js      # UTM-класифікація, source_group, CRM_Daily (чисте)
  metrics.js          # розрахунок метрик (чисте)
  rules.js            # світлофор і стрілки (чисте)
  retry.js            # ретраї (чисте)
  telegram.js         # HTML, розбиття 4096 (чисте) + відправка
  storage.js          # схеми листів, upsert (чисте) + SheetStore
  metaApi.js          # Meta Insights, пагінація, ретраї
  keycrmApi.js        # KeyCRM (VERIFY-гіпотези), нормалізація замовлення
  discover.js         # discoverActions / discoverKeycrm
  reports/            # metaMsg1.js, registry.js
  main.js             # точки входу й оркестрація (через deps)
  tests/              # harness + тести (виконуються і в Node, і в Apps Script)
tests/run.js          # Node-раннер
```

## Розширення (Частина Б і повідомлення 2–6)

* **Новий звіт/повідомлення:** файл у `src/reports/` + запис у `getReportRegistry()` (`src/reports/registry.js`); `chatSecret` задає чат (напр. `TG_PRODUCTS_CHAT_ID`). Ядро не змінюється; `Звіт_Щодня.report` — довільний рядок.
* **Нові листи** (`Товари`, `KeyCRM_OrderItems`, `GAds_Products_Daily`, …) — запис у `SHEETS` (`src/storage.js`); `upsertSheet`/`replaceByDates` уже універсальні.
* **Meta на рівні оголошення / розбивки:** `fetchInsights({level, fields, breakdowns})` у `metaApi.js`.
* **Розклад:** масив `TRIGGERS` у `main.js` (`installTrigger` створює все зі списку).
* **UTM із Shopify:** `normalizeOrder` приймає `ctx.utmFallback(raw)` (ставить `utm_origin = shopify`); модуль `shopifyApi.js` додається, якщо `discoverKeycrm` покаже частку UTM < 70% для `site`.
* **Позиції замовлень** (для товарного звіту) — потрібен `include=products` у `keycrm_order_include` після звірки з документацією KeyCRM.
