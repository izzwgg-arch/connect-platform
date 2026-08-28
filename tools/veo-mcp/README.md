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

Generation parameters: `prompt` (required), `model`, `negativePrompt`, `aspectRatio`
(`16:9` or `9:16`), `resolution` (`720p` or `1080p`), `durationSeconds`,
`personGeneration`, `sampleCount`, and `imagePath` / `imageBase64` + `imageMimeType`
for image-to-video.

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
