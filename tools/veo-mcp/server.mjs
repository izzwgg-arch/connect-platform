#!/usr/bin/env node
// MCP server exposing Google Veo video generation (Gemini API) over stdio.
// Speaks JSON-RPC 2.0 as newline-delimited JSON, so it needs no dependencies.

import {
  DEFAULT_MODEL,
  PRICING,
  applyProfile,
  downloadVideo,
  estimateCost,
  ledgerRead,
  listProfiles,
  extractFilterReasons,
  extractVideoUris,
  generateAndWait,
  getApiKey,
  getOperation,
  listVeoModels,
  startGeneration,
} from './veo-client.mjs';

const SERVER_INFO = { name: 'google-veo', title: 'Google Veo', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const GENERATION_PROPS = {
  prompt: {
    type: 'string',
    description:
      'What the video should show. Veo follows detailed prompts well: name the subject, action, camera move, lighting and style. Audio and dialogue can be described too.',
  },
  model: {
    type: 'string',
    description: `Veo model id. Defaults to ${DEFAULT_MODEL}. Call veo_list_models for what this key can use.`,
  },
  negativePrompt: { type: 'string', description: 'What to keep out of the video.' },
  aspectRatio: { type: 'string', enum: ['16:9', '9:16'], description: 'Frame aspect ratio.' },
  resolution: { type: 'string', enum: ['720p', '1080p'], description: 'Output resolution.' },
  durationSeconds: { type: 'integer', description: 'Clip length in seconds, when the model allows it.' },
  personGeneration: {
    type: 'string',
    enum: ['allow_all', 'allow_adult', 'dont_allow'],
    description: 'Policy for generating people. Availability varies by region.',
  },
  sampleCount: { type: 'integer', description: 'How many videos to generate (default 1).' },
  imagePath: {
    type: 'string',
    description: 'Local image file to animate, for image-to-video. Absolute or relative to the working directory.',
  },
  imageBase64: { type: 'string', description: 'Base64 image bytes, as an alternative to imagePath.' },
  imageMimeType: { type: 'string', description: 'Mime type for imageBase64, e.g. image/png.' },
  lastFramePath: {
    type: 'string',
    description: 'Local image to use as the final frame, so the clip lands on a composition you already approved.',
  },
  lastFrameBase64: { type: 'string', description: 'Base64 final-frame image, as an alternative to lastFramePath.' },
  lastFrameMimeType: { type: 'string', description: 'Mime type for lastFrameBase64.' },
  seed: {
    type: 'integer',
    description:
      'Holds most of the generation steady between runs. Not fully deterministic, but it lets a prompt edit be read as a real change instead of a fresh roll. Reuse the same seed while iterating.',
  },
  dryRun: {
    type: 'boolean',
    description: 'Validate the request and return the cost estimate without generating anything. Costs nothing.',
  },
  profile: {
    type: 'string',
    description:
      'A saved render profile, e.g. "loopcom". It fills in aspect ratio, duration, resolution, the house style block and the house negative prompt, so none of them can be forgotten. Anything you pass explicitly still wins.',
  },
  stage: {
    type: 'string',
    enum: ['draft', 'review', 'final'],
    description:
      'Which tier of the profile to render on. Defaults to draft, the cheapest. Only move to final once the composition is approved.',
  },
};

const TOOLS = [
  {
    name: 'veo_list_models',
    description:
      'List the Google Veo video models the configured Gemini API key can call, with their supported methods.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'veo_generate_video',
    description:
      'Generate a video with Google Veo and wait for it to finish, optionally saving it to disk. A run usually takes one to six minutes. Returns the download URIs and the saved paths.',
    inputSchema: {
      type: 'object',
      properties: {
        ...GENERATION_PROPS,
        outputPath: {
          type: 'string',
          description:
            'Where to save the finished .mp4. Omit to get back only the download URI. Multiple samples get a numeric suffix.',
        },
        timeoutSeconds: {
          type: 'integer',
          description: 'How long to wait before giving up and returning the operation name (default 600).',
        },
        pollIntervalSeconds: { type: 'integer', description: 'Seconds between status checks (default 10).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'veo_start_generation',
    description:
      'Start a Veo generation and return immediately with the long-running operation name. Use this instead of veo_generate_video when you do not want to block. Poll with veo_get_operation.',
    inputSchema: {
      type: 'object',
      properties: GENERATION_PROPS,
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'veo_get_operation',
    description:
      'Check a Veo long-running operation. Returns whether it is done and, once it is, the video download URIs.',
    inputSchema: {
      type: 'object',
      properties: {
        operationName: {
          type: 'string',
          description: 'The operation name returned by veo_start_generation, e.g. models/veo-3.1-.../operations/abc123.',
        },
      },
      required: ['operationName'],
      additionalProperties: false,
    },
  },
  {
    name: 'veo_list_profiles',
    description:
      'List saved render profiles and the defaults each one applies. Use a profile instead of restating brand rules on every call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'veo_estimate_cost',
    description:
      'What a generation would cost in USD, before running it. Veo bills per second of output, so duration and sample count multiply directly.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        resolution: { type: 'string', enum: ['720p', '1080p', '4k'] },
        durationSeconds: { type: 'integer' },
        sampleCount: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'veo_recover_operations',
    description:
      'List recent generations from the local ledger, flagging any that were started but never recorded as finished. Use this after a client timeout to reclaim a render you already paid for instead of running it again.',
    inputSchema: {
      type: 'object',
      properties: {
        unresolvedOnly: { type: 'boolean', description: 'Only show renders with no finish recorded (default true).' },
        limit: { type: 'integer', description: 'How many to return (default 20).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'veo_download_video',
    description: 'Download a generated video URI to a local file. Veo URIs expire after about two days.',
    inputSchema: {
      type: 'object',
      properties: {
        videoUri: { type: 'string', description: 'The video URI from a completed operation.' },
        outputPath: { type: 'string', description: 'Local path to write the .mp4 to.' },
      },
      required: ['videoUri', 'outputPath'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, rawArgs = {}) {
  // Profiles resolve first, so cost estimates and ledger entries describe the
  // request that will actually be sent rather than the one that was typed.
  const args = ['veo_generate_video', 'veo_start_generation'].includes(name) ? applyProfile(rawArgs) : rawArgs;

  switch (name) {
    case 'veo_list_profiles':
      return { profiles: listProfiles() };

    case 'veo_list_models':
      return { models: await listVeoModels(), pricingUsdPerSecond: PRICING };

    case 'veo_estimate_cost':
      return estimateCost(args);

    case 'veo_recover_operations': {
      const entries = ledgerRead();
      const finished = new Set(entries.filter((e) => e.event === 'finished').map((e) => e.operationName));
      const started = entries.filter((e) => e.event === 'started');
      const unresolvedOnly = args.unresolvedOnly !== false;
      const rows = started
        .filter((e) => (unresolvedOnly ? !finished.has(e.operationName) : true))
        .slice(-(args.limit || 20))
        .reverse()
        .map((e) => ({ ...e, finished: finished.has(e.operationName) }));
      const spent = started.reduce((sum, e) => sum + (e.estimate?.usd || 0), 0);
      return {
        operations: rows,
        totalRendersStarted: started.length,
        estimatedSpendUsd: Number(spent.toFixed(2)),
        note: rows.length
          ? 'Pass an operationName to veo_get_operation to retrieve a render you already paid for.'
          : 'Nothing unresolved.',
      };
    }

    case 'veo_generate_video': {
      const cost = estimateCost(args);
      if (args.dryRun) return { dryRun: true, wouldCost: cost, note: 'Nothing was generated.' };
      const result = await generateAndWait(args);
      return { ...result, cost };
    }

    case 'veo_start_generation': {
      const cost = estimateCost(args);
      if (args.dryRun) return { dryRun: true, wouldCost: cost, note: 'Nothing was generated.' };
      const op = await startGeneration(args);
      return {
        operationName: op.name,
        done: Boolean(op.done),
        cost,
        note: 'Poll veo_get_operation with this operationName. Generation usually takes one to six minutes.',
      };
    }

    case 'veo_get_operation': {
      const op = await getOperation(args.operationName);
      const out = { operationName: op.name, done: Boolean(op.done) };
      if (op.error) out.error = op.error;
      if (op.done) {
        out.videoUris = extractVideoUris(op);
        const filtered = extractFilterReasons(op);
        if (filtered.length) out.filteredReasons = filtered;
      }
      return out;
    }

    case 'veo_download_video':
      return downloadVideo(args.videoUri, args.outputPath);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- JSON-RPC plumbing -----------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(request) {
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Generates video with Google Veo through the Gemini API. Start with veo_list_models to see what the key allows. veo_generate_video does the whole run and waits; veo_start_generation plus veo_get_operation is the non-blocking path.',
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;

      case 'ping':
        return reply(id, {});

      case 'tools/list':
        return reply(id, { tools: TOOLS });

      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments || {});
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }

      case 'resources/list':
        return reply(id, { resources: [] });

      case 'prompts/list':
        return reply(id, { prompts: [] });

      default:
        if (isNotification) return;
        return replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err?.message || String(err);
    if (isNotification) {
      process.stderr.write(`veo-mcp: ${message}\n`);
      return;
    }
    if (method === 'tools/call') {
      return reply(id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
    }
    return replyError(id, -32603, message);
  }
}

let buffer = '';
let pending = 0;
let stdinClosed = false;

function track(promise) {
  pending += 1;
  promise.finally(() => {
    pending -= 1;
    if (stdinClosed && pending === 0) process.exit(0);
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      replyError(null, -32700, 'Parse error');
      continue;
    }
    if (Array.isArray(request)) {
      request.forEach((r) => track(handle(r)));
    } else {
      track(handle(request));
    }
  }
});

// Let in-flight requests finish before shutting down.
process.stdin.on('end', () => {
  stdinClosed = true;
  if (pending === 0) process.exit(0);
});

// Fail loudly at startup rather than on the first tool call.
try {
  getApiKey();
} catch (err) {
  process.stderr.write(`veo-mcp: ${err.message}\n`);
}
