# ⛔⛔ AGENT HANDOFF — Loopcom reskin mockups: light + dark, matched to the Loop Customer Portal (2026-09-02) — READ FIRST before touching `app/globals.css`, `components/branding/*`, `components/layout/sidebar.tsx`, `app/layout.tsx`, or the `BrandingSettings` model

Full handoff: none yet — the design lives on the canvas below and in memory
[[project-loopcom-repurpose]]. Write `AGENT_HANDOFF_LOOPCOM_RESKIN_<date>.md` when the build starts.

- **Ask:** *"no layout, options, or features should be changed, just the look to match"*
  Loopcom. First draft used the marketing site's palette (dark blue + green, PT Sans +
  Montserrat) and was **rejected**: *"Should match Loopcom … just like Loopcom. light mode
  and dark mode."* Loopcom's own product is the **Loop Customer Portal**
  (portal.loopcommunications.com, a Tailwind app) — that is the reference.
- **Approved canvas (13 artboards):**
  https://claude.ai/code/artifact/23d3619c-a195-49c7-b4fd-b03a1a50b079 — Login, Dashboard,
  Clients, Calls, Messages, Settings, each light + dark, plus a token sheet.
- **Light tokens (map 1:1 onto `--brand-*`):** page bg `#f3f4f6`, surface `#ffffff`, sidebar
  white with border `#e5e7eb`, active nav `#2563eb` on `#eff6ff`, button `#2563eb` / hover
  `#1d4ed8`, link `#2563eb`, text `#111827` / `#6b7280`, border `#e5e7eb`. Font **Source
  Sans 3** (portal uses Source Sans Pro). Logo:
  `loopcommunications.com/wp-content/uploads/2016/05/website-logo-e1408820246883.png`.
- **Dark tokens (designed here — the portal has NO dark mode):** page `#111827`, surface
  `#1f2937`, sidebar `#0b1220`, border `#374151`, active nav `#60a5fa` on
  `rgba(59,130,246,.14)`, button `#2563eb`, link `#60a5fa`, text `#f9fafb` / `#9ca3af`.
  Logo sits on a white plate in dark sidebar/login. Sun/moon toggle in the top bar.
- **Build path (traced, not built):** `BrandingProvider` already writes `--brand-*` vars
  from `BrandingSettings`; `app/globals.css` has an unused `.dark` block; `app/layout.tsx`
  loads Inter via `next/font/google`; the login badge is hard-coded in
  `components/branding/TrimProLogo.tsx`; footer text "TrimPro" + `support@trimprony.com`
  in `components/layout/dashboard-layout.tsx`; `middleware.ts` redirects IP hosts to
  `app.trimprony.com`. ⛔ The Sola/QBO/email templates carry their own colors
  (`email*Color` columns) — reskin those too or they stay TrimPro slate.
- ⏳ **NOT PROVEN:** nothing built; no code changed for the reskin as of 2026-09-17.
