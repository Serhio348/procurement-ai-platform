export interface OcrEngine {
  recognize(png: Uint8Array): Promise<{ text: string; confidence: number }>;
}
