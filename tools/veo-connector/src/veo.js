// Google Veo calls, written against the Workers runtime (fetch + Web Crypto only).

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODEL = 'veo-3.1-fast-generate-preview';

async function apiJson(url, apiKey, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'x-goog-api-key': apiKey, ...(init?.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Gemini API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`Gemini API error (HTTP ${res.status}): ${body?.error?.message || text.slice(0, 300)}`);
  return body;
}

export async function listVeoModels(apiKey) {
  const body = await apiJson(`${API_BASE}/models?pageSize=200`, apiKey);
  return (body.models || [])
    .filter((m) => m.name.includes('veo'))
    .map((m) => ({ model: m.name.replace(/^models\//, ''), displayName: m.displayName }));
}

export async function startGeneration(apiKey, args = {}) {
  if (!args.prompt) throw new Error('prompt is required');
  const model = args.model || DEFAULT_MODEL;

  const instance = { prompt: args.prompt };
  if (args.imageBase64) {
    instance.image = {
      bytesBase64Encoded: args.imageBase64,
      mimeType: args.imageMimeType || 'image/png',
    };
  }

  const parameters = {};
  for (const k of ['aspectRatio', 'resolution', 'negativePrompt', 'personGeneration', 'durationSeconds', 'sampleCount']) {
    if (args[k] !== undefined && args[k] !== null) parameters[k] = args[k];
  }

  const body = { instances: [instance] };
  if (Object.keys(parameters).length) body.parameters = parameters;

  return apiJson(`${API_BASE}/models/${model}:predictLongRunning`, apiKey, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function getOperation(apiKey, operationName) {
  if (!operationName) throw new Error('operationName is required');
  return apiJson(`${API_BASE}/${operationName.replace(/^\/+/, '')}`, apiKey);
}

/** The API has shipped more than one response shape, so accept all of them. */
export function extractVideoUris(operation) {
  const r = operation?.response || {};
  const samples =
    r?.generateVideoResponse?.generatedSamples || r?.generatedSamples || r?.generatedVideos || r?.videos || [];
  return samples.map((s) => s?.video?.uri || s?.uri || s?.video?.url).filter(Boolean);
}

export function extractFilterReasons(operation) {
  const r = operation?.response || {};
  const raw = r?.generateVideoResponse?.raiMediaFilteredReasons || r?.raiMediaFilteredReasons || [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Streams a Veo video back to the caller, adding the API key they don't have. */
export async function proxyVideo(apiKey, videoUri) {
  let url = videoUri;
  if (!/^https?:\/\//.test(url)) url = `${API_BASE}/files/${url.replace(/^files\//, '')}:download?alt=media`;
  else if (!url.includes('alt=media')) url += (url.includes('?') ? '&' : '?') + 'alt=media';
  return fetch(url, { headers: { 'x-goog-api-key': apiKey } });
}
