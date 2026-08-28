// Google Veo as a remote MCP connector for claude.ai (Claude Design, Claude, Desktop).
//
// Speaks Streamable HTTP MCP at /mcp behind OAuth 2.1 with Dynamic Client
// Registration, which is what claude.ai's connector UI drives. Finished videos
// come back as signed public URLs on this same Worker, because the raw Google
// URIs need an API key header that the browser cannot supply.

import { b64url, json, sha256, sign, timingSafeEqual, verify } from './oauth.js';
import {
  DEFAULT_MODEL,
  extractFilterReasons,
  extractVideoUris,
  getOperation,
  listVeoModels,
  proxyVideo,
  startGeneration,
} from './veo.js';

const SERVER_INFO = { name: 'google-veo', title: 'Google Veo', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ACCESS_TTL = 3600;
const REFRESH_TTL = 60 * 60 * 24 * 30;
const CODE_TTL = 300;
const VIDEO_TTL = 60 * 60 * 24 * 2; // matches how long Google keeps the file

// claude.ai gives a tool call 300s. Stay well inside it, then hand back an
// operation name so the model can keep polling instead of timing out.
const INLINE_WAIT_MS = 150_000;
const POLL_INTERVAL_MS = 10_000;

const GENERATION_PROPS = {
  prompt: {
    type: 'string',
    description:
      'What the video should show. Veo rewards detail: name the subject, the action, the camera move, the lighting and the style. Dialogue and sound can be described too.',
  },
  model: { type: 'string', description: `Veo model id. Defaults to ${DEFAULT_MODEL}.` },
  negativePrompt: { type: 'string', description: 'What to keep out of the video.' },
  aspectRatio: { type: 'string', enum: ['16:9', '9:16'], description: 'Frame aspect ratio.' },
  resolution: { type: 'string', enum: ['720p', '1080p'], description: 'Output resolution.' },
  durationSeconds: { type: 'integer', description: 'Clip length in seconds, where the model allows it.' },
  personGeneration: { type: 'string', enum: ['allow_all', 'allow_adult', 'dont_allow'] },
  sampleCount: { type: 'integer', description: 'How many videos to generate (default 1).' },
  imageBase64: { type: 'string', description: 'Base64 source image, for image-to-video.' },
  imageMimeType: { type: 'string', description: 'Mime type for imageBase64, e.g. image/png.' },
};

const TOOLS = [
  {
    name: 'veo_list_models',
    description: 'List the Google Veo video models this connector can use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'veo_generate_video',
    description:
      'Generate a video with Google Veo and wait for it. Returns a playable URL. If the run is slow it returns an operationName instead; poll that with veo_get_operation.',
    inputSchema: { type: 'object', properties: GENERATION_PROPS, required: ['prompt'], additionalProperties: false },
  },
  {
    name: 'veo_get_operation',
    description: 'Check a Veo generation that has not finished yet, and get its playable URL once it has.',
    inputSchema: {
      type: 'object',
      properties: { operationName: { type: 'string', description: 'From a previous veo_generate_video call.' } },
      required: ['operationName'],
      additionalProperties: false,
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wraps a Google video URI in a signed, expiring URL served by this Worker. */
async function playableUrl(uri, env, origin) {
  const token = await sign({ uri, exp: Math.floor(Date.now() / 1000) + VIDEO_TTL }, env.SIGNING_SECRET);
  return `${origin}/v/${token}`;
}

async function finishedResult(op, env, origin) {
  const uris = extractVideoUris(op);
  const out = { operationName: op.name, done: true, videos: [] };
  for (const uri of uris) out.videos.push(await playableUrl(uri, env, origin));
  const filtered = extractFilterReasons(op);
  if (filtered.length) out.filteredReasons = filtered;
  if (!uris.length && !filtered.length) out.note = 'Generation finished but returned no video.';
  return out;
}

async function callTool(name, args, env, origin) {
  const apiKey = env.GEMINI_API_KEY;

  if (name === 'veo_list_models') return { models: await listVeoModels(apiKey) };

  if (name === 'veo_get_operation') {
    const op = await getOperation(apiKey, args.operationName);
    if (op.error) throw new Error(op.error.message || JSON.stringify(op.error));
    if (!op.done) return { operationName: op.name, done: false, note: 'Still generating. Poll again shortly.' };
    return finishedResult(op, env, origin);
  }

  if (name === 'veo_generate_video') {
    const started = Date.now();
    const op = await startGeneration(apiKey, args);
    let current = op;
    while (!current.done && Date.now() - started < INLINE_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS);
      current = await getOperation(apiKey, op.name);
    }
    if (current.error) throw new Error(current.error.message || JSON.stringify(current.error));
    if (!current.done) {
      return {
        operationName: op.name,
        done: false,
        note: 'Still generating. Call veo_get_operation with this operationName in a minute.',
      };
    }
    return finishedResult(current, env, origin);
  }

  throw new Error(`Unknown tool: ${name}`);
}

// --- MCP over Streamable HTTP ----------------------------------------------

async function handleRpc(request, env, origin) {
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Generates video with Google Veo 3. veo_generate_video returns a playable URL; if it reports done:false, poll veo_get_operation with the operationName it gave you.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'resources/list':
        return ok({ resources: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments || {}, env, origin);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      }
      default:
        if (isNotification || method?.startsWith('notifications/')) return null;
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (err) {
    const message = err?.message || String(err);
    if (isNotification) return null;
    if (method === 'tools/call') return ok({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
    return { jsonrpc: '2.0', id, error: { code: -32603, message } };
  }
}

async function handleMcp(req, env, url) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }

  const auth = req.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const claims = token ? await verify(token, env.SIGNING_SECRET) : null;
  if (!claims || claims.t !== 'access') {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((r) => handleRpc(r, env, url.origin)))).filter(Boolean);
    return responses.length ? json(responses) : new Response(null, { status: 202 });
  }
  const response = await handleRpc(body, env, url.origin);
  return response ? json(response) : new Response(null, { status: 202 });
}

// --- OAuth ------------------------------------------------------------------

function loginPage(url, error) {
  const params = [...url.searchParams.entries()]
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('');
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Google Veo</title>
<style>
:root{color-scheme:light dark}
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafaf9;color:#1c1917}
@media(prefers-color-scheme:dark){body{background:#1c1917;color:#fafaf9}}
form{width:min(360px,90vw);display:grid;gap:14px}
h1{font-size:1.15rem;margin:0}
p{margin:0;opacity:.7;font-size:.875rem;line-height:1.5}
input[type=password]{padding:.6rem .7rem;font-size:1rem;border:1px solid #a8a29e;border-radius:8px;background:transparent;color:inherit}
button{padding:.6rem;font-size:1rem;border:0;border-radius:8px;background:#1c1917;color:#fafaf9;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#fafaf9;color:#1c1917}}
.err{color:#b91c1c}
@media(prefers-color-scheme:dark){.err{color:#fca5a5}}
</style>
<form method="post">
<h1>Connect Google Veo</h1>
<p>Enter the passphrase you set when deploying this connector.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
${params}
<input type="password" name="passphrase" placeholder="Passphrase" autofocus required>
<button type="submit">Authorize</button>
</form>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function handleAuthorize(req, env, url) {
  const p = url.searchParams;
  const redirectUri = p.get('redirect_uri');
  if (!redirectUri) return json({ error: 'invalid_request', error_description: 'redirect_uri required' }, 400);

  // client_id is itself a signed blob, so the allowed redirect_uris travel with it.
  const client = await verify(p.get('client_id') || '', env.SIGNING_SECRET);
  if (!client || client.t !== 'client') return json({ error: 'invalid_client' }, 400);
  if (!client.redirect_uris.includes(redirectUri)) {
    return json({ error: 'invalid_request', error_description: 'redirect_uri not registered' }, 400);
  }

  if (req.method === 'GET') return loginPage(url);

  const form = await req.formData();
  if (!timingSafeEqual(form.get('passphrase') || '', env.AUTH_PASSPHRASE)) {
    return loginPage(url, 'That passphrase did not match.');
  }

  const code = await sign(
    {
      t: 'code',
      exp: Math.floor(Date.now() / 1000) + CODE_TTL,
      redirect_uri: redirectUri,
      challenge: p.get('code_challenge') || null,
      method: p.get('code_challenge_method') || 'plain',
    },
    env.SIGNING_SECRET
  );

  const to = new URL(redirectUri);
  to.searchParams.set('code', code);
  if (p.get('state')) to.searchParams.set('state', p.get('state'));
  return Response.redirect(to.toString(), 302);
}

async function issueTokens(env) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: await sign({ t: 'access', exp: now + ACCESS_TTL }, env.SIGNING_SECRET),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: await sign({ t: 'refresh', exp: now + REFRESH_TTL }, env.SIGNING_SECRET),
  };
}

async function handleToken(req, env) {
  if (req.method !== 'POST') return json({ error: 'invalid_request' }, 405);
  const form = await req.formData();
  const grant = form.get('grant_type');

  if (grant === 'refresh_token') {
    const claims = await verify(form.get('refresh_token') || '', env.SIGNING_SECRET);
    if (!claims || claims.t !== 'refresh') return json({ error: 'invalid_grant' }, 400);
    return json(await issueTokens(env));
  }

  if (grant !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400);

  const claims = await verify(form.get('code') || '', env.SIGNING_SECRET);
  if (!claims || claims.t !== 'code') return json({ error: 'invalid_grant' }, 400);
  if (claims.redirect_uri !== form.get('redirect_uri')) return json({ error: 'invalid_grant' }, 400);

  if (claims.challenge) {
    const verifier = form.get('code_verifier') || '';
    const presented = claims.method === 'S256' ? b64url(await sha256(verifier)) : verifier;
    if (!timingSafeEqual(presented, claims.challenge)) {
      return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }
  }

  return json(await issueTokens(env));
}

async function handleRegister(req, env) {
  if (req.method !== 'POST') return json({ error: 'invalid_request' }, 405);
  const body = await req.json().catch(() => ({}));
  const redirect_uris = body.redirect_uris || [];
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
    return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris required' }, 400);
  }
  const client_id = await sign({ t: 'client', redirect_uris }, env.SIGNING_SECRET);
  return json(
    {
      client_id,
      client_name: body.client_name || 'Claude',
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201
  );
}

// --- Router -----------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const missing = ['GEMINI_API_KEY', 'AUTH_PASSPHRASE', 'SIGNING_SECRET'].filter((k) => !env[k]);
    if (missing.length) return json({ error: `Worker is missing secrets: ${missing.join(', ')}` }, 500);

    switch (url.pathname) {
      case '/.well-known/oauth-authorization-server':
      case '/.well-known/openid-configuration':
        return json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          registration_endpoint: `${url.origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256', 'plain'],
          token_endpoint_auth_methods_supported: ['none'],
        });

      case '/.well-known/oauth-protected-resource':
        return json({ resource: url.origin, authorization_servers: [url.origin] });

      case '/register':
        return handleRegister(req, env);
      case '/authorize':
        return handleAuthorize(req, env, url);
      case '/token':
        return handleToken(req, env);
      case '/mcp':
        return handleMcp(req, env, url);
      case '/':
        return new Response('Google Veo MCP connector. Add /mcp to Claude as a custom connector.', {
          headers: { 'content-type': 'text/plain' },
        });
    }

    if (url.pathname.startsWith('/v/')) {
      const claims = await verify(url.pathname.slice(3), env.SIGNING_SECRET);
      if (!claims?.uri) return new Response('Not found', { status: 404 });
      const upstream = await proxyVideo(env.GEMINI_API_KEY, claims.uri);
      if (!upstream.ok) return new Response('Video unavailable', { status: 502 });
      return new Response(upstream.body, {
        headers: {
          'content-type': upstream.headers.get('content-type') || 'video/mp4',
          'cache-control': 'public, max-age=3600',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
