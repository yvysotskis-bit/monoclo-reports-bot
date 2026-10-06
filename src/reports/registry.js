// Реєстр звітів. Нове повідомлення Meta (2–6), звіт Google чи товарний звіт додаються
// записом сюди + окремим файлом у reports/ — ядро (main/storage/telegram) не змінюється.
//
// build(ctx) -> [{message_no, text}], ctx = {date, settings, metaRows, crmRows, crmAvailable}
// chatSecret — ім'я Script Property з ID чату для цього звіту.

function getReportRegistry() {
  return {
    meta: { id: 'meta', chatSecret: 'TG_CHAT_ID', build: buildMetaReport }
    // Частина Б: products_week / products_month -> chatSecret 'TG_PRODUCTS_CHAT_ID'
    // Далі: google, meta-повідомлення 2–6
  };
}
