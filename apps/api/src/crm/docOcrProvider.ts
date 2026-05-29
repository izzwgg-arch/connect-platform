/**
 * CRM Document OCR Provider — Phase 5B
 *
 * Provides an abstraction layer for OCR text extraction from image documents.
 * The current implementation uses Tesseract.js (v7, pure WASM, no native deps).
 *
 * Supported image types: PNG, JPG/JPEG, TIFF (tesseract_js provider).
 * NOT supported: scanned PDFs (requires PDF rasterization which needs native
 * deps in Node.js — see KNOWN_ISSUES.md).
 *
 * Configuration (environment variables):
 *   CRM_OCR_ENABLED          — "true" to enable OCR. Default: false.
 *   CRM_OCR_MAX_FILE_BYTES   — Max bytes to process. Default: 10485760 (10 MB).
 *   CRM_OCR_PROVIDER         — Provider name. Currently only "tesseract_js".
 *                              Default: "tesseract_js".
 *   CRM_OCR_LANG             — Tesseract language code. Default: "eng".
 *   CRM_OCR_LANG_PATH        — Optional path to pre-downloaded .traineddata files.
 *                              Required in air-gapped / Docker environments that
 *                              cannot reach Tesseract CDN at runtime.
 *
 * Security:
 *   - OCR text is NEVER logged.
 *   - File buffers are processed in-memory and not written to additional paths.
 *   - Provider errors are truncated to 500 chars before storage.
 *   - Limits (size, page count) are enforced before processing.
 */

// ── Config ────────────────────────────────────────────────────────────────────

export type OcrConfig = {
  enabled: boolean;
  maxFileBytes: number;
  provider: string;
  lang: string;
  langPath: string | undefined;
};

/** Reads OCR configuration from environment variables. */
export function loadOcrConfig(): OcrConfig {
  return {
    enabled: process.env.CRM_OCR_ENABLED === "true",
    maxFileBytes: parseInt(process.env.CRM_OCR_MAX_FILE_BYTES ?? "10485760", 10),
    provider: process.env.CRM_OCR_PROVIDER ?? "tesseract_js",
    lang: process.env.CRM_OCR_LANG ?? "eng",
    langPath: process.env.CRM_OCR_LANG_PATH,
  };
}

// ── Provider interface ────────────────────────────────────────────────────────

export type OcrInput = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
};

export type OcrOutput = {
  text: string;
  confidence: number;   // 0–100
  pageCount: number | null;
  metadata: Record<string, unknown>;
};

export interface DocumentOcrProvider {
  /** Stable name stored in extractionProvider field. */
  readonly name: string;
  /** Returns true if this provider can process the given MIME type. */
  supports(mimeType: string): boolean;
  /** Extract text from the image buffer. Throws on error. */
  extractText(input: OcrInput, config: OcrConfig): Promise<OcrOutput>;
}

// ── MIME type helpers ─────────────────────────────────────────────────────────

/** MIME types supported by Tesseract.js image OCR. */
const TESSERACT_SUPPORTED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/tiff",
  "image/bmp",
  "image/gif",  // supported by Tesseract but low value — included for completeness
]);

/** File extension fallback for MIME types that might be missing. */
function mimeFromExt(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "tiff":
    case "tif": return "image/tiff";
    case "bmp": return "image/bmp";
    default: return "";
  }
}

export function resolveImageMime(mimeType: string | null | undefined, fileName: string): string {
  const m = (mimeType || "").toLowerCase();
  if (TESSERACT_SUPPORTED_MIMES.has(m)) return m;
  return mimeFromExt(fileName);
}

// ── TesseractJs provider ──────────────────────────────────────────────────────

export class TesseractJsOcrProvider implements DocumentOcrProvider {
  readonly name = "tesseract_js";

  supports(mimeType: string): boolean {
    return TESSERACT_SUPPORTED_MIMES.has(mimeType.toLowerCase());
  }

  async extractText(input: OcrInput, config: OcrConfig): Promise<OcrOutput> {
    // Import dynamically to avoid WASM initialisation on module load when OCR disabled
    const { createWorker } = await import("tesseract.js");

    const workerOptions: Record<string, unknown> = {};
    if (config.langPath) {
      workerOptions.langPath = config.langPath;
    }

    const worker = await createWorker(config.lang, 1, workerOptions);
    try {
      const result = await worker.recognize(input.buffer);
      const text = result.data.text ?? "";
      const confidence = typeof result.data.confidence === "number" ? result.data.confidence : 0;

      return {
        text,
        confidence,
        pageCount: 1, // Tesseract.js processes one image = one page
        metadata: {
          ocrEngine: "tesseract_js",
          language: config.lang,
          pageCount: 1,
        },
      };
    } finally {
      // Always terminate — prevents WASM memory leak across calls
      await worker.terminate();
    }
  }
}

// ── Provider registry ─────────────────────────────────────────────────────────

/** Returns the configured OCR provider, or null if OCR is disabled/unconfigured. */
export function getOcrProvider(config: OcrConfig): DocumentOcrProvider | null {
  if (!config.enabled) return null;
  switch (config.provider) {
    case "tesseract_js":
      return new TesseractJsOcrProvider();
    default:
      return null;
  }
}

// ── Size guard ────────────────────────────────────────────────────────────────

export class OcrLimitError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OcrLimitError";
    this.code = code;
  }
}

/** Throws OcrLimitError if the buffer exceeds the configured size limit. */
export function assertOcrSizeLimit(buffer: Buffer, config: OcrConfig): void {
  if (buffer.length > config.maxFileBytes) {
    throw new OcrLimitError(
      "ocr_file_too_large",
      `File size ${buffer.length} bytes exceeds OCR limit of ${config.maxFileBytes} bytes (${Math.round(config.maxFileBytes / 1024 / 1024)} MB).`,
    );
  }
}
