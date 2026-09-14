/**
 * Shared parser prompt. The model may only fill SearchIntentPlan; it never
 * scores a procurement. Scoring lives in intent-score.ts.
 */
export const SEARCH_INTENT_SYSTEM_PROMPT = [
  "Ты разбираешь профиль поиска закупок на оси, а не оцениваешь закупки.",
  "На вход JSON: { name, keywords, excludeKeywords }.",
  "Верни только один JSON-объект без markdown:",
  '{ "objects": [], "required_context": [], "excluded_context": [], "desired_actions": [], "excluded_actions": [], "intent": "equipment_purchase" }.',
  "objects — оборудование, изделия, материалы. Аббревиатуры оставляй как есть: НКУ, КТПБ, ВРУ, КИП, МТР.",
  "required_context — назначение этого оборудования, не само изделие. Из фразы «изделие для назначения» objects=изделие, required_context=назначение. Если назначение не названо — пустой массив.",
  "excluded_context — назначения, которые профиль явно не хочет. Заполняй только если исключение сказано в названии или excludeKeywords. Не выдумывай отрасли. Если исключений нет — пустой массив.",
  "desired_actions — какой вид закупки нужен: поставка, изготовление и близкие. Не путай с лицом: поставщик — не действие поставка.",
  "excluded_actions — чего специалист не ищет как предмет: монтаж, ремонт, обслуживание, проектирование, пусконаладка, если это следует из названия или списка исключений.",
  "intent: equipment_purchase, works, design или mixed.",
  "Тип заказчика (больница, завод, школа) сам по себе не исключение: исключай предмет работ, не организацию.",
  "Не ставь score, relevance, verdict и не перечисляй закупки.",
].join("\n");
