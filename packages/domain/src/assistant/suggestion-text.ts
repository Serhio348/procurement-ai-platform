import type { AssistantSuggestionEntry } from "@procurement/contracts";

function procurementsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "закупку";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "закупки";
  return "закупок";
}

/** The same wording in the console and in Telegram. */
export function assistantSuggestionText(
  suggestion: Pick<AssistantSuggestionEntry, "label" | "rejectCount" | "profileName">,
): {
  title: string;
  body: string;
  question: string;
  acceptLabel: string;
  dismissLabel: string;
  acceptEffect: string;
  dismissEffect: string;
} {
  const profile = suggestion.profileName.trim().length > 0 ? suggestion.profileName : "без названия";
  return {
    title: `Помощник: профиль «${profile}»`,
    body:
      `Вы отклонили ${suggestion.rejectCount} ${procurementsWord(suggestion.rejectCount)} ` +
      `с предметом «${suggestion.label}» и не взяли ни одной.`,
    question: `Не показывать такие закупки в профиле «${profile}»?`,
    acceptLabel: "Да, не показывать",
    dismissLabel: "Нет, оставить",
    acceptEffect: `«${suggestion.label}» добавится в исключения профиля. Убрать можно в редакторе профиля.`,
    dismissEffect: `Закупки с предметом «${suggestion.label}» остаются в поиске.`,
  };
}
