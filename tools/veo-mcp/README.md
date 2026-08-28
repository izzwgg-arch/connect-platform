# Google Veo MCP server

A zero-dependency [MCP](https://modelcontextprotocol.io) server that exposes Google's
Veo video generation models through the Gemini API. Runs on plain Node 18+ over stdio,
so there is nothing to install and no third-party package in the supply chain.

## Setup

The API key is read, in order, from `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
`GOOGLE_GENAI_API_KEY`, then from `tools/veo-mcp/.env`. That `.env` is gitignored, so
the key never lands in the repository.

```bash
cp tools/veo-mcp/.env.example tools/veo-mcp/.env
# then fill in GEMINI_API_KEY=...
```

Keys come from https://aistudio.google.com/apikey. Veo is a paid model, so the key
needs billing enabled on its Google Cloud project.

The server is registered for this repository in `.mcp.json` at the root. Claude Code
reads that file at startup, so a new session picks the server up automatically.

## Tools

| Tool | What it does |
| --- | --- |
| `veo_list_models` | Lists the Veo models the key can actually call |
| `veo_generate_video` | Generates a video and waits for it, optionally saving to disk |
| `veo_start_generation` | Starts a generation and returns immediately with an operation name |
| `veo_get_operation` | Polls a long-running operation and returns video URIs once done |
| `veo_download_video` | Downloads a video URI to a local file |
| `veo_list_profiles` | Lists saved render profiles and their defaults |
| `veo_estimate_cost` | What a render would cost, before you run it |
| `veo_recover_operations` | Finds renders you paid for but never collected |

Generation parameters: `prompt` (required), `model`, `negativePrompt`, `aspectRatio`
(`16:9` or `9:16`), `resolution` (`720p` or `1080p`), `durationSeconds`,
`personGeneration`, `sampleCount`, `seed`, `dryRun`, `imagePath` / `imageBase64` +
`imageMimeType` for image-to-video, and `lastFramePath` / `lastFrameBase64` +
`lastFrameMimeType` to land the clip on a frame you have already approved.

## Profiles

A profile is a saved set of house defaults so brand rules cannot be forgotten.
Pass `profile: "loopcom"` and the call inherits the aspect ratio, duration,
resolution, style block and negative prompt. Anything you pass explicitly still
wins, so a profile constrains without trapping you.

`stage` picks the tier: `draft` (lite), `review` (fast), `final` (standard).
It defaults to `draft`, so the expensive tier is opt-in rather than accidental.

```json
{ "profile": "loopcom", "stage": "draft", "prompt": "A voicemail waveform dissolving into particles." }
```

Profiles live in `profiles/*.json`. `tools/veo-mcp/profiles/loopcom.json` is the
worked example: telecom motion graphics, no people, no rendered text, brand
palette locked.

Note the inversion in that profile. Suppressing text in the negative prompt is
what dropped a word from an earlier LOOPCOM render. Once typography moves to
post, that same suppression becomes the desired behavior, and the style block
asks for clean space where the words will go.

## Not wasting money

Veo bills per second of generated video, and the model tier is an eight-fold
swing at the same resolution:

| Model | 720p | 1080p |
| --- | --- | --- |
| `veo-3.1-generate-preview` | $0.40/s | $0.40/s |
| `veo-3.1-fast-generate-preview` | $0.10/s | $0.12/s |
| `veo-3.1-lite-generate-preview` | $0.05/s | $0.08/s |

Four habits, in order of what they save:

1. **Block on lite, finish on standard.** An 8-second standard render is $3.20;
   the same shot on lite is $0.40. Get the composition right at $0.40.
2. **Pass `dryRun: true` first.** It validates the request and prints the cost
   without generating. Free.
3. **Hold a `seed` while iterating.** Without one, every retry re-rolls
   everything and you cannot tell whether your prompt edit helped or the dice
   did. It is not fully deterministic, but it is the difference between an
   experiment and a guess.
4. **Never re-run a timed-out call.** The operation name is written to the
   ledger before the wait begins, so `veo_recover_operations` will find it and
   `veo_get_operation` will hand you the video you already paid for.

Every render appends to `.ledger.jsonl` (gitignored, override with
`VEO_LEDGER_PATH`). It carries the model, duration, seed, and estimated cost of
each run, which is what you need to compute cost per accepted second rather than
cost per render.

Do not ask Veo to render on-screen text for a client deliverable. Generate the
motion and composite typography in your editor, where spelling and timing are
exact instead of probabilistic.

## Notes

- Runs take roughly 30 seconds to 6 minutes. `veo_generate_video` polls for you and
  defaults to a 10-minute budget; past that it returns the operation name so you can
  keep polling with `veo_get_operation`.
- Video download URIs expire after about two days, so save anything worth keeping.
- Safety filtering comes back as a successful operation with no samples. The
  `filteredReasons` field in the response explains why.
- Veo billing is per second of generated video. Every successful call costs money.

## Manual check

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"veo_list_models","arguments":{}}}' \
  | node tools/veo-mcp/server.mjs
```
