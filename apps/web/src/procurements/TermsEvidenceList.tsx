import type { SpecialistTermsEvidence } from "@procurement/contracts";

/**
 * Every condition with the wording it came from. The specialist is the last
 * check on the model, so the file and page are always shown next to the quote.
 */
export function TermsEvidenceList({ items }: { items: readonly SpecialistTermsEvidence[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="terms-evidence">
      {items.map((item, index) => (
        <li key={`${item.key}-${String(item.page)}-${String(index)}`}>
          <p className="terms-evidence-head">
            <strong>
              {item.label}: {item.value}
            </strong>
            {item.foundBy === "model" ? (
              <span className="terms-evidence-mark">прочитано моделью</span>
            ) : null}
          </p>
          <blockquote className="terms-evidence-quote">{item.quote}</blockquote>
          <p className="terms-evidence-source">
            {item.documentName}, стр. {String(item.page)}
          </p>
        </li>
      ))}
    </ul>
  );
}
