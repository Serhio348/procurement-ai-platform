import type { SearchEvalCase, SearchEvalProfile, SearchEvalReport, SearchEvalRow } from "./evaluate.js";
import { termOccurs } from "./query-terms.js";

/** Working copy of the specialist profile this set is labelled against. */
export const NKU_PUMP_PROFILE: SearchEvalProfile = {
  name: "НКУ для управления насосами",
  keywords: ["НКУ", "шкаф управления"],
  excludeKeywords: [],
};

/**
 * Synthetic titles that pin the category mix the live listing did not return
 * (монтаж / ремонт / ПНР / mention-only). Gold is a human judgement.
 */
export const NKU_PUMP_SEED_CASES: readonly SearchEvalCase[] = [
  {
    id: "nku-supply",
    title: "Поставка НКУ",
    gold: "uncertain",
  },
  {
    id: "nku-for-pumps",
    title: "Поставка НКУ для насосов",
    gold: "relevant",
  },
  {
    id: "nku-cabinet",
    title: "Изготовление шкафа управления насосами",
    gold: "relevant",
  },
  {
    id: "nku-pump-cabinet",
    title: "Шкаф управления насосами",
    gold: "relevant",
  },
  {
    id: "nku-install",
    title: "Монтаж НКУ",
    gold: "irrelevant",
  },
  {
    id: "nku-repair",
    title: "Ремонт НКУ",
    gold: "irrelevant",
  },
  {
    id: "nku-commission",
    title: "Пусконаладка НКУ",
    gold: "irrelevant",
  },
  {
    id: "nku-supply-with-install",
    title: "Поставка НКУ с последующим монтажом силами заказчика",
    gold: "uncertain",
  },
  {
    id: "nku-mention-only",
    title: "Реконструкция насосной станции",
    extraText: "в комплекте упомянуто НКУ",
    gold: "irrelevant",
  },
  {
    id: "nku-contest-substring",
    title: "Открытый конкурс по закупке аудиторских услуг",
    gold: "irrelevant",
  },
  {
    id: "nku-incubator-substring",
    title: "СО2-инкубатор (термостат электронный)",
    gold: "irrelevant",
  },
  {
    id: "nku-yankauer-substring",
    title: "Набор аспирационный хирургический тип Янкувер",
    gold: "irrelevant",
  },
  {
    id: "nku-street-lighting",
    title: "Закупка шкаф управления наружным освещением",
    gold: "irrelevant",
  },
  {
    id: "nku-boiler-cabinet",
    title: "Шкаф управления котельной",
    gold: "irrelevant",
  },
  {
    id: "nku-supplier-person",
    title: "Выбор поставщика шкафа управления котельной",
    gold: "irrelevant",
  },
  {
    id: "nku-supplier-pumps",
    title: "Выбор поставщика НКУ для насосов",
    gold: "relevant",
  },
  {
    id: "nku-no-purpose",
    title: "Поставка НКУ 0,4 кВ",
    gold: "uncertain",
  },
  // Lot-level cases: the platform returns rows whose title alone does not
  // settle the case, so the card stage must read lots (R07/R08/R61).
  {
    id: "nku-lot-supply",
    title: "Поставка оборудования для насосной станции",
    extraText: "в составе НКУ",
    gold: "relevant",
    lots: [{ title: "НКУ 0,4 кВ для управления насосами" }],
  },
  {
    id: "nku-lot-second",
    title: "Поставка оборудования для насосной станции",
    extraText: "в составе НКУ",
    gold: "relevant",
    lots: [
      { title: "Кабельная продукция" },
      { title: "Шкаф управления насосами" },
    ],
  },
  {
    id: "nku-lot-work",
    title: "Выполнение работ на насосной станции",
    extraText: "демонтаж и монтаж НКУ",
    gold: "irrelevant",
    lots: [{ title: "Монтаж НКУ 0,4 кВ" }],
  },
  {
    id: "nku-including-works",
    title: "Монтаж системы управления насосами, включая поставку НКУ",
    gold: "irrelevant",
  },
];

/**
 * Live goszakupki.by listing dump for the same profile (2026-09-14, VPS
 * `zakupki`, adapter search, not aggregators). Platform queries: НКУ, шкаф
 * управления, plus coverage terms. «НКУ» on the site is a substring, so most
 * rows are «конкурс» / «инкубатор» / «Янкувер». Labels are against pump-control
 * NCU supply, not generic electrical work. Scoring was not fitted to this set.
 */
export const NKU_PUMP_LIVE_CASES: readonly SearchEvalCase[] = [
  live("etrade/3669088", "irrelevant", {
    title:
      "Конкурс по выбору исполнителя на оказание услуг по разработке рекомендаций по ремонту мостового полотна, деформационных швов и ремонту (усилению) элементов опор и пролетных строений путепровода через ул. Шафарнянская по пр. Независимости в составе объекта «Текущий ремонт мостов и путепроводов, подземных пешеходных переходов и иных объектов внешнего благоустройства г. Минска, находящихся в хозяйственном ведении государственного предприятия «Горавтомост»",
    buyerName: 'Коммунальное дочернее унитарное предприятие "Горавтомост"',
    sourceStatus: "Подача предложений",
  }),
  live("single-source/3667607", "irrelevant", {
    title:
      "Оплата изделий ручной работы (сувениров) из керамики в качестве призов для участников городского конкурса «З бульбай, смачна!» в рамках организации и проведения мероприятий, посвященных Дню народного единства",
    buyerName: 'Учреждение культуры "Могилевский городской Центр культуры и досуга"',
  }),
  live("marketing/3667112", "irrelevant", {
    title:
      "Приобретение товаров, работ/услуг для проведения Межрегионального фестиваля – конкурса народного творчества Кричевский конек",
    buyerName:
      "Государственное учреждение «Центр по обеспечению деятельности бюджетных организаций Кричевского района»",
  }),
  live("marketing/3666811", "irrelevant", {
    title:
      "Услуги по техническому обслуживанию инкубаторов для новорожденных с заменой расходных материалов и запасных частей.",
    buyerName: 'Учреждение здравоохранения "Брестская детская областная больница"',
  }),
  live("single-source/3666637", "irrelevant", {
    title:
      "Товары для проведения открытого кубка Кубка Кобринского района по туристско-прикладному многоборью в технике пешеходного туризма памяти С.Ф. Шитикова. (Образование, конкурс)",
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("etrade/3666538", "irrelevant", {
    title: 'Конкурс на комплектующие изделия для производства кнопки',
    buyerName: 'Открытое акционерное общество "Завод "Ветразь"',
  }),
  live("etrade/3666537", "irrelevant", {
    title: 'Конкурс Открытое акционерное общество "Завод "Ветразь"',
    buyerName: 'Открытое акционерное общество "Завод "Ветразь"',
  }),
  live("single-source/3665350", "irrelevant", {
    title: "Конкурс жестовой песни «Звездопад» (наушники) (ЦИК)",
    buyerName:
      'Государственное учреждение "Гомельский областной центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("marketing/3665045", "irrelevant", {
    title:
      "Дипломы и фоторамки для подведения итогов ежегодного смотра-конкурса на лучшее благоустройство домов, подъездов многоквартирных домов",
    buyerName:
      'Государственное учреждение "Центр по обеспечению деятельности бюджетных организаций по Дубровенскому району"',
  }),
  live("request/3664670", "irrelevant", {
    title: "СО2-инкубатор (ВСУ)",
    buyerName:
      'Государственное учреждение "Центр по обеспечению деятельности бюджетных организаций и государственных органов Костюковичского района"',
  }),
  live("single-source/3664572", "irrelevant", {
    title: "Набор аспирационный хирургический тип Янкувер",
    buyerName: 'УЗ "3-я городская детская клиническая больница"',
  }),
  live("marketing/3663552", "irrelevant", {
    title: 'Пошив сценических костюмов для конкурса "Семья года"',
    buyerName:
      "Комитет по труду, занятости и социальной защите Минского областного исполнительного комитета",
  }),
  live("marketing/3660282", "irrelevant", {
    title: "НЕРА-фильтр для СО2-инкубатора D180-P",
    buyerName: 'Государственное учреждение "Сморгонская межрайонная ветеринарная лаборатория"',
  }),
  live("single-source/3660221", "irrelevant", {
    title:
      "Курсы повышения квалификации по теме: «Управление государственными закупками (организация и проведение), закупками на конкурсной основе»",
    buyerName:
      'Государственное учреждение "ЦЕНТР ГИГИЕНЫ И ЭПИДЕМИОЛОГИИ" Управления делами Президента Республики Беларусь',
  }),
  live("single-source/3658779", "irrelevant", {
    title: "Конкурс жестовой песни «Звездопад» (отпариватель) (ЦИК)",
    buyerName:
      'Государственное учреждение "Гомельский областной центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3658755", "irrelevant", {
    title:
      'Канцелярия для организации и проведения районного этапа республиканского экологического конкурса "Созидая,не разрушай"',
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3657962", "irrelevant", {
    title: "Конкурс жестовой песни «Звездопад» (диплом, наушники) (ЦИК)",
    buyerName:
      'Государственное учреждение "Гомельский областной центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("request/3657757", "uncertain", {
    title: "Закупка НКУ (УКН) 0,4 кВ",
    buyerName: 'Открытое акционерное общество "Электроцентрмонтаж"',
  }),
  live("marketing/3657562", "irrelevant", {
    title:
      "Оплата изделий ручной работы (сувениров) из керамики в качестве призов для участников городского конкурса «З бульбай, смачна!» в рамках организации и проведения мероприятий, посвященных Дню народного единства",
    buyerName: 'Учреждение культуры "Могилевский городской Центр культуры и досуга"',
  }),
  live("marketing/3656824", "irrelevant", {
    title: "Пледы для награждения участников фестиваля-конкурса «TERRI CON»",
    buyerName:
      'Государственное учреждение "Межотраслевой центр по обеспечению деятельности бюджетных организаций Солигорского района"',
  }),
  live("single-source/3655944", "irrelevant", {
    title:
      'Материалы для проведения пионерского праздника "Время новых побед!", посвященный Дню рождения БРПО (Образование, конкурс)',
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("etrade/3655300", "irrelevant", {
    title:
      'Организация и проведение Республиканского открытого конкурса любительских фильмов имени Юрия Тарича "Я снимаю кино" (г.Полоцк)',
    buyerName: "Министерство культуры Республики Беларусь",
  }),
  live("etrade/3653928", "irrelevant", {
    title:
      "КОНКУРС (С ПРОВЕДЕНИЕМ ПВЫБОР СУБПОДРЯДНОЙ ОРГАНИЗАЦИИ ДЛЯ ВЫПОЛНЕНИЯ КОМПЛЕКСА СТРОИТЕЛЬНО-МОНТАЖНЫХ РАБОТ С ПОСТАВКОЙ ТЕХНОЛОГИЧЕСКОГО ОБОРУДОВАНИЯ",
    buyerName: 'Открытое акционерное общество "СТРОЙТРЕСТ № 35"',
  }),
  live("marketing/3653037", "irrelevant", {
    title: "Баллон стальной и углекислота (двуокись углерода) к CO2 инкубатору.",
    buyerName: 'Государственное учреждение "Миорский районный центр гигиены и эпидемиологии"',
  }),
  live("etrade/3652765", "irrelevant", {
    title:
      'Конкурс на закупку услуг по проведению аудита годовой бухгалтерской и финансовой отчетности КУП "Молодечноводоканал" за 2025 год',
    buyerName: 'Городское комунальное унитарное предприятие "Молодечноводоканал"',
  }),
  live("single-source/3652543", "irrelevant", {
    title: 'Товары для проведения конкурса тематических плакатов "В единстве наша сила"',
    buyerName: "Дубровенский районный исполнительный комитет",
  }),
  live("single-source/3651681", "irrelevant", {
    title:
      'Материалы для проведения пионерского праздника "Время новых побед!", посвященный Дню рождения БРПО (Образование, конкурс)',
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3651611", "irrelevant", {
    title:
      'Дипломы для проведения районных соревнований среди детей и подростков по дисциплинам современного пятиборья "Дай пять" в 2026 году (Образование, конкурс)',
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3651596", "irrelevant", {
    title:
      'Дипломы для проведения районных соревнований по легкой атлетике "Школиада" в программе 25 районной спартакиады школьников (Образование, конкурс)',
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3651258", "irrelevant", {
    title: "СО2-инкубатор (термостат электронный)",
    buyerName: 'Государственное учреждение "Барановичская межрайонная ветеринарная лаборатория"',
  }),
  live("etrade/3651060", "irrelevant", {
    title:
      "Открытый конкурс по закупке аудиторских услуг по проведению обязательного аудита годовой бухгалтерской отчетности за 2026 год",
    buyerName: 'Коммунальное дочернее унитарное предприятие "Строительное управление № 22"',
  }),
  live("marketing/3650935", "irrelevant", {
    title: "Трубка аспирационная, тип Янкувера",
    buyerName: 'Учреждение здравоохранения "Смолевичская центральная районная больница"',
  }),
  live("marketing/3650794", "irrelevant", {
    title: "услуги по проведению конкурса",
    buyerName: "Комитет по труду, занятости и социальной защите Витебского облисполкома",
  }),
  live("single-source/3650555", "irrelevant", {
    title: 'Подарки для конкурса "Лучший студенческий отряд"',
    buyerName: "Хотимский районный исполнительный комитет",
  }),
  live("single-source/3649096", "irrelevant", {
    title: "Диагностика инкубаторов СО2",
    buyerName:
      'Государственное учреждение "Республиканский научно-практический центр трансфузиологии и медицинских биотехнологий"',
  }),
  live("etrade/3648898", "irrelevant", {
    title:
      "Открытый конкурс по закупке аудиторских услуг по проведению обязательного аудита годовой бухгалтерской отчетности за 2026 год",
    buyerName: 'Коммунальное дочернее унитарное предприятие "Строительное управление № 24"',
  }),
  live("single-source/3648115", "irrelevant", {
    title:
      'Материалы для проведения пионерского праздника "Время новых побед!", посвященный Дню рождения БРПО (Образование, конкурс)',
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3648109", "irrelevant", {
    title: "Услуга по техническому обслуживанию СО2 инкубатор",
    buyerName:
      'Учреждение "Гомельский областной диагностический медико-генетический центр с консультацией "Брак и семья"',
  }),
  live("single-source/3647486", "irrelevant", {
    title:
      'Канцелярские принадлежности для организации и проведения районного этапа республиканского конкурса опытнических и исследовательских работ "Юный натуралист" (Образование, конкурс)',
    buyerName:
      'Государственное учреждение "Кобринский районный центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3647364", "irrelevant", {
    title: "Конкурс жестовой песни «Звездопад» (диплом, колонка, отпариватель. наушники) (ЦИК)",
    buyerName:
      'Государственное учреждение "Гомельский областной центр по обеспечению деятельности бюджетных организаций"',
  }),
  live("single-source/3664623", "irrelevant", {
    title:
      "Закупка шкаф управления наружным освещением для объекта Общеобразовательная школа на 1020 мест с бассейном в границах жилой застройки ул. Разинской, пр. Жукова, ул. Грушевской, ул. Щорса в г.Минске",
    buyerName: 'Коммунальное унитарное дочернее предприятие "Управление капитального строительства Запад"',
  }),
  live("request/3645949", "irrelevant", {
    title:
      "Выбор организации - поставщика оборудования Шкаф управления (щит диспетчеризации и управления котельной ЩД) для объекта «Модернизация котельной в п.Советский г.Осиповичи».",
    buyerName: "Осиповичское унитарное коммунальное предприятие жилищно-коммунального хозяйства",
  }),
  live("marketing/3616560", "uncertain", {
    title:
      "Закупка шкаф управления для автоматизации очистных сооружений (монтаж и пусконаладочные работы)",
    buyerName: 'Открытое акционерное общество "Гродненский мясокомбинат"',
  }),
  live("marketing/2644790", "uncertain", {
    title: "Шкаф автоматики",
    buyerName: 'Государственное учреждение "Хоккейный клуб "Могилев"',
  }),
];

export const NKU_PUMP_CASES: readonly SearchEvalCase[] = [
  ...NKU_PUMP_SEED_CASES,
  ...NKU_PUMP_LIVE_CASES,
];

function live(
  id: string,
  gold: SearchEvalCase["gold"],
  fields: { title: string; buyerName?: string; sourceStatus?: string },
): SearchEvalCase {
  return {
    id,
    title: fields.title,
    gold,
    url: `https://goszakupki.by/${id}`,
    ...(fields.buyerName === undefined ? {} : { buyerName: fields.buyerName }),
    ...(fields.sourceStatus === undefined ? {} : { sourceStatus: fields.sourceStatus }),
  };
}

const NKU_EVAL_CLASS_DEFS: readonly { name: string; match: (row: SearchEvalRow) => boolean }[] = [
  {
    name: "Подстрока НКУ (конкурс / инкубатор / Янкувер)",
    match: (row) =>
      row.id.includes("substring") ||
      (!termOccurs(row.title, "НКУ") &&
        !termOccurs(row.title, "шкаф управления") &&
        /конкурс|инкубатор|янкувер/iu.test(row.title)),
  },
  {
    name: "Чужое назначение (освещение / котельная)",
    match: (row) =>
      row.id === "nku-street-lighting" ||
      row.id === "nku-boiler-cabinet" ||
      /освещен|котельн/iu.test(row.title),
  },
  {
    name: "поставщик ≠ поставка",
    match: (row) => row.id.startsWith("nku-supplier") || /поставщик/iu.test(row.title),
  },
  {
    name: "Назначение не сказано",
    match: (row) =>
      row.id === "nku-supply" ||
      row.id === "nku-no-purpose" ||
      row.id === "nku-supply-with-install" ||
      row.id === "request/3657757",
  },
  {
    name: "Работы как предмет (монтаж / ремонт / ПНР)",
    match: (row) =>
      row.id === "nku-install" || row.id === "nku-repair" || row.id === "nku-commission",
  },
  {
    name: "Объект только в доп. тексте",
    match: (row) => row.id === "nku-mention-only",
  },
  {
    name: "Поставка НКУ для насосов",
    match: (row) =>
      row.id === "nku-for-pumps" ||
      row.id === "nku-cabinet" ||
      row.id === "nku-pump-cabinet" ||
      row.id === "nku-supplier-pumps",
  },
];

/** Decision counts per STAGE-51 problem class. A row may belong to several classes. */
export function formatNkuClassReport(report: SearchEvalReport): string {
  const lines = ["Per-class (a case may belong to more than one class):"];
  for (const group of NKU_EVAL_CLASS_DEFS) {
    const rows = report.rows.filter(group.match);
    if (rows.length === 0) continue;
    lines.push("", `${group.name} (${String(rows.length)}):`);
    lines.push(`  old: ${formatDecisionMix(rows, "oldDecision")}`);
    lines.push(`  new: ${formatDecisionMix(rows, "newDecision")}`);
    lines.push(
      `  new FP=${String(countFp(rows, "newDecision"))} FN=${String(countFn(rows, "newDecision"))} (old FP=${String(countFp(rows, "oldDecision"))} FN=${String(countFn(rows, "oldDecision"))})`,
    );
  }
  return lines.join("\n");
}

function formatDecisionMix(
  rows: readonly SearchEvalRow[],
  field: "oldDecision" | "newDecision",
): string {
  const counts = { match: 0, review: 0, discard: 0 };
  for (const row of rows) counts[row[field]] += 1;
  return `match=${String(counts.match)} review=${String(counts.review)} discard=${String(counts.discard)}`;
}

function countFp(rows: readonly SearchEvalRow[], field: "oldDecision" | "newDecision"): number {
  return rows.filter((row) => row.gold === "irrelevant" && row[field] === "match").length;
}

function countFn(rows: readonly SearchEvalRow[], field: "oldDecision" | "newDecision"): number {
  return rows.filter((row) => row.gold === "relevant" && row[field] !== "match").length;
}
