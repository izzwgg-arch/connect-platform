# Branding Audit — TrimPro → LoopCom Works
Scope: `C:\dev\projects\Connect 2\Loopcom works\`
Method: `git grep` / ripgrep, case-insensitive, patterns `trimpro`, `trim pro`, `trim-pro`, `trim_pro`, `trimprony`, `@trimprony.com`, `app.trimprony.com`.
Excluded per instructions: `node_modules`, `.next`, `.git`, `*.tgz/*.tar/*.tar.gz/*.apk/*.log/*.txt`, `tsconfig.tsbuildinfo`, `package-lock.json`, `proof-pdfs/`, legacy root status `*.md` (counted only).

## Summary counts

- **Total matching lines (case-insensitive, tracked files, exclusions applied):** 787, across **211 files**.
- **Customer-facing:** ~230 lines (emails, PDFs, public pages, auth pages, dashboard admin-facing copy, mobile app strings/app.json, manifest, metadata, branding components/assets).
- **Internal-safe:** ~500 lines (deploy scripts, nginx configs, diagnostic/seed scripts, code comments, Prisma schema comments, dev-only routes, legacy status docs, project meta docs).
- **Internal-but-visible-in-devtools:** ~55 lines (localStorage/cache keys, deep-link URL schemes, `User-Agent` header strings, one API JSON field name, one webhook-verify-token default).
- Two support-email domains are hardcoded inconsistently: `support@trimprony.com` (most templates) vs `support@trimpro.app` (estimate-approval only) — flag for Izzy, pick one.
- The **PDF fallback logo is a generated SVG with the literal text "TrimPro" burned into it** (`lib/branding/pdf.ts:43`) — this fires for any tenant with no logo configured, so renaming `DEFAULT_BUSINESS_NAME` alone is not enough; the SVG string must change too. A second, lower-priority "trimpro" fallback exists in `lib/documents/pdf-templates.ts:198,706` (a plain-text `<div>` shown only if `brand.logoUrl` is somehow empty, which `getPdfBranding()` normally prevents).
- Branding IS data-driven where it matters most (emails, PDFs) via `BrandingSettings` + `getEmailBranding()` / `getPdfBranding()` — the hardcoded "TrimPro"/"Trim Pro" strings found below are **fallback defaults**, used only when a tenant hasn't configured `invoiceBusinessName` / branding `companyName`. That still means every un-configured tenant (very possibly all of them today) sees "TrimPro" live.
- The app base URL (`https://app.trimprony.com`) is hardcoded directly (bypassing `lib/public-url.ts`'s env-var-aware helper) in **~30 call sites** across `app/api/**`, `lib/**`, `scripts/**`, mobile app. A domain cutover requires editing all of them individually, not just `lib/public-url.ts`.
- `mobile-app/` (root-level, distinct from `apps/mobile/`) is an **orphaned generic Expo scaffold** — `name`/`slug` = `"mobile-app"`, not TrimPro-branded, referenced nowhere else in the repo except 2 legacy status docs. Not part of the shipped product; noted but out of active scope.

---

## Classified table

Legend: **CF** = customer-facing, **IS** = internal-safe, **DT** = internal-but-visible-in-devtools.

### A. Branding components & resolvers (drive most of the UI)

| path:line | snippet | class | proposed replacement |
|---|---|---|---|
| `components/branding/TrimProLogo.tsx:7,12,15,16,25,26,29,43,44,57,59,64,92,94,113` | component names `TrimProIcon`/`TrimProMark`/`TrimProLogo`/`TrimProLoginBadge`; `alt="TrimPro"` (×2); visible text `trimpro` (login badge, line 57); `src="/branding/trimpro-icon.svg"`, `DEFAULT_LOGO='/branding/trimpro-logo.svg'` | Mixed: component/function **names** = IS; `alt="TrimPro"` (16,113) and rendered text `trimpro` (57) = **CF** | Rename component file/exports only if Izzy wants (risk: many importers — see Sidebar/auth pages below); at minimum change `alt="TrimPro"` → `alt="LoopCom Works"` and the visible wordmark text on line 57 → `loopcom works` |
| `components/branding/TrimProMark.tsx:3,9,13,14,22` | interface/function names; `alt="TrimPro"`; rendered text `TrimPro` (line 22) | names = IS; `alt`/text = **CF** | `alt="LoopCom Works"`, wordmark text → `LoopCom Works` |
| `components/branding/BrandingProvider.tsx:139` | `const BRANDING_CACHE_KEY = 'trimpro_branding_cache'` | **DT** (localStorage key, not rendered) | safe to leave, or rename to `loopcom_branding_cache` while also clearing old cached key |
| `lib/branding/pdf.ts:30` | `const DEFAULT_BUSINESS_NAME = 'Trim Pro'` | **CF** (fallback name shown on every invoice/estimate/PO/credit-memo PDF header for a tenant with no `invoiceBusinessName` set) | `'LoopCom Works'` |
| `lib/branding/pdf.ts:43` | `<text ...>TrimPro</text>` inside `buildDefaultLogoDataUri()` — literal brand text rasterized into the **fallback logo image** | **CF — high priority**, easy to miss (it's a generated SVG string, not a static asset) | change the literal text to `LoopCom Works` (and consider re-checking the font-size/kerning fits the longer string) |
| `lib/email/branding.ts:10` | `'https://app.trimprony.com'` fallback in `getPublicAppUrl()` | **CF** (used to build absolute asset/link URLs embedded in outbound email) | update alongside domain cutover (see Domains section) |
| `lib/email/embed-logo.ts:23` | same fallback pattern | **CF** | same |
| `lib/documents/pdf-templates.ts:198,706` | `<div class="logo-fallback">trimpro</div>` — only renders if `brand.logoUrl` is falsy | **CF** (defense-in-depth fallback; low likelihood since `getPdfBranding()` always returns a logo) | `loopcom works` (or match final wordmark casing) |
| `lib/documents/pdf-templates.ts:315,500,705,769,814,874,951,1056,1132,1227,1306,1398` | `alt="Trim Pro Logo"` / `logoBlock(brand, 'Trim Pro Logo')`, "official purchase order from Trim Pro", "official credit memo from Trim Pro" | **CF** — alt text isn't visually rendered on the PDF but is embedded in the HTML→PDF source; the two "official ... from Trim Pro" sentences ARE visible body copy on the PO and credit-memo PDFs | alt → `LoopCom Works Logo`; body copy → "official purchase order from LoopCom Works" / "official credit memo from LoopCom Works" |
| `prisma/schema.prisma:3296-…` `model BrandingSettings` | fields: `webLogoUrl`, `faviconUrl`, `mobileAppIconUrl`, `mobileAppSplashLogoUrl`, `invoicePdfTemplateId`, `invoiceStyle`, `invoiceBusinessName`, `invoicePhone`, `invoiceEmail`, `invoiceAddress`, `invoiceFooterText`, `invoiceLogoUrl`, `emailPrimaryColor`, `emailButtonColor`, `emailButtonTextColor`, `emailBackgroundColor`, + 13 UI color fields (`primaryColor` … `dangerColor`) | **IS** — this is the correct per-tenant override surface; no field name itself says "TrimPro". No `businessName`/`companyName`-default column exists in the schema — the `'TrimPro'`/`'Trim Pro'` defaults live in application code (the call sites listed throughout this table), not in the DB. | none needed; this is the mechanism to use, not to rename |

### B. App shell metadata / manifest / favicon (every page, every tab)

| path:line | snippet | class | proposed replacement |
|---|---|---|---|
| `app/layout.tsx:18` | `title: 'Trim Pro - Field Service Management'` | **CF** — browser tab title on every page | `'LoopCom Works - Field Service Management'` |
| `app/layout.tsx:21` | `applicationName: 'Trim Pro'` | **CF** | `'LoopCom Works'` |
| `app/layout.tsx:24` | `appleWebApp.title: 'Trim Pro'` | **CF** — iOS "Add to Home Screen" label | `'LoopCom Works'` |
| `app/layout.tsx:30` | `apple: '/branding/trimpro-icon.svg'` | asset **path** — IS to keep filename, CF in effect (icon itself, see Assets) | keep path or rename asset (optional) |
| `app/layout.tsx:28-29` | `icon`/`shortcut: '/favicon-tp.svg'` | filename references "tp" (TrimPro) but not customer-visible text | optional rename |
| `public/manifest.webmanifest:2` | `"name": "Trim Pro"` | **CF** — PWA install name | `"LoopCom Works"` |
| `public/manifest.webmanifest:3` | `"short_name": "TrimPro"` | **CF** — home-screen icon label | `"LoopCom"` (short_name should stay short) |
| `public/manifest.webmanifest:13` | `"src": "/branding/trimpro-icon.svg"` | asset path | see Assets |

### C. Public (unauthenticated) pages

| path:line | snippet | class | proposed replacement |
|---|---|---|---|
| `app/(public)/layout.tsx:2,14,30` | imports `TrimProLogo`; renders it; footer `© {year} TrimPro` | **CF** | `© {year} LoopCom Works` |
| `app/(public)/download/page.tsx:6,7,10,18,20,29,54,69` | metadata title/description "Download TrimPro Field App/Android"; `APK_PATH='/downloads/trimpro-field.apk'`; H1 "Download TrimPro Field"; body copy ×4 | **CF** — full page is about the Android field app | rename all "TrimPro Field" → "LoopCom Works Field" (or final mobile app name); rename APK file/path if the asset itself is renamed |
| `app/(public)/terms/page.tsx:5,7,19,30,98,100,142,146,147,183,184` | ToS title, meta description, body ("TrimPro", "we", "us"), liability caps ("TRIMPRO WILL NOT BE LIABLE…"), `mailto:support@trimprony.com` ×2 | **CF — legal text, high priority to get right** | replace every "TrimPro" with the correct legal entity name (confirm with Izzy whether "LoopCom Works" or the Loopcom LLC entity name is the contracting party before editing — this is a legal document, not just branding) |
| `app/(public)/privacy/page.tsx:5,7,19,71,169,170` | Privacy Policy title/description/body, `mailto:support@trimprony.com` ×2 | **CF — legal text** | same caution as Terms |
| `app/(public)/pay/invoice/[publicToken]/page.tsx:43` | `{inv.tenant?.name \|\| 'TrimPro'}` | **CF** fallback when tenant has no name set | `'LoopCom Works'` |

### D. Auth pages (login / reset / set / forgot password)

| path:line | snippet | class |
|---|---|---|
| `app/auth/login/page.tsx:10,121` | imports/renders `TrimProLoginBadge` | **CF** |
| `app/auth/reset-password/page.tsx:9,82,104` | imports/renders `TrimProLogo` ×2 | **CF** |
| `app/auth/set-password/page.tsx:9,80` | same | **CF** |
| `app/auth/forgot-password/page.tsx:9,52,74` | same ×2 | **CF** |

All four resolve to the same underlying component text covered in section A; no separate literal strings here — fixing `TrimProLogo`/`TrimProLoginBadge` fixes all four screens.

### E. Dashboard (authenticated) admin-facing copy

| path:line | snippet | class | proposed replacement |
|---|---|---|---|
| `components/layout/sidebar.tsx:6,272,277,404` | imports/renders `TrimProLogo` ×3 (sidebar variant) | **CF** | fixed via section A |
| `components/layout/dashboard-layout.tsx:98,106,107` | footer `© {year} TrimPro`; `mailto:support@trimprony.com` ×2 | **CF** | `© {year} LoopCom Works`; update support email |
| `app/dashboard/help/page.tsx:121` | "Find answers and learn how to use Trim Pro" | **CF** | "...use LoopCom Works" |
| `app/dashboard/calls/page.tsx:236` | "Connect Trim Pro to VitalPBX to make/receive calls..." | **CF** | "Connect LoopCom Works to VitalPBX..." |
| `app/dashboard/settings/integrations/[provider]/page.tsx:245,302,525,1008,1009` | `confirm()` dialogs "...into TrimPro?" ×2; test message "Trim Pro test message"; "Already linked in TrimPro:"; JS field `openInvoicesAlreadyInTrimPro` (read) | 245/302/1008 = **CF**; 525 = **CF** (visible in QuickBooks as a test SMS/message body); 1009 field access = **IS** (mirrors API field name, see G) | reword confirms/labels; field access stays (matches API shape unless API is also renamed) |
| `app/dashboard/settings/integrations/quickbooks/import-estimate/page.tsx:162,209,242` | "already in Trim Pro", "was imported into Trim Pro.", "Trim Pro created a placeholder client" | **CF** | replace |
| `app/dashboard/settings/integrations/quickbooks/import-credit-memo/page.tsx:168,215,253` | same pattern | **CF** | replace |
| `app/dashboard/settings/integrations/page.tsx:149` | "Connect external services to enhance Trim Pro" | **CF** | replace |
| `app/dashboard/settings/email-integrations/page.tsx:260,281` | fallback sender display `noreply@trimpro.com`; input placeholder `"TrimPro Billing"` | **CF** | update placeholder + fallback (see Domains for the email address) |
| `app/dashboard/reports/payments/page.tsx:195` | "This removes it from TrimPro and recalculates the invoice..." | **CF** | replace |
| `app/dashboard/invoices/[id]/page.tsx:934` | same pattern | **CF** | replace |
| `app/dashboard/credit-memos/page.tsx:77` | "Customers must already be mapped in TrimPro" | **CF** | replace |
| `app/dashboard/estimates/page.tsx:85` `ESTIMATES_LIST_KEY = 'trimpro.estimates.listState'` | localStorage key | **DT** | optional rename |
| `app/dashboard/requests/page.tsx:98` `REQUESTS_LIST_KEY = 'trimpro.requests.listState'` | localStorage key | **DT** | optional rename |
| `app/portal/pay/[invoiceId]/page.tsx:822` | "...marked partial in Trim Pro and QuickBooks." | **CF** (customer-facing payment portal, not just staff) | replace |
| `hooks/useListPreferences.ts:10`, `hooks/useResizableColumns.tsx:8` | `trimpro.list.prefs.*`, `trimpro.table.colwidths.*` localStorage key builders | **DT** | optional rename |
| `lib/navigation/nav-stack.ts:9,10` | `trimpro.nav.returnStack`, `trimpro.list.session.` | **DT** | optional |
| `components/lists/TableView.tsx:42,57` | `trimpro.list.prefs.${entity}` | **DT** | optional |
| `components/estimates/estimate-material-list.tsx:110` | `trimpro.list.prefs.estimate-material.*` | **DT** | optional |
| `components/messages/JobThreadDialog.tsx:53` | `trimpro.jobChat.recipients.${jobId}` | **DT** | optional |
| `components/common/document-attachments.tsx:27,46,52`, `components/common/attachment-gallery-dialog.tsx:97,115,121` | hardcoded `https://app.trimprony.com` origin fallback for building absolute attachment URLs | **CF** (the resulting URL is shown/used by the customer) | update with domain cutover |
| `components/calls/VitalPbxSoftphone.tsx:187` | `displayName: config.displayName \|\| 'Trim Pro'` | **CF** — SIP caller-ID display name fallback | `'LoopCom Works'` |

### F. Email templates & samples (`lib/email/**`) — see also section H (email+PDF inventory)

| path:line | snippet | class | proposed replacement |
|---|---|---|---|
| `lib/email/shell.ts:100` | `escapeHtml(opts.companyName \|\| 'TrimPro')` | **CF** | `'LoopCom Works'` |
| `lib/email/templates/estimate-approval.ts:44,45` | `companyName='TrimPro'`, `supportEmail='support@trimpro.app'` | **CF** | note: different domain than every other template — pick one |
| `lib/email/templates/credit-memo.ts:31` | `companyName='TrimPro'` | **CF** | replace |
| `lib/email/templates/invoice.ts:42` | `companyName='TrimPro'` | **CF** | replace |
| `lib/email/templates/statement.ts:30` | `companyName='TrimPro'` | **CF** | replace |
| `lib/email/templates/payment-receipt.ts:66,147,159,173,174` | `companyName='TrimPro'` ×3, `supportEmail='support@trimprony.com'` | **CF** | replace |
| `lib/email/templates/staff-notification.ts:26,30,40,54,59,70` | `companyName='TrimPro'`, "Open TrimPro to review this update.", button "Open in TrimPro", badge "TrimPro Alert", "...enabled on your TrimPro account.", text fallback "Open in TrimPro: {url}" | **CF** — this is the internal-staff notification email, still customer-org-facing (their own staff) | replace all 5 strings |
| `lib/email/templates/purchase-order.ts:20` | comment "matching the TrimPro outbound layout" | **IS** (comment only) | n/a |
| `lib/email/provider.ts:29` | `EMAIL_FROM \|\| EMAIL_FROM_NAME \|\| 'noreply@trimpro.com'` | **CF** — literal outbound From address if env vars unset | see Domains |
| `lib/email/recipients.ts:51` | `ADMIN_CC_EMAIL \|\| 'Trimpronyinc@gmail.com'` | **CF/ops** — real internal ops mailbox hardcoded as a CC default on outbound customer emails | confirm with Izzy whether this Gmail address should still receive CC on every email once rebranded; likely needs a Loopcom-owned address |
| `lib/email/samples/*.html` (7 files, ~40 lines total: `estimate-approval.html`, `invoice.html`, `payment-receipt*.html` ×5, `statement.html`) | static preview/QA fixtures — `<title>`, wordmark blocks, footer "TrimPro Demo", buttons linking to `app.trimprony.com/...` | **IS** — these are dev-only preview fixtures (`scripts/preview-customer-emails.ts` output), never sent to a real customer | low priority; update if kept as living QA fixtures |
| `lib/email/templates/payment-receipt-preview.html:14,66,207,228,257,258,272,273,274` | same pattern, dev preview only | **IS** | same |

### G. PDF/QBO integration code comments & internal strings

| path:line | snippet | class |
|---|---|---|
| `lib/services/qbo-sync.ts` (~25 hits: 17,664,1238,1244,1268,1323,1533,1548,1570,1708,1764,2362,2456,2460,3369,3505,3607,3608,3619,3668,3732,3840,3842,3844,4058,4359) | code comments, internal function name `mapTrimProEstimateStatusToQboTxnStatus`, JS variable `openInvoicesAlreadyInTrimPro`, QBO `Item.Name`/`PrivateNote` values `'Trim Pro Service'`, `'Trim Pro Purchase Order ...'`, `'Trim Pro Credit Memo ...'` | Mixed: function/variable names = **IS**; QBO `PrivateNote`/`Item.Name` values (3369, 3505, 1268, 1323, 1533, 1548) = **CF-adjacent** — these strings are written into the customer's own connected QuickBooks account and are visible to the tenant's bookkeeper |
| `lib/qbo/doc-numbers.ts:163,181,323,356` | `Error('Unable to allocate an unused ... in TrimPro...')`, `Error('Estimate number ... already exists in TrimPro...')` | **CF** — these are thrown as user-facing error messages in the estimate/invoice/credit-memo number pickers | reword to LoopCom Works |
| `lib/qbo/line-amounts.ts:24`, `lib/qbo/payment-method-mapping.ts:54` | comments only | **IS** |
| `lib/integrations/providers/sola.ts:21` | comment | **IS** |
| `lib/integrations/registry.ts:225,357` | UI field `placeholder: 'Trim Pro'`; `placeholder: 'https://app.trimprony.com/api/integrations/quickbooks/callback'` | **CF** — placeholders shown inside the integrations settings form | update both |
| `lib/messaging/channels.ts:134` | `subject \|\| 'Message from Trim Pro'` | **CF** | replace |
| `lib/permissions-catalog.ts:3` | comment "granular permissions for the Trim Pro platform" | **IS** | n/a |
| `lib/authorization.ts:499` | `userAgent?.includes('TrimProMobile')` | **DT** — reads the mobile app's own `User-Agent` header | keep in sync with mobile app's header string if that's ever renamed |

### H. Mobile app (`apps/mobile/`) — this is the live, shipped Expo app (`mobile-app/` at repo root is an unused generic scaffold, see Summary)

| path:line | snippet | class | proposed replacement |
|---|---|---|---|
| `apps/mobile/app.json:3` | `"name": "TrimPro Field"` | **CF** — app-store display name | `"LoopCom Works Field"` (confirm final name) |
| `apps/mobile/app.json:4` | `"slug": "trimpro-field"` | **IS/CF-adjacent** — Expo project slug, used in build URLs; renaming has EAS/build implications | flag for Izzy before touching |
| `apps/mobile/app.json:5` | `"scheme": ["trimprofield", "trimpro"]` | **DT** (deep-link URL scheme, not user-visible text, but OS "Open with" pickers can surface the app name, not the scheme) | can keep or add new scheme alongside old for compatibility |
| `apps/mobile/app.json:26,37` | `"bundleIdentifier": "com.trimpro.field"`, `"package": "com.trimpro.field"` | **IS but risky to rename** — changing this creates a *new* app listing on both stores, loses existing installs/reviews | do NOT rename without an explicit go/no-go from Izzy — this is a store-identity decision, not a copy fix |
| `apps/mobile/app.json:30-33` | 4× iOS permission-usage strings, each starting "TrimPro Field uses..." | **CF** — shown in the OS permission prompt (camera/photos/mic/location) | reword all 4 to "LoopCom Works Field uses..." |
| `apps/mobile/google-services.json:4,5,12` | Firebase `project_id: "trimpro-83596"`, storage bucket, `package_name: "com.trimpro.field"` | **IS** — Firebase project identifiers, not user-visible; tied to push notification infra | leave as-is unless Firebase project itself is being renamed (separate, riskier project) |
| `apps/mobile/src/branding/BrandingContext.tsx:48` | `appDisplayName: 'TrimPro Field'` (default) | **CF** — same mechanism as web `BrandingSettings`; only shows if tenant/public branding fetch returns nothing | `'LoopCom Works Field'` |
| `apps/mobile/src/screens/auth/LoginScreen.tsx:14` | `branding.appDisplayName \|\| 'TrimPro'` | **CF** | replace |
| `apps/mobile/src/screens/auth/LoginScreen.tsx:106,110` | Terms/Privacy links to `app.trimprony.com/terms`, `/privacy` | **CF** | update with domain cutover |
| `apps/mobile/src/navigation/RootNavigator.tsx:178,430,518` | screen option title "Share to TrimPro"; `<Text>TrimPro</Text>` brand title; Drawer screen `title: 'TrimPro'` | **CF** — all three render visible text in the app | replace all three |
| `apps/mobile/src/navigation/RootNavigator.tsx:72` | `prefixes: ['trimprofield://', 'trimpro://']` | **DT** | see app.json scheme note |
| `apps/mobile/src/screens/profile/ProfileScreen.tsx:227` | "Share photos, videos, and documents into TrimPro from other apps." | **CF** | replace |
| `apps/mobile/src/notifications/registerPush.ts:59,60` | Android notification channel id `'trimpro-default'`, channel **name** `'TrimPro'` | id=**DT**; name=**CF** (Android shows channel names under app notification settings) | rename channel display name; channel *id* can stay (renaming an id on an existing install just creates a second channel) |
| `apps/mobile/plugins/withAndroidShareIntent.js:2,4,14` | comments + deep-link doc string | **IS** | n/a |
| `apps/mobile/BUILDING.md`, `DEPLOYING.md`, `BACKEND_ENDPOINT_AUDIT.md`, `ENVIRONMENT.md` | internal build/deploy docs, ~10 hits total | **IS** | n/a |
| `apps/mobile/package.json:2`, `apps/mobile/package-lock.json:2,8` | `"name": "trimpro-field"` | **IS** | n/a |
| `apps/mobile/src/api/client.ts:52,103`, `apps/mobile/src/auth/AuthContext.tsx:81`, `apps/mobile/src/services/publish-request-draft.ts:79`, `apps/mobile/src/services/open-attachment.ts:135` | `'User-Agent': 'TrimProMobile'` (5 call sites) | **DT** — sent on every API request, visible in server logs / network devtools, not to the end user | keep in sync if ever renamed; low priority |
| `apps/mobile/src/config/env.ts:4` | `PROD_FALLBACK_URL = 'https://app.trimprony.com'` | **CF** (drives every API call if env misconfigured) | update with domain cutover |
| `apps/mobile/src/services/open-attachment.ts:9` | `MEDIA_BASE_URL = API_BASE_URL \|\| 'https://app.trimprony.com'` | **CF** | same |
| `apps/mobile/src/components/attachments/ImageMarkupWebView.tsx:552` | `baseUrl: 'https://app.trimprony.com'` (WebView) | **IS/low** — internal `baseUrl` for relative asset resolution inside an offscreen markup WebView, not displayed | update with domain cutover |
| `apps/mobile/src/notifications/openFromNotification.ts:10,17-24` | `trimpro://`/`trimprofield://` deep-link parsing/building (8 lines) | **DT** | see scheme note |
| `apps/mobile/src/components/chat/MessageBubble.tsx:318`, `apps/mobile/src/screens/messages/MessageThreadScreen.tsx:1356`, `apps/mobile/src/screens/jobs/jobDetailSections.tsx:613,637` | `Linking.openURL('trimpro://jobs/...')` etc. (in-app internal navigation, not OS-level) | **DT** | see scheme note |
| `apps/mobile/src/auth/secure-storage.ts:4-7`, `apps/mobile/src/offline/outbox.ts:5`, `apps/mobile/src/drafts/storage.ts:3`, `apps/mobile/src/notifications/registerPush.ts:9-11` | `trimpro.mobile.*`, `trimpro.push.*`, `trimpro.mobile.local-drafts.v1`, `trimpro.mobile.outbox` — SecureStore/AsyncStorage keys | **DT** | optional rename (would need a migration to not lose stored sessions/drafts on upgrade) |
| `apps/mobile/src/share/shareIntentLinking.ts:11,25,29` | `SHARE_INGRESS_URL='trimprofield://share-ingress'`, scheme fallback `'trimprofield'`, `'com.trimpro.field'` | **DT/IS** | tied to app.json scheme/bundle id decisions above |
| `lib/notifications.ts:68-73,111`, `lib/notifications/email.ts:38`, `lib/services/mobile-push.ts:143` | server-side mirrors of the same `trimpro://` deep links, "Open TrimPro to review...", channel id `'trimpro-default'`, badge `'TrimPro'` (email.ts:38) | **CF** for the prose (68-111 partial, notifications/email.ts:38); **DT** for the URL scheme/channel id | replace prose; keep scheme/id in sync with mobile app |
| `app/api/public/branding/route.ts:24` | `appDisplayName: 'TrimPro Field'` (server-side default returned when tenant has no branding row) | **CF** — this is the actual value the mobile app's `BrandingContext.tsx:48` default exists to mirror; **this is the authoritative source**, the mobile default is a client-side fallback for when this API is unreachable | `'LoopCom Works Field'` |
| `app/api/mobile/push/test/route.ts:19,20` | test push title/message "TrimPro test push" / "...from TrimPro." | **CF** (admin-triggered test push, visible on a real device) | replace |
| `app/api/webhooks/whatsapp/route.ts:90` | `WHATSAPP_VERIFY_TOKEN \|\| 'trimpro_verify_token'` | **IS/security** — webhook verification secret default; not customer-visible but a weak hardcoded fallback secret is worth flagging separately from branding | not a branding item; recommend requiring the env var with no fallback, independent of this audit |

### I. Domains hardcoded directly as `'https://app.trimprony.com'` (bypassing `lib/public-url.ts`)

All **CF** in effect (each builds a URL a customer receives by email/SMS or is redirected to). One line per call site — 27 total outside the ones already listed in sections A/C/F/H:

`app/api/webhooks/quickbooks/route.ts:7` (comment only, **IS**) · `app/api/clients/[id]/statement/route.ts:354` · `app/api/users/[id]/reinvite/route.ts:52` · `app/api/integrations/[provider]/route.ts:206` · `app/api/integrations/[provider]/regenerate-secret/route.ts:40` · `app/api/jobs/[id]/attachments/route.ts:21` · `app/api/users/me/avatar/route.ts:27,31` · `app/api/integrations/quickbooks/callback/route.ts:17,29,102` (line 102 is a `User-Agent` string, **DT**) · `app/api/users/invite/route.ts:170` · `app/api/estimates/[id]/send/route.ts:119` · `app/api/payments/sola/link/route.ts:15,24` · `app/api/estimates/[id]/convert-to-invoice/route.ts:403` · `app/api/public/payments/quickbooks/return-status/route.ts:102` · `app/api/public/estimate-approval/[token]/create-invoice/route.ts:88,246` · `app/api/public/estimate-approval/[token]/approve/route.ts:33` · `app/api/public/invoices/[id]/payment-link/route.ts:32,41` · `app/api/requests/[id]/attachments/route.ts:21` · `lib/estimate-approval.ts:27` · `lib/payments/receipts.ts:20` · `lib/public-url.ts:46` (the canonical helper itself — **fix here first**) · `lib/qbo/payments-ach.ts:33,45` · `lib/invoices/send-invoice-email.ts:95` (comment says "Force public base URL... to avoid internal/private links" — deliberately bypasses the helper) · `lib/integrations/providers/voipms.ts:208` (URL-prefix check, not a literal build) · `middleware.ts:19` (see below)

`middleware.ts:19` — `url.hostname = 'app.trimprony.com' // trimprony.com is the actual production domain` — **CF**, this is the single most consequential line: it force-rewrites the effective hostname for internal routing/redirect purposes. Must be updated in lock-step with any real DNS/domain cutover, not left as a copy-only fix.

`lib/services/cardknox-url.ts:3,7` — comment + `CARDKNOX_HOSTED_FORM_URL` fallback `'https://secure.cardknox.com/trimprony'` — **CF/payments**, this is Cardknox's own hosted-payment-page path keyed to the merchant account name "trimprony", **not something this codebase can rename unilaterally** — changing it requires Cardknox/Sola merchant account changes on their side first.

Support-email hardcodes not already listed above: `app/dashboard/settings/email-integrations/page.tsx:260` (`noreply@trimpro.com`), `app/api/email-integrations/route.ts:61,63`, `app/api/email/send/route.ts:58`, `app/api/email/retry/[id]/route.ts:34`, `lib/email-integrations/sender.ts:29,30,84`, `lib/integrations/providers/email.ts:86,162,219,295,413`, `lib/services/email.ts:17,18` — all **CF** (literal outbound "From" address/name fallback when a tenant hasn't configured their own sender) — all resolve to `noreply@trimpro.com`; consistent, just needs one coordinated replacement + inbox provisioning on the Loopcom side before cutover.

### J. Dev/test/ops-only hits — internal-safe, not itemized line-by-line (grouped)

- **Deploy & server-setup scripts** (`deploy-from-git.sh`, `deploy-production.sh`, `deploy-simple.sh(.ps1)`, `deploy-to-server.sh(.ps1)`, `deploy-git.ps1`, `deploy-final.ps1`, `deploy-from-windows.ps1`, `quick-deploy.ps1`, `server-setup.ps1`, `setup-database.sh`, `deploy-new-features.sh`): ~85 lines total, e.g. `/root/apps/trimpro` server paths, `TrimPro2024!Secure` DB password literal, pm2 app name. **IS**, but note: the DB password string `TrimPro2024!Secure` appears in plaintext in `scripts/diag-clients.sh:2` and `diag-clients2.sh:2` — that's a credentials-in-repo issue, separate from branding, flagged for awareness only (task scope is branding, not secrets hygiene).
- **nginx configs** (`scripts/fix-nginx-config.py`, `fix-nginx-config.sh`, `nginx-trimpro.conf`): server_name/ssl cert paths/upload alias paths all reference `app.trimprony.com` and `/root/apps/trimpro/...` — **IS**, but functionally these must change together with any real domain/server cutover (not just a text-replace exercise).
- **ecosystem.config.js:28** `name: 'trimpro'` — pm2 process name — **IS**.
- **package.json:2** `"name": "trim-pro"` — **IS**.
- **Diagnostic/one-off scripts** (`diagnose-invoices.js`, `diagnose-qb-count.ts`, `investigate-ach-payment.ts`, `sync-qb-balances.ts`, `run-sync-balances.js`, `test-embed.js`, `test-cardknox-url-length.ts`, `test-public-payment-flow.ts`, `test-reconcile-cron.sh`, `smoke-estimate-docnumber-prod.ts`, `setup-reminder-cron.sh`, `fix-truncated-urls.js`): ~35 lines, console.log labels and hardcoded prod URLs for one-off/cron use — **IS**.
- **`scripts/preview-customer-emails.ts`** (11 lines) and **`scripts/prove-email-pdf-attachment.ts`** (3 lines) — build fixture data (`companyName: 'TrimPro Demo'`, `businessName: 'Trim Pro NY'`) for local email-preview tooling only, never sent to a customer — **IS**.
- **`scripts/create-admin.ts`, `create-admin-user.ps1`, `prisma/seed.ts`, `scripts/seed-dev-demo.ts`** (~20 lines): dev/demo account emails `admin@trimpro.com`, `mike.tech@trimpro.com`, etc., console output — **IS**, local/demo data only.
- **`app/api/auth/dev-login/route.ts:5,26`** — dev-only login shortcut, gated out of production — **IS**.
- **`app/api/bootstrap/admin/route.ts:92`** — example `DATABASE_URL` in an error hint — **IS**.
- **`fix_edit_page.py`, `write_file.py`** (root) — one-off local Python scripts that hardcode `/root/apps/trimpro/app/dashboard/clients/[id]/edit/page.tsx` as a patch target — **IS**, appear to be scratch tooling, not part of the app.
- **Tests** (`tests/qbo-customer-sync.test.ts`, `email-recipients.test.ts`, `email-attachments.test.ts`, `job-site-address-docs.test.ts`): assertions against literal `'TrimPro'`/`'trimpro.com'` strings — **IS**; note these tests will need updating in lock-step if the CF defaults in sections A/F are changed, or they will start failing.
- **`.easignore`** — no direct "trimpro" text, but excludes nothing branding-relevant; not itemized.
- **`docs/JUPITER_RESTORE.md`** (42 hits), **`docs/PLUTO_MOBILE_RESTORE.md`** (1 hit), **`docs/push-notifications.md`** (8 hits), **`docs/ai-context/AGENT_HANDOFF_PROJECT_RULES_2026-09-17.md`** (3), **`docs/ai-context/claude-md-sections/2026-09-02-loopcom-reskin-mockups.md`** (3), **`.../2026-09-17-project-rules-adopted-from-connect.md`** (2) — internal engineering/restore/handoff docs — **IS**.
- **Root project docs**: `README.md` (10), `CLAUDE.md` (3), `AGENTS.md` (2), `MEMORY.md` (2) — project meta-docs describing the repo itself ("Loopcom App (formerly Trim Pro)") — **IS**, already in the process of being updated by the project's own working rules; not a shippable-product concern.
- **Legacy root status `*.md` files** (per instructions, counted only, not itemized): `COMPLETE.md`(1), `CREATE-ADMIN.md`(3), `DEPLOY-NOW.md`(28), `DEPLOY.md`(8), `DEPLOYMENT-COMPLETE.md`(9), `DEPLOYMENT-INSTRUCTIONS.md`(13), `DEPLOYMENT-PROGRESS.md`(18), `DEPLOYMENT-READY.md`(2), `DEPLOYMENT-SUCCESS.md`(1), `DEPLOYMENT.md`(24), `FINAL-IMPLEMENTATION-STATUS.md`(1), `IMPLEMENTATION-COMPLETE.md`(1), `MIGRATION-SQL.md`(1), `QUICKBOOKS_ACH.md`(11), `SERVER-SETUP-COMPLETE.md`(11), `git-deploy-setup.md`(19) = **151 lines**, all **IS**. (`ANALYTICS-NOTIFICATIONS-IMPLEMENTATION.md`, `BUILD-STATUS.md`, `BUNDLES-IMPLEMENTATION.md`, `COMPLETE-IMPLEMENTATION-REPORT.md`, `DEPLOYMENT-GUIDE.md`, `FINAL-IMPLEMENTATION-SUMMARY.md`, `FINAL-STATUS.md`, `IMPLEMENTATION-PLAN.md`, `IMPLEMENTATION-PROGRESS.md`, `IMPLEMENTATION-STATUS.md`, `PROGRESS-SUMMARY.md`, `PURCHASE-ORDERS-IMPLEMENTATION.md`, `SERVER-BOOTSTRAP-SUMMARY.md` had 0 hits.)

---

## Assets

### `public/` (live, served)

| Path | Type | Dimensions | Used by | Notes |
|---|---|---|---|---|
| `public/branding/trimpro-icon.svg` | SVG, abstract dot/line glyph, `aria-label="TrimPro icon"`, no literal text drawn | viewBox 220×224 | `apple-touch-icon` (`app/layout.tsx:30`), `components/branding/TrimProLogo.tsx` (`TrimProIcon`/`TrimProMark`/`TrimProLoginBadge`), `components/branding/TrimProMark.tsx`, `public/manifest.webmanifest` icon entry | **Primary in-use icon mark.** No visible brand text — only the filename/aria-label reference TrimPro, so the *image itself* likely needs no redraw, only optional renaming/aria-label update. |
| `public/branding/trimpro-logo.svg` | SVG, wordmark, literal `<text>TrimPro</text>` | viewBox 1200×360 | `DEFAULT_LOGO` in `TrimProLogo.tsx:92` (used as fallback web logo) | **Needs a real re-draw** — it's a typeset wordmark, not just a filename issue. |
| `public/favicon-tp.svg` | SVG, hand-drawn "T"+"P" monogram glyphs, `aria-label="TP"` | viewBox 1024×1024 | `app/layout.tsx:28,29` (`icon`, `shortcut`) | **Needs a real redesign** — this is literally a "TP" letterform icon, referenced by every browser tab. |
| `public/trimpro-logo.svg`, `public/trimpro-logo-v2.svg`, `public/trimpro-logo-v3.svg` | SVG wrapper, each just `<image href="/branding/trimpro-logo.svg">` at 480×480 | thin wrappers around the branding logo above | not referenced by any code file found in this audit (no grep hit outside themselves) — appear to be unused legacy/versioned copies | low priority; candidates for deletion rather than rebranding, confirm with Izzy before removing |
| `public/manifest.webmanifest` | PWA manifest | n/a | browser "Install app" prompt | name/short_name covered in section B; icon `src` points at `trimpro-icon.svg` above |

### `apps/mobile/assets/` (live Expo app)

| Path | Type/Dimensions | Used by (`app.json`) |
|---|---|---|
| `apps/mobile/assets/icon.png` | PNG 1024×1024, RGB | `icon` |
| `apps/mobile/assets/tp.png` | PNG 1024×1024, RGB | not referenced in `app.json` — orphaned/unused source file, likely the original "TP" artwork `icon.png`/`adaptive-icon.png` were derived from |
| `apps/mobile/assets/adaptive-icon.png` | PNG 1024×1024, RGB | Android `adaptiveIcon.foregroundImage` (also used as notification icon) |
| `apps/mobile/assets/splash-icon.png` | PNG 1024×1024, RGB | splash screen |
| `apps/mobile/assets/favicon.png` | PNG 48×48, gray+alpha | web favicon (Expo web target, likely unused since this is a native-only field app) |

All 4 in-use PNGs are almost certainly derived from the same "TP" mark as `favicon-tp.svg`/`trimpro-icon.svg` — visual confirmation needs a human to open them (binary image content wasn't rendered as part of this text audit); flagging `tp.png` by name alone is a strong signal it's brand artwork needing replacement.

### `mobile-app/assets/` (orphaned scaffold, see Summary — not part of the shipped app)

`adaptive-icon.png`, `favicon.png`, `icon.png`, `splash-icon.png` — generic Expo default-template placeholder images (different byte sizes than `apps/mobile/assets`, colormap-encoded, dated as filesystem placeholders 1985-10-26 which is the FAT/exFAT epoch-zero date, i.e. never meaningfully touched). `mobile-app/app.json` names the app `"mobile-app"` — not TrimPro-branded at all. **No rebranding action needed here**; recommend confirming with Izzy whether this directory can simply be deleted as dead scaffold.

---

## Email + PDF templates

| Location | Hard-coded brand strings? | Reads from `BrandingSettings`? |
|---|---|---|
| `lib/email/templates/invoice.ts` | `companyName` default `'TrimPro'` (42) | Yes — `companyName` param overridden by callers via `getEmailBranding()` (e.g. `lib/invoices/send-invoice-email.ts:139-142`) |
| `lib/email/templates/estimate-approval.ts` | `companyName` default `'TrimPro'` (44), `supportEmail` default `'support@trimpro.app'` (45) — **note the different domain** | Yes, via caller (`app/api/estimates/[id]/send/route.ts:161` passes branding-resolved name, falls back to `'TrimPro'`) |
| `lib/email/templates/payment-receipt.ts` | `companyName` ×3 (66,147,159,173), `supportEmail` default `support@trimprony.com` (174) | Yes, via `lib/payments/receipts.ts:183` (`tenantName: payment.invoice.tenant?.name \|\| 'TrimPro'`) |
| `lib/email/templates/credit-memo.ts` | `companyName` default `'TrimPro'` (31) | Not directly traced to a `getEmailBranding()` call site in this audit — caller is `app/api/credit-memos/[id]/send/route.ts:92` which passes `'Trim Pro'` literally; **appears to NOT read tenant branding today** — worth a closer look outside branding-text-only scope |
| `lib/email/templates/statement.ts` | `companyName` default `'TrimPro'` (30) | Similar — caller `app/api/reports/customer-statement/route.ts` / `app/api/reports/email/route.ts:89` passes `'TrimPro'` literally in at least one path; not fully traced |
| `lib/email/templates/staff-notification.ts` | 5 hardcoded "TrimPro" strings (26,30,40,54,59,70), no `companyName` pass-through visible for all of them | Partial — `companyName` is parameterized (26) but several other strings (badge, footer line) are NOT parameterized and always say "TrimPro" regardless of branding |
| `lib/email/templates/purchase-order.ts` | none (only a comment) | via `app/api/purchase-orders/[id]/send/route.ts:126` passing `'Trim Pro'` literally |
| `lib/email/shell.ts` (shared header/footer shell used by all templates) | `companyName \|\| 'TrimPro'` fallback (100) | Yes — takes `companyName` as a parameter |
| `lib/documents/pdf-templates.ts` (Invoice/Estimate/PO/Credit-memo/Statement PDFs — 8 doc types share this file) | `alt="Trim Pro Logo"` ×8, "official purchase order/credit memo from Trim Pro" ×2, `<div>trimpro</div>` fallback ×2 | Yes, at the top level — `PdfBranding` object (`businessName`, `logoUrl`, colors) is threaded through from `getPdfBranding()`; the hardcoded strings listed are ancillary (alt text, disclaimer sentences, deep fallback), not the primary business-name slot |
| `lib/branding/pdf.ts` (`getPdfBranding()` — the actual resolver) | `DEFAULT_BUSINESS_NAME='Trim Pro'` (30, text fallback), literal `<text>TrimPro</text>` baked into the generated fallback logo SVG (43) | **This IS the BrandingSettings reader** — reads `invoiceBusinessName`, `invoiceLogoUrl`/`webLogoUrl`, `primaryColor`/`buttonColor`/`buttonTextColor` from the DB (via `getBrandingSettingsForTenant`); the two hardcoded strings are its own fallback values when a tenant hasn't configured branding |

No `app/api/*/pdf` route was found generating a *separate* template — all PDF document types (invoice/estimate/PO/credit-memo/statement) render through the single shared `lib/documents/pdf-templates.ts`, fed by the single shared `lib/branding/pdf.ts` resolver. Fixing the two files in section A (plus the alt-text/disclaimer strings in section F) covers every PDF document type.

No `lib/documents` subfolder beyond `pdf-templates.ts` was found (no separate `lib/documents/estimate.ts` etc.) — confirmed by directory listing.

---

## Domains

- **Primary hardcoded domain:** `https://app.trimprony.com` — appears **~55 times** across `app/api/**`, `lib/**`, `components/**`, `scripts/**`, `apps/mobile/**`. The canonical env-var-aware helper is `lib/public-url.ts` (`getPublicAppUrl`-equivalent, falls back to this literal at line 46) — **only a subset of call sites use it**; most hardcode the literal string directly. A real domain cutover is a multi-file mechanical change, not a one-line env-var flip, unless those call sites are first refactored to call the shared helper.
- **`middleware.ts:19`** — `url.hostname = 'app.trimprony.com'` — this is a **functional rewrite**, not just display text; changing the literal string here changes routing/redirect behavior in production. Treat as a deploy-coordinated change, not a copy edit.
- **Two different support-email domains**: `support@trimprony.com` (most templates/pages) vs `support@trimpro.app` (only `lib/email/templates/estimate-approval.ts:45`) — inconsistency predates this audit; pick one canonical address for Izzy.
- **`noreply@trimpro.com`** (note: `.com`, not `.trimprony.com`) — a *third*, distinct domain used as the outbound "From" fallback in ~10 files (`lib/services/email.ts:17`, `lib/email-integrations/sender.ts:29`, `lib/integrations/providers/email.ts` ×4, `app/api/email/*`, `app/dashboard/settings/email-integrations/page.tsx:260`, `app/api/auth/dev-login/route.ts:5` (dev email, `.com` again), `scripts/seed-dev-demo.ts` (dev emails, `.com`)). So the repo currently references **three different domains** for TrimPro (`trimprony.com`, `trimpro.app`, `trimpro.com`) — worth surfacing to Izzy explicitly since a naive find-replace on just one of them would miss the others.
- **`secure.cardknox.com/trimprony`** (`lib/services/cardknox-url.ts:7`) — this is **not a domain we control**; `trimprony` here is the merchant-account path segment on Cardknox's own hosted payment page. Cannot be renamed by editing this repo alone.
- **`NEXT_PUBLIC_APP_URL` / `public-url.ts` usage**: `lib/public-url.ts` correctly checks `NEXT_PUBLIC_APP_URL` (implied by env var name convention used elsewhere, e.g. `app/api/users/invite/route.ts:170`, `app/api/integrations/[provider]/route.ts:206`) before falling back to the hardcoded domain — so **setting the env var in production is the correct short-term fix** for cutover, while the ~30 call sites that bypass `public-url.ts` entirely (section I) remain a code-level cleanup task independent of the env var.

---

## Out of scope, noticed

- `scripts/diag-clients.sh:2` and `diag-clients2.sh:2` contain a plaintext database password (`TrimPro2024!Secure`) committed to the repo — a secrets-hygiene issue, unrelated to branding, flagged for awareness only.
- `mobile-app/` (root) is a dead, generically-named Expo scaffold unrelated to the shipped `apps/mobile/` app; recommend a separate decision on deleting it rather than folding it into this branding pass.
- Two of the four `public/trimpro-logo*.svg` variants (`-v2`, `-v3`) plus the plain `public/trimpro-logo.svg` wrapper appear unreferenced by any source file found in this audit — likely stale, candidates for deletion (not rebranding) after confirming with Izzy.
- `lib/email/templates/credit-memo.ts` and `statement.ts` appear NOT to receive a tenant-resolved `companyName` from their callers today (callers pass the literal `'TrimPro'`/`'Trim Pro'` string directly rather than routing through `getEmailBranding()` the way `invoice.ts`'s caller does) — this is a functional branding-wiring gap, not just a text string, and is outside a pure find-and-replace fix. Noted for Izzy's awareness; not fixed here (read-only audit).
- `lib/services/qbo-sync.ts` writes literal `'Trim Pro Service'` / `'Trim Pro Purchase Order ...'` / `'Trim Pro Credit Memo ...'` strings into the tenant's own connected QuickBooks account (as `Item.Name` / `PrivateNote`). These are **customer-QuickBooks-visible**, not just internal, and are a slightly different risk category than in-app UI text since they get written into a third-party system the audit didn't attempt to enumerate beyond the source strings.
