import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@procurement/observability";
import { PdfJsDocumentExtractor, pdfPageToPng } from "./pdfjs-extractor.js";
import { defaultTessdataDirectory, TesseractOcrEngine } from "./tesseract-ocr.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const defaultHash = "76e00407827a936d5a060b5def7598ed23a059f20cb8e6b516bdd9a0339a9a39";
const doclingPythonDefault = "E:\\Projects\\mcp-pdf-reader\\.venv\\Scripts\\python.exe";
const doclingScript = fileURLToPath(new URL("../scripts/docling-page.py", import.meta.url));

const logger = createLogger({
  level: process.env["LOG_LEVEL"] === "debug" ? "debug" : "info",
  sink: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
});

await loadDotEnv(path.join(repoRoot, ".env"));

const pageNumber = positiveInt(process.env["COMPARE_PAGE"], 1);
const outDir = path.join(repoRoot, "data", "ocr-compare");
const source = await resolvePdf();
const bytes = new Uint8Array(await readFile(source));
const hash = sha256(bytes);

await mkdir(outDir, { recursive: true });
const pdfCopy = path.join(outDir, "source.pdf");
await copyFile(source, pdfCopy);

logger.info("ocr_compare_start", { hash, pageNumber, source, outDir });

const png = await pdfPageToPng(bytes, pageNumber);
const pngPath = path.join(outDir, `page-${pageNumber}.png`);
if (png !== undefined) {
  await writeFile(pngPath, png);
}

const ocr = new TesseractOcrEngine({ cachePath: defaultTessdataDirectory() });
try {
  await writeResult("01-platform.md", await runPlatform(bytes, hash, ocr));
  await writeResult("02-tesseract.md", await runTesseract(png, ocr));
} finally {
  await ocr.close();
}

await writeResult("03-docling.md", await runDocling(pdfCopy, pageNumber));
await writeResult("04-deepseek.md", await runDeepSeek(png));
await writeFile(path.join(outDir, "README.md"), indexMarkdown(hash, source, pageNumber), "utf8");

logger.info("ocr_compare_done", { outDir });

async function runPlatform(
  pdfBytes: Uint8Array,
  pdfHash: string,
  engine: TesseractOcrEngine,
): Promise<string> {
  const extractor = new PdfJsDocumentExtractor({ ocr: engine, maxOcrPages: 1 });
  const extracted = await extractor.extractText(pdfHash, pdfBytes, "application/pdf");
  const page = extracted.pages.find((item) => item.page === pageNumber);
  return [
    "# Platform (pdf.js layout + Tesseract on sparse pages)",
    "",
    `- status: ${extracted.status}`,
    `- document confidence: ${extracted.confidence}`,
    `- ocrApplied: ${extracted.ocrApplied}`,
    `- page ${pageNumber} confidence: ${page?.confidence ?? "missing"}`,
    `- page ${pageNumber} ocrApplied: ${page?.ocrApplied ?? "missing"}`,
    "",
    page?.text ?? "(no page text)",
    "",
  ].join("\n");
}

async function runTesseract(
  image: Uint8Array | undefined,
  engine: TesseractOcrEngine,
): Promise<string> {
  if (image === undefined) {
    return "# Tesseract.js\n\nNo embedded page image to OCR.\n";
  }
  const result = await engine.recognize(image);
  return [
    "# Tesseract.js rus+eng on page PNG",
    "",
    `- confidence: ${result.confidence}`,
    "",
    result.text.length > 0 ? result.text : "(empty)",
    "",
  ].join("\n");
}

async function runDocling(pdfPath: string, page: number): Promise<string> {
  const python = process.env["DOCLING_PYTHON"] ?? doclingPythonDefault;
  if (!(await exists(python))) {
    return [
      "# Docling",
      "",
      `Python venv not found: ${python}`,
      "Install Docling in E:\\Projects\\mcp-pdf-reader or set DOCLING_PYTHON.",
      "",
    ].join("\n");
  }
  const output = path.join(outDir, "03-docling.raw.md");
  try {
    const { stdout, stderr } = await runCommand(python, [
      doclingScript,
      pdfPath,
      "--page",
      String(page),
      "--mode",
      "full",
      "--output",
      output,
    ]);
    const body = await readFile(output, "utf8").catch(() => "");
    return [
      "# Docling (mcp-pdf-reader --mode full, one page)",
      "",
      body.trim().length > 0 ? body.trim() : "(empty markdown)",
      "",
      stderr.trim().length > 0 ? `## stderr\n\n\`\`\`\n${stderr.trim()}\n\`\`\`\n` : "",
      stdout.trim().length > 0 ? `## stdout\n\n\`\`\`\n${stdout.trim()}\n\`\`\`\n` : "",
    ].join("\n");
  } catch (error) {
    return ["# Docling", "", failed(error), ""].join("\n");
  }
}

async function runDeepSeek(image: Uint8Array | undefined): Promise<string> {
  const apiKey = process.env["LLM_API_KEY"]?.trim() ?? "";
  if (apiKey.length === 0) {
    return [
      "# DeepSeek vision",
      "",
      "Skipped: LLM_API_KEY is empty.",
      "Paste the key into `.env` at the repo root (`LLM_API_KEY=sk-...`) and rerun",
      "`npm run compare:extractors`.",
      "",
      "`deepseek-chat` cannot see images. The compare uses `LLM_VISION_MODEL`",
      "(default `deepseek-v4-flash-vision-exp`).",
      "",
    ].join("\n");
  }
  if (image === undefined) {
    return "# DeepSeek vision\n\nNo page PNG to send.\n";
  }
  const baseUrl = process.env["LLM_BASE_URL"] ?? "https://api.deepseek.com";
  const model = process.env["LLM_VISION_MODEL"] ?? "deepseek-v4-flash-vision-exp";
  const timeoutMs = positiveInt(process.env["LLM_VISION_TIMEOUT_MS"], 120_000);
  const endpoint = completionEndpoint(baseUrl);
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Это скан одной страницы строительного чертежа (штамп, таблицы, надписи).",
              "Перепиши весь читаемый текст как можно ближе к оригиналу.",
              "Не выдумывай цифры и названия. Если фрагмент не читается — напиши [неразборчиво].",
              "Сначала штамп/основная надпись, затем остальное.",
            ].join(" "),
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from(image).toString("base64")}`,
              detail: "original",
            },
          },
        ],
      },
    ],
    temperature: 0,
    stream: false,
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (!response.ok) {
      return [
        "# DeepSeek vision",
        "",
        `- model: ${model}`,
        `- HTTP ${response.status}`,
        "",
        "```",
        clip(body, 4000),
        "```",
        "",
      ].join("\n");
    }
    const parsed = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = parsed.choices?.[0]?.message?.content ?? "(empty content)";
    return ["# DeepSeek vision", "", `- model: ${model}`, "", text, ""].join("\n");
  } catch (error) {
    return ["# DeepSeek vision", "", failed(error), ""].join("\n");
  }
}

async function resolvePdf(): Promise<string> {
  const explicit = process.env["COMPARE_PDF"] ?? process.argv[2];
  if (explicit !== undefined && explicit.trim().length > 0) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.join(repoRoot, explicit);
    if (await exists(candidate)) return candidate;
    const asHash = path.join(repoRoot, "data", "blobs", explicit.trim());
    if (await exists(asHash)) return asHash;
    throw new Error(`COMPARE_PDF not found: ${explicit}`);
  }
  const fromBlob = path.join(repoRoot, "data", "blobs", defaultHash);
  if (await exists(fromBlob)) return fromBlob;
  throw new Error(`Default blob missing: ${fromBlob}`);
}

async function writeResult(name: string, text: string): Promise<void> {
  await writeFile(path.join(outDir, name), text, "utf8");
  logger.info("ocr_compare_wrote", { name, bytes: Buffer.byteLength(text, "utf8") });
}

function indexMarkdown(pdfHash: string, sourcePath: string, page: number): string {
  return [
    "# Сравнение извлечения текста",
    "",
    `Файл: \`${sourcePath}\``,
    `SHA-256: \`${pdfHash}\``,
    `Страница: ${page} (не весь PDF)`,
    "",
    "| Файл | Движок |",
    "|---|---|",
    "| `01-platform.md` | Платформа: pdf.js слой + Tesseract на пустых страницах |",
    "| `02-tesseract.md` | Только Tesseract.js по PNG страницы |",
    "| `03-docling.md` | Docling из mcp-pdf-reader, `--mode full` |",
    "| `04-deepseek.md` | DeepSeek vision (`LLM_VISION_MODEL`) |",
    "| `page-N.png` | Картинка, которую видели Tesseract и DeepSeek |",
    "",
    "Ключ DeepSeek: `.env` в корне репозитория, поле `LLM_API_KEY`.",
    "",
  ].join("\n");
}

async function loadDotEnv(envPath: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, PYTHONUTF8: "1" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited ${code ?? "null"}\n${stderr || stdout}`));
    });
  });
}

function completionEndpoint(baseUrl: string): string {
  const endpoint = new URL(baseUrl);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/chat/completions`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function failed(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}…`;
}
