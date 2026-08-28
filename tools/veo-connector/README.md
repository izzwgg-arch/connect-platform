# Google Veo connector for Claude

A remote MCP server that makes Google Veo 3 available inside Claude Design,
Claude, and Claude Desktop as a custom connector. Runs on Cloudflare Workers.

This is the hosted sibling of `tools/veo-mcp`. That one is a local stdio server
for Claude Code; this one is reachable over HTTPS, which is the only thing
claude.ai can talk to.

## Deploy

You need a Cloudflare account. The free Workers tier is enough.

```bash
cd tools/veo-connector
npm install
npx wrangler login

npx wrangler secret put GEMINI_API_KEY    # your Google AI Studio key
npx wrangler secret put AUTH_PASSPHRASE   # what you'll type on the login page
npx wrangler secret put SIGNING_SECRET    # long random string, e.g. openssl rand -hex 32

npx wrangler deploy
```

Deploy prints a URL like `https://veo-connector.<subdomain>.workers.dev`.

## Add it to Claude

Go to **Customize > Connectors**, click **+**, choose **Add custom connector**,
and paste the deploy URL with `/mcp` on the end:

```
https://veo-connector.<subdomain>.workers.dev/mcp
```

Claude registers itself automatically and sends you to a login page. Enter the
passphrase you set above. Then enable the connector in whichever conversation
you want it, Claude Design included.

Team and Enterprise owners add connectors under **Organization settings >
Connectors** instead.

## Tools

| Tool | What it does |
| --- | --- |
| `veo_list_models` | Lists the Veo models the key can use |
| `veo_generate_video` | Generates a video and returns a playable URL |
| `veo_get_operation` | Polls a generation that had not finished yet |

Generation parameters: `prompt` (required), `model`, `negativePrompt`,
`aspectRatio`, `resolution`, `durationSeconds`, `personGeneration`,
`sampleCount`, and `imageBase64` + `imageMimeType` for image-to-video.

## How it works

**Auth.** claude.ai drives connectors through OAuth and has no bearer-token
field, so the Worker implements OAuth 2.1 with Dynamic Client Registration.
Every token is an HMAC-signed blob rather than a stored record, so there is no
KV namespace to create and nothing to clean up. The only human step is the
passphrase.

**Video delivery.** Google's video URIs need an API key header, which a browser
cannot supply. Finished videos come back as signed URLs on the Worker itself,
which streams the file through with the key attached. Signatures are checked and
the URLs expire after two days, matching how long Google keeps the file.

**Long runs.** claude.ai gives a tool call 300 seconds. `veo_generate_video`
waits up to 150 of those, then returns an `operationName` so the model can poll
`veo_get_operation` instead of timing out. Most runs finish in well under a
minute.

## Cost and safety

Veo bills per second of generated video, so anyone who can authenticate can
spend money. Use a real passphrase, not a guessable one, and treat
`SIGNING_SECRET` like a private key: anyone holding it can mint access tokens.

Rotate either by running `wrangler secret put` again. Changing `SIGNING_SECRET`
invalidates all existing sessions and video URLs.

## Local testing

```bash
cp .dev.vars.example .dev.vars   # fill in, gitignored
npx wrangler dev --local
```
