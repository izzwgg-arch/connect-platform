/**
 * Creative Studio tools — what makes the studio a capability of the Coworker
 * rather than a page somebody has to go and find.
 *
 * ⛔ THE SHAPE, AND WHY IT IS THIS SHAPE:
 *
 *  - Names are snake_case because the providers enforce
 *    `^[a-z][a-z0-9_]{0,63}$`. The brief's `creative.generateImage` would be
 *    rejected by both OpenAI and Anthropic before we ever saw it.
 *  - Nothing blocks. A render takes minutes; a chat turn dies at 900 s. So
 *    making something returns a JOB, and `creative_check_job` is polled. The
 *    person can close Loopcom and the work carries on.
 *  - The company is NEVER an argument. It comes from `ctx.tenantId`, which the
 *    engine verified from the portal JWT, and `stripForbiddenArgs` drops any
 *    tenant/user key the model invents before we are called at all.
 *  - Every call goes through the api's internal door, which runs the SAME
 *    service the browser uses: same safety refusal, same quota check, same
 *    brand kit. There is no cheaper path for the agent, on purpose.
 *  - There is no tool that publishes, posts or emails anything. Exporting
 *    produces a file; a person sends it.
 */
import type { ToolContext, ToolSpec } from "./toolRegistry";

export interface CreativeToolDeps {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
}

const MAX_SECONDS = 15;

async function call(
  deps: CreativeToolDeps,
  method: "GET" | "POST",
  path: string,
  payload: Record<string, unknown>,
): Promise<any> {
  const baseUrl = (deps.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  const secret = (deps.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
  if (!secret) return { error: "creative_studio_unavailable", reason: "The studio door is not configured on this server." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 120_000);
  try {
    const url = new URL(baseUrl + path);
    if (method === "GET") {
      for (const [k, v] of Object.entries(payload)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      signal: controller.signal,
      headers: { "x-agent-internal-secret": secret, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify(payload) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A refusal or a spent allowance is an ANSWER, not a crash: the model
      // needs to be able to tell the person why in their own words.
      return { error: body?.error || `http_${res.status}`, reason: body?.reason || body?.message || `The studio refused (${res.status}).` };
    }
    return body;
  } catch (e: any) {
    return { error: "creative_studio_unreachable", reason: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const who = (ctx: ToolContext) => ({ tenantId: ctx.tenantId, userId: ctx.clientUserId || undefined });

export function buildCreativeTools(deps: CreativeToolDeps = {}): ToolSpec[] {
  return [
    {
      name: "creative_studio_context",
      description:
        "What this company's Creative Studio can do right now: their brand kit (colours, fonts, voice, things to avoid), what the studio has learned about their taste, how much of this month's allowance is left, and which kinds of thing can be made. Read this BEFORE offering to make something, so what you promise is what they can actually have.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      minRole: "customer",
      async run(_args, ctx) {
        return call(deps, "GET", "/internal/agent/creative/context", who(ctx));
      },
    },

    {
      name: "creative_make_image",
      description:
        "Make one or more pictures from a description — a product shot, a social graphic, a background, an illustration. Their brand kit and learned preferences are applied automatically, so describe the PICTURE, not the branding. Returns a job; poll creative_check_job until it is done. Refuses, with a reason to pass on, if the request asks for another company's logo or a real named person.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What the picture shows, in plain words." },
          shape: { type: "string", enum: ["1:1", "4:5", "16:9", "9:16", "3:2"], description: "Default 4:5." },
          how_many: { type: "number", description: "1 to 4. Default 2, so they have a choice." },
          look: { type: "string", description: "Optional: photographic, cinematic, product studio, illustration, flat graphic." },
          quality: { type: "string", enum: ["low", "medium", "high"], description: "Default low, which is quick and cheap and usually enough to judge an idea." },
          project_id: { type: "string", description: "Optional: keep it with an existing project." },
          reference_asset_ids: { type: "array", items: { type: "string" }, description: "Optional: up to 4 of their own pictures to stay consistent with." },
        },
        required: ["description"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/generate", {
          ...who(ctx),
          capability: "image.generate",
          request: String(args.description || ""),
          ratio: args.shape ? String(args.shape) : undefined,
          count: args.how_many ? Math.max(1, Math.min(4, Number(args.how_many))) : 2,
          styleHint: args.look ? String(args.look) : undefined,
          quality: args.quality ? String(args.quality) : "low",
          projectId: args.project_id ? String(args.project_id) : undefined,
          referenceAssetIds: Array.isArray(args.reference_asset_ids) ? args.reference_asset_ids.map(String).slice(0, 4) : undefined,
          turnId: ctx.conversationId,
        });
      },
    },

    {
      name: "creative_make_video",
      description:
        "Make one video shot, up to 15 seconds. Longer films are several shots — ask for them one at a time and say so. Video COSTS REAL MONEY, so tell the person the estimate and get a clear yes before calling this. Returns a job; poll creative_check_job. The engine's own clip lengths are hidden: ask for the seconds you want and Loopcom composes it.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "What happens in the shot: subject, setting, light, camera movement." },
          seconds: { type: "number", description: "1 to 15. Default 8." },
          shape: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5"], description: "Default 16:9. Use 9:16 for Status, Reels, TikTok." },
          look: { type: "string", description: "Optional: cinematic, documentary, product, graphic." },
          project_id: { type: "string" },
          first_frame_asset_id: { type: "string", description: "Optional: start from one of their own pictures." },
          shot_id: { type: "string", description: "When this shot came from a storyboard, pass its id. The finished clip then attaches itself to that shot — you do NOT have to edit the storyboard afterwards." },
        },
        required: ["description"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/generate", {
          ...who(ctx),
          capability: "video.generate",
          request: String(args.description || ""),
          seconds: Math.max(1, Math.min(MAX_SECONDS, Number(args.seconds || 8))),
          ratio: args.shape ? String(args.shape) : "16:9",
          styleHint: args.look ? String(args.look) : undefined,
          projectId: args.project_id ? String(args.project_id) : undefined,
          firstFrameAssetId: args.first_frame_asset_id ? String(args.first_frame_asset_id) : undefined,
          shotId: args.shot_id ? String(args.shot_id) : undefined,
          turnId: ctx.conversationId,
        });
      },
    },

    {
      name: "creative_make_voiceover",
      description:
        "Record a voiceover from a script, in one of the Loopcom voices. Keep each call to one or two sentences so a single line can be redone without redoing the rest.",
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "Exactly the words to say." },
          voice: { type: "string", description: "Optional voice id; the default is a warm, unhurried one." },
          project_id: { type: "string" },
        },
        required: ["script"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/generate", {
          ...who(ctx),
          capability: "audio.speech",
          request: String(args.script || ""),
          voiceId: args.voice ? String(args.voice) : undefined,
          projectId: args.project_id ? String(args.project_id) : undefined,
          turnId: ctx.conversationId,
        });
      },
    },

    {
      name: "creative_check_job",
      description:
        "How a piece of work is getting on. It WAITS for up to 20 seconds before answering, so a picture is usually finished by the time it returns. ⛔ Call it at most twice per reply: if it is still rendering after that, tell the person plainly that it is still going and that it will be in their library when it is done — do not keep polling, or you will run out of steps before you can answer them.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        // Waits server-side for up to ~20s, so a picture is usually finished in
        // ONE call and the turn does not run out of steps polling.
        return call(deps, "GET", "/internal/agent/creative/job", { ...who(ctx), jobId: String(args.job_id || ""), waitMs: 20000 });
      },
    },

    {
      name: "creative_stop_job",
      description:
        "Stop something that is still rendering. Say plainly that work the engine has already done is still charged — do not imply a cancel is free.",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/job/cancel", { ...who(ctx), jobId: String(args.job_id || "") });
      },
    },

    {
      name: "creative_create_project",
      description:
        "Start a project to keep a piece of work together — a commercial, a campaign, a set of product shots. Everything made afterwards can be attached to it, and the person can open it later in Creative Studio.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["image", "video", "design", "social", "ad", "flyer", "poster", "presentation", "product", "logo", "custom"] },
          brief: { type: "string", description: "What they asked for, in their own words." },
        },
        required: ["title"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/project", {
          ...who(ctx),
          title: String(args.title || "Untitled"),
          kind: args.kind ? String(args.kind) : "image",
          brief: args.brief ? String(args.brief) : undefined,
        });
      },
    },

    {
      name: "creative_write_storyboard",
      description:
        "Plan a film as shots and save it as the project's storyboard. Write one shot per beat, each with what the camera sees. ⛔ You do NOT work out the seconds — hand over the shots and the total length you are aiming for, and the studio splits it so no shot passes the 15-second engine ceiling. Nothing is rendered and nothing is charged by this; it gives the person something to change before a penny is spent.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          total_seconds: { type: "number", description: "How long the whole film should be." },
          ratio: { type: "string", enum: ["16:9", "9:16", "1:1", "4:5"] },
          shots: {
            type: "array",
            description: "In order. Describe what is SEEN, not the branding — their brand kit is applied for you.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                prompt: { type: "string" },
                seconds: { type: "number", description: "Only if this shot must be a particular length." },
              },
              required: ["prompt"],
              additionalProperties: false,
            },
          },
        },
        required: ["project_id", "shots"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        const shots = Array.isArray(args.shots) ? args.shots : [];
        if (!shots.length) return { error: "no_shots", reason: "A storyboard needs at least one shot." };
        return call(deps, "POST", "/internal/agent/creative/storyboard", {
          ...who(ctx),
          projectId: String(args.project_id || ""),
          totalSeconds: args.total_seconds ? Math.round(Number(args.total_seconds)) : undefined,
          ratio: args.ratio ? String(args.ratio) : undefined,
          shots: shots.slice(0, 24).map((shot: any) => ({
            title: shot?.title ? String(shot.title).slice(0, 120) : undefined,
            prompt: String(shot?.prompt || "").slice(0, 2000),
            seconds: shot?.seconds ? Math.max(1, Math.min(MAX_SECONDS, Math.round(Number(shot.seconds)))) : undefined,
          })),
        });
      },
    },

    {
      name: "creative_assemble_film",
      description:
        "Put the rendered shots together into one cut, in storyboard order. Any voiceover, music or captions already on the film are kept. Shots that have not been rendered yet are skipped rather than left as gaps — the answer tells you how many were skipped, so you can say what is still missing. Free, and instant.",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/assemble", { ...who(ctx), projectId: String(args.project_id || "") });
      },
    },

    {
      name: "creative_render_film",
      description:
        "Render the cut into one finished video: the shots joined, the voiceover and music laid under them, the captions burned in and a .srt saved beside it. This runs on Loopcom's own machines, so it costs nothing per run — but it takes a minute or two, so it returns a job to poll. Call creative_assemble_film first if the shots have changed.",
      parameters: {
        type: "object",
        properties: { project_id: { type: "string" } },
        required: ["project_id"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/render", { ...who(ctx), projectId: String(args.project_id || "") });
      },
    },

    {
      name: "creative_export_file",
      description:
        "Make the file for each place it is going — WhatsApp Status, Instagram Reel or post, Facebook, TikTok, YouTube, YouTube Shorts, a landscape commercial or a square. Video is cropped to fit rather than stretched. ⛔ This does NOT post anything anywhere: it makes files the person downloads and sends themselves.",
      parameters: {
        type: "object",
        properties: {
          asset_id: { type: "string", description: "The finished video or picture to export." },
          presets: {
            type: "array",
            items: { type: "string", enum: ["whatsapp_status", "instagram_reel", "instagram_post", "facebook", "tiktok", "youtube", "youtube_shorts", "landscape", "square"] },
          },
        },
        required: ["asset_id", "presets"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        const presets = (Array.isArray(args.presets) ? args.presets : []).map((p: any) => String(p)).filter(Boolean).slice(0, 9);
        if (!presets.length) return { error: "no_presets", reason: "Say where it is going — each place is its own file." };
        return call(deps, "POST", "/internal/agent/creative/export", { ...who(ctx), assetId: String(args.asset_id || ""), presets });
      },
    },

    {
      name: "creative_list_assets",
      description:
        "What this company already has: pictures, video, logos, uploads. Use it to reuse their real product photos and people instead of inventing new ones, and to find something they are referring to.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["image", "video", "audio", "logo", "doc"] },
          project_id: { type: "string" },
          limit: { type: "number" },
        },
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "GET", "/internal/agent/creative/assets", {
          ...who(ctx),
          kind: args.kind ? String(args.kind) : undefined,
          projectId: args.project_id ? String(args.project_id) : undefined,
          limit: args.limit ? Number(args.limit) : 12,
        });
      },
    },

    {
      name: "creative_inspect_design",
      description:
        "Read a design exactly as it stands right now — every layer, its words, position and size — together with the revision number. ⛔ Always call this immediately before changing a design: the person may have moved something by hand since you last looked.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          type: { type: "string", enum: ["canvas", "timeline", "storyboard"], description: "Default canvas." },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "GET", "/internal/agent/creative/canvas", {
          ...who(ctx),
          projectId: String(args.project_id || ""),
          type: args.type ? String(args.type) : "canvas",
        });
      },
    },

    {
      name: "creative_change_design",
      description:
        "Change a design: move, resize, retype, recolour, replace or delete layers. Pass the revision number you got from creative_inspect_design — if somebody changed the design in the meantime this is REFUSED and you get the current version back, which you should read before trying again. Never guess the revision.",
      parameters: {
        type: "object",
        properties: {
          document_id: { type: "string" },
          base_revision: { type: "number" },
          changes: {
            type: "array",
            description: "Each change: op (set, move, resize, replace, add, delete, reorder), target (the layer id), payload (the new values), summary (a short plain-English note).",
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["add", "set", "move", "resize", "replace", "reorder", "delete"] },
                target: { type: "string" },
                payload: { type: "object", additionalProperties: true },
                summary: { type: "string" },
              },
              required: ["op"],
              additionalProperties: false,
            },
          },
        },
        required: ["document_id", "base_revision", "changes"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/canvas/ops", {
          ...who(ctx),
          documentId: String(args.document_id || ""),
          baseRevision: Number(args.base_revision ?? -1),
          ops: Array.isArray(args.changes) ? args.changes : [],
        });
      },
    },

    {
      name: "creative_remember_preference",
      description:
        "Write down what they liked or disliked about something you made, so the next one is closer without them having to say it again. Use the reason codes when one fits: too_fast, too_slow, wrong_feeling, people_fake, logo_too_big, type_too_big, too_flashy, music_wrong, off_brand, too_busy, more_cinematic, camera_slower.",
      parameters: {
        type: "object",
        properties: {
          subject_type: { type: "string", enum: ["asset", "generation", "project", "design"] },
          subject_id: { type: "string" },
          signal: { type: "string", enum: ["accept", "reject", "regenerate", "edit", "export", "favourite"] },
          reason_codes: { type: "array", items: { type: "string" } },
          project_id: { type: "string" },
        },
        required: ["subject_type", "signal"],
        additionalProperties: false,
      },
      minRole: "customer",
      async run(args, ctx) {
        return call(deps, "POST", "/internal/agent/creative/feedback", {
          ...who(ctx),
          subjectType: String(args.subject_type || "asset"),
          subjectId: args.subject_id ? String(args.subject_id) : undefined,
          signal: String(args.signal || "accept"),
          reasonCodes: Array.isArray(args.reason_codes) ? args.reason_codes.map(String).slice(0, 10) : [],
          projectId: args.project_id ? String(args.project_id) : undefined,
        });
      },
    },
  ];
}

/**
 * What the model is told about the studio. Kept here beside the tools so the
 * promise and the capability cannot drift apart.
 */
export const creativeToolsPrompt = [
  "CREATIVE STUDIO — you can make pictures, video and voiceovers for this company.",
  "Read creative_studio_context first: it gives you their brand, what they like, and what is left of this month's allowance.",
  "Pictures are quick and cheap. VIDEO COSTS REAL MONEY: always say the estimate and get a clear yes before calling creative_make_video.",
  "You may start every shot of an approved storyboard in one go. The studio runs two at a time and the rest WAIT their turn — so say \"they will finish on their own\" only about shots you actually started.",
  "Nothing blocks: making something returns a job. creative_check_job waits up to 20s, so ONE call usually returns the finished picture. ⛔ At most two checks per reply — then tell them it is still rendering rather than polling until you run out of steps.",
  "A single shot is at most 15 seconds. A longer film is several shots: creative_write_storyboard plans them (it works out the split — you do not), then render them one at a time with creative_make_video PASSING shot_id (the clip then attaches itself — never edit the storyboard by hand to attach one), then creative_assemble_film and creative_render_film.",
  "The storyboard costs nothing. Show it and get a yes BEFORE rendering, so they change the plan rather than pay for shots they did not want.",
  "Exporting makes files. It never posts anything anywhere — say so plainly, and tell them where to find the downloads.",
  "Before changing a design, call creative_inspect_design and use the revision it gives you. If a change is refused as stale, read it again — somebody moved something by hand.",
  "When they say what was wrong, call creative_remember_preference so the next one is better without them repeating themselves.",
  "If a request is refused for a trademark or a real person, explain it in their words and offer the version you CAN make.",
].join("\n");
