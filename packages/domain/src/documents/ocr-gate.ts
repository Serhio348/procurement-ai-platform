/**
 * OCR confidence is a signal, not a fact. Below the agent threshold the
 * specialist must read the scan; the system does not invent missing text.
 */
export function ocrNeedsHuman(confidence: number, minConfidence: number): boolean {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
    throw new Error("minConfidence must be between 0 and 1");
  }
  return confidence < minConfidence;
}
