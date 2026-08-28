// Thin client for Google Veo video generation over the Gemini API.
// No dependencies: Node 18+ global fetch only.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'veo-3.1-fast-generate-preview';

/**
 * Reads KEY=VALUE lines from a dotenv-style file. Values may be quoted.
 * Missing files are ignored so the env var path stays the primary one.
 */
function readDotEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const KEY_NAMES = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_API_KEY'];

export function getApiKey() {
  for (const name of KEY_NAMES) {
    if (process.env[name]) return process.env[name];
  }
  const fileEnv = readDotEnv(resolve(HERE, '.env'));
  for (const name of KEY_NAMES) {
    if (fileEnv[name]) return fileEnv[name];
  }
  throw new Error(
    'No Gemini API key found. Set GEMINI_API_KEY in the environment, or put ' +
      'GEMINI_API_KEY=... in tools/veo-mcp/.env (that file is gitignored).'
  );
}

async function apiFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'x-goog-api-key': getApiKey(),
      ...(init.headers || {}),
    },
  });
  return res;
}

async function apiJson(url, init) {
  const res = await apiFetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Gemini API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) {
    const msg = body?.error?.message || text.slice(0, 500);
    throw new Error(`Gemini API error (HTTP ${res.status}): ${msg}`);
  }
  return body;
}

/** Lists the Veo models this API key can actually call. */
export async function listVeoModels() {
  const body = await apiJson(`${API_BASE}/models?pageSize=200`);
  return (body.models || [])
    .filter((m) => m.name.includes('veo'))
    .map((m) => ({
      model: m.name.replace(/^models\//, ''),
      displayName: m.displayName,
      description: m.description,
      methods: m.supportedGenerationMethods,
    }));
}

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Turns a local path or a raw base64 string into the API's image instance shape. */
function buildImage({ imagePath, imageBase64, imageMimeType }) {
  if (!imagePath && !imageBase64) return undefined;
  if (imagePath) {
    const abs = isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath);
    if (!existsSync(abs)) throw new Error(`Image not found: ${abs}`);
    const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
    const mime = imageMimeType || IMAGE_MIME_BY_EXT[ext];
    if (!mime) throw new Error(`Cannot infer mime type for ${abs}; pass imageMimeType.`);
    return { bytesBase64Encoded: readFileSync(abs).toString('base64'), mimeType: mime };
  }
  return {
    bytesBase64Encoded: imageBase64,
    mimeType: imageMimeType || 'image/png',
  };
}

/**
 * Starts a Veo generation. Returns the long-running operation, whose `name`
 * is polled with getOperation until `done` is true.
 */
export async function startGeneration(args = {}) {
  const model = args.model || DEFAULT_MODEL;
  if (!args.prompt) throw new Error('prompt is required');

  const instance = { prompt: args.prompt };
  const image = buildImage(args);
  if (image) instance.image = image;

  const parameters = {};
  if (args.aspectRatio) parameters.aspectRatio = args.aspectRatio;
  if (args.resolution) parameters.resolution = args.resolution;
  if (args.negativePrompt) parameters.negativePrompt = args.negativePrompt;
  if (args.personGeneration) parameters.personGeneration = args.personGeneration;
  if (args.durationSeconds) parameters.durationSeconds = args.durationSeconds;
  if (args.sampleCount) parameters.sampleCount = args.sampleCount;

  const body = { instances: [instance] };
  if (Object.keys(parameters).length) body.parameters = parameters;

  return apiJson(`${API_BASE}/models/${model}:predictLongRunning`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Fetches the current state of a long-running operation by its full name. */
export async function getOperation(operationName) {
  if (!operationName) throw new Error('operationName is required');
  const name = operationName.replace(/^\/+/, '');
  return apiJson(`${API_BASE}/${name}`);
}

/**
 * Pulls the video URIs out of a completed operation. The API has shipped two
 * response shapes for this, so both are accepted.
 */
export function extractVideoUris(operation) {
  const response = operation?.response || {};
  const samples =
    response?.generateVideoResponse?.generatedSamples ||
    response?.generatedSamples ||
    response?.generatedVideos ||
    response?.videos ||
    [];
  const uris = [];
  for (const sample of samples) {
    const uri = sample?.video?.uri || sample?.uri || sample?.video?.url;
    if (uri) uris.push(uri);
  }
  return uris;
}

/** Reports RAI/safety filtering, which comes back as a success with no samples. */
export function extractFilterReasons(operation) {
  const response = operation?.response || {};
  const raw =
    response?.generateVideoResponse?.raiMediaFilteredReasons ||
    response?.raiMediaFilteredReasons ||
    [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Downloads a video URI (or a bare file id) to disk and returns the path. */
export async function downloadVideo(videoUri, outputPath) {
  if (!videoUri) throw new Error('videoUri is required');
  let url = videoUri;
  if (!/^https?:\/\//.test(url)) {
    const fileId = url.replace(/^files\//, '');
    url = `${API_BASE}/files/${fileId}:download?alt=media`;
  } else if (!url.includes('alt=media')) {
    url += (url.includes('?') ? '&' : '?') + 'alt=media';
  }

  const res = await apiFetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Download failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const abs = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return { path: abs, bytes: buf.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a generation and polls until it finishes or the deadline passes.
 * Veo runs take roughly one to six minutes, so the default budget is generous.
 */
export async function generateAndWait(args = {}) {
  const pollIntervalMs = Math.max(2000, (args.pollIntervalSeconds ?? 10) * 1000);
  const timeoutMs = Math.max(30000, (args.timeoutSeconds ?? 600) * 1000);
  const started = Date.now();

  const op = await startGeneration(args);
  let current = op;
  while (!current.done) {
    if (Date.now() - started > timeoutMs) {
      return { timedOut: true, operationName: op.name, elapsedSeconds: Math.round((Date.now() - started) / 1000) };
    }
    await sleep(pollIntervalMs);
    current = await getOperation(op.name);
  }

  if (current.error) {
    throw new Error(`Generation failed: ${current.error.message || JSON.stringify(current.error)}`);
  }

  const uris = extractVideoUris(current);
  const filtered = extractFilterReasons(current);
  const result = {
    operationName: op.name,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    videoUris: uris,
    filteredReasons: filtered,
  };

  if (args.outputPath && uris.length) {
    const downloads = [];
    for (const [i, uri] of uris.entries()) {
      const target =
        uris.length === 1 ? args.outputPath : args.outputPath.replace(/(\.[^.]+)?$/, `-${i + 1}$1`);
      downloads.push(await downloadVideo(uri, target));
    }
    result.downloads = downloads;
  }
  return result;
}
