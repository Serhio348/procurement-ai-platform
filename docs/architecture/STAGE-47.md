# Этап 47 — модель читает документы, код проверяет каждую цифру

## Цель

Блок «Коммерческие условия» заполняли только регулярные выражения, поэтому
формулировка «расчёт в течение тридцати банковских дней» или условие в таблице
не находились. Модель должна дочитывать то, что правила пропустили, но не
получать права на догадку.

## Архитектурное решение

```
«Участвовать» → get_documents → download → recognizeSpecialistDocument
  → страницы, прошедшие pageSafeForCommercialFacts
  → cheapExtractCommercialClaims (правила)
  → missingCommercialKeys: аванс, срок оплаты, срок поставки, гарантия
      все четыре найдены → модель НЕ вызывается
  → rankCommercialPages(…, 12): страницы со словами про деньги и сроки
  → CommercialReaderPort.read (DeepSeek, JSON mode, temperature 0)
  → CommercialExtractorOutput (Zod)
  → keepTrustedClaims: страница из отправленных, цитата дословно на ней,
     12…600 знаков, слово по теме ключа, число из value внутри цитаты
  → claims модели дописываются ТОЛЬКО к пропущенным ключам
  → termsDetail (как раньше) + termsEvidence (условие, цитата, файл, страница)
```

Промпт — не граница. `COMMERCIAL_READER_SYSTEM_PROMPT` живёт в
`packages/domain/src/commercial/reader-prompt.ts` рядом с гейтом, каждая его
строка повторяет проверку из `keepTrustedClaims`, и решает именно гейт.
Отклонения не молчат: причина каждого (`number_not_in_quote`,
`subject_missing`, `page_not_read`, …) пишется в лог.

Правила сильнее модели: где регексп уже прочитал цифру со страницы, ответ
модели по этому ключу отбрасывается. Поэтому повторный прогон не может
переставить уже проверенную карточку.

Строгий гейт применяется только к claims модели. У регекспов цитата — это сам
совпавший фрагмент («аванс 30 %»), в нём меньше 12 букв, и требование длины
для них бессмысленно; их провенанс проверяет прежний `keepQuotedClaims`.

Один вызов модели на закупку, не более 12 страниц, и только при пробеле.
Отказ модели, таймаут или мусорный JSON → лог и карточка ровно такая, какой
была бы на одних правилах.

## Почему именно так

Fine-tuning и «обучающие промпты» задачу не решают: проверяемость даёт не
формулировка запроса, а сверка ответа с текстом страницы. Цитата сама по себе
тоже недостаточна — модель может привести настоящую фразу и приписать к ней
чужое число. Поэтому в коде появились три новых условия: число обязано быть
внутри своей цитаты, цитата обязана говорить о нужном условии, страница
обязана быть из отправленных.

`apps/api` не имеет права импортировать `apps/agent-runtime` (правило слоёв),
поэтому HTTP-оболочка живёт в API — как уже сделано для `search-classifier`.
Разъезда промптов при этом нет: он один и лежит в domain, и оба пути —
консоль и `CommercialTermsAgent` — теперь судят claims модели одним гейтом.

## Изменения

Новые файлы:

- `packages/domain/src/commercial/trust.ts` + тест
- `packages/domain/src/commercial/reading.ts` + тест
- `packages/domain/src/commercial/reader-prompt.ts`
- `apps/api/src/commercial-reader.ts` + тест
- `apps/web/src/procurements/TermsEvidenceList.tsx`
- `docs/architecture/STAGE-47.md`

Изменённые:

- contracts: `SpecialistTermsEvidence`, поле `termsEvidence` на карточке
- domain: `applyParticipateDocuments(card, documents, { modelClaims })`,
  `participateReadablePages`, `participateRuleClaims`, цитаты в
  `compileSpecialistCase`, `slimListedCard` вырезает `termsEvidence`
- agent-runtime: `CommercialTermsAgent` проверяет claims модели
  `keepTrustedClaims`, общий промпт вместо своего
- api: читатель подключён в `document-ingest`, лог «Commercial reader …»
- db: `tileCardExpression` вырезает `termsEvidence` из плиток
- web: цитаты в списке кейсов и в карточке, стили `.terms-evidence`

## Database changes

Миграции нет. `termsEvidence` живёт внутри `workspace_procurements.card`
(JSONB); у старых карточек поле отсутствует и читается как пустой список.

## Настройки

| Переменная | Смысл |
|---|---|
| `LLM_API_KEY` | без неё читатель выключен, поведение как до этапа |
| `COMMERCIAL_READER=off` | выключить читателя, оставив ключ для поиска и vision |
| `COMMERCIAL_READER_MODEL` | модель для чтения документов, иначе `LLM_MODEL` |
| `COMMERCIAL_READER_TIMEOUT_MS` | таймаут одного запроса, по умолчанию 90 000 |

## Тесты

- domain: число не из цитаты, цитата не по теме ключа, цитата не со страницы,
  страница не отправлялась, слишком короткая цитата, «аванс не предусмотрен»
  без цифры
- domain: пробелы считаются по четырём ключам, «до N%» закрывает вопрос аванса
- domain: страницы про деньги идут первыми, спецификация не идёт
- domain: claim модели заполняет пробел и показывает цитату с файлом и
  страницей; claim модели не перебивает правило (60 мес. не вытесняют 24)
- api: JSON mode, ключ не попадает в промпт, HTTP 500 не превращается в
  пустой ответ, `COMMERCIAL_READER=off`

## Риски

- Распознавание не улучшено: OCR по-прежнему читает одну самую большую
  картинку страницы, сжимает её до 1600 px и доверяет vision фиксированные
  0.72. Плохой скан так и останется плохим — это следующий этап.
- Потолки поднялись до 50 страниц OCR на файл и 100 МБ на файл. Худший случай
  одного «Участвовать» — 50 vision-вызовов подряд, это минуты под открытым
  HTTP-запросом; при обратном прокси нужен `proxy_read_timeout` с запасом.
- Расход токенов растёт: одна закупка с пробелами = один запрос на 12
  страниц текста.
- Снятие пробела по одному ключу не значит, что условие верно понято:
  специалист обязан посмотреть цитату, для этого она и показана.
- `paymentQuote` в пути «Участвовать» по-прежнему не заполняется, он приходит
  только из `compileSpecialistCase`.

## Обновление на сервере

```bash
cd /opt/procurement-ai-platform
git pull
npm install
npm run build
npm run build -w @procurement/web
systemctl restart procurement-api
journalctl -u procurement-api -n 20 --no-pager | grep "Commercial reader"
```

Миграция не нужна. В логе при старте должно быть
`Commercial reader configured {"model":true}`.
