# Fanvil onboarding for Loopcom LLC (2026-09-14)

**Browser-only business onboarding. No code, no PBX, no deploy, nothing submitted, nothing sent.**
Scope set by Izzy: establish Loopcom with Fanvil (partner / reseller / service provider) and get
FDPS (zero-touch) + API + FDMS access. Another agent owns the Loopcom code integration.

## What exists at Fanvil (verified from official pages)

| Program | Where | How you get it |
|---|---|---|
| Become a Partner (= Partner Portal account) | https://www.fanvil.com/partners/reg.html | Self-serve form: email + emailed verification code + password + company fields. Company Type is single-select. |
| Partner Portal | https://fanvil.com/login.aspx?redirect=%2fen%2fuser_center.aspx | Same account as above. |
| Authorized Online Reseller | https://fanvil.com/partners/networkcustomer.html | No public form on the page — "Fanvil Sales Manager will contact you within 2 weeks". Must buy from an authorized distributor, original packaging only, no Fanvil trademarks in domains/socials, MAP compliance. |
| MAP Policy | https://fanvil.com/partners/mappolicy.html | Applies to ADVERTISED price only (sell price free). "Call/email for price" allowed; price behind login is not an advertisement; bundling with non-Fanvil items violates. Penalties 14–90 d → 91–180 d supply suspension → termination. Applies without signing anything. |
| FDPS (zero-touch redirection) | https://fdps.fanvil.com/ | **No self-registration** — login page only. Accounts are issued by Fanvil (admin → agent → customer hierarchy, parent/child). Request via sales@/support@fanvil.com. |
| FDPS API | — | **Not documented publicly.** Must be requested. |
| FDMS (device management) | https://www.fanvil.com/products/fdms/20220322/7307.html | Email support with company name, email, country → Fanvil engineer activates → activation email. |
| FCMS | Fanvil Partner app / fcms | Intercom/community/villa/access-control focused. **Not needed for SIP desk phones — not pursued.** |
| Academy (training) | https://academy.fanvil.com/User/Login | Free sign-up (account creation — Izzy's). |
| Contact | https://www.fanvil.com/contactus/index.html | sales@fanvil.com, support@fanvil.com, +86-755-2640-2199 |

US distributors: **NTS Direct** (Authorized Master Distributor NA, 1-877-483-5393, their "Become a Fanvil Partner"
page just points back to Fanvil's registration), **VoIP Supply** (lead form at
https://www.voipsupply.com/fanvil-reseller-program, rep Brian Hyrek 716-531-4318, customer type includes
"VoIP Service Provider"), **Image Star**.

## State left for Izzy (nothing submitted)

1. **Fanvil "Become a Partner" form — FILLED, NOT SUBMITTED.** Company fields filled: Loopcom LLC, United States,
   Owner / Founder, 33 NY 17M Suite C Harriman NY 10926, https://www.loopcom.net, Solution Provider, X Series,
   Web Search, first/last Israel Weinstock, phone +1 845-723-1213, sales region United States, distributor "No",
   other brands "Yealink and Grandstream". Email izzy@loopcom.net entered.
   ⛔ Izzy must: click Send Codes, enter the code from izzy@loopcom.net, set the password, Submit.
   The agent may not create accounts or type passwords.
2. **VoIP Supply Fanvil reseller lead form — FILLED, NOT SUBMITTED** (customer type VoIP Service Provider,
   mobile +1 562-209-6644). Has reCAPTCHA → Izzy submits.
3. **Gmail DRAFT** (id r-8797244633396624025) to sales@fanvil.com cc support@fanvil.com requesting partner/reseller
   status, FDPS agent/SP account, FDPS API, FDMS, online reseller info, distributor recommendation.
   ⛔ Drafted in the Gmail account connected to Claude (not necessarily izzy@loopcom.net) — send from
   izzy@loopcom.net for a consistent identity.

## ✅ Partner account CREATED (2026-09-14, later)

Izzy completed the registration. Verified in the browser: signed in at fanvil.com as **izzy@loopcom.net**,
role label **"Partners"**, landing page `/partnerdownload/index.aspx` (Download Center: About Fanvil, Product
Picture, Fanvil EDM, Product Introduction PPT; Change Password; Sign out).
⛔ **The partner portal is a download centre only — it grants NO FDPS, FDMS, API or reseller authorization.**
Those still need the Gmail draft (r-8797244633396624025) sent to sales@/support@fanvil.com from izzy@loopcom.net.
VoIP Supply lead form: still unsubmitted as of this note.

**Update, same day:** Izzy SENT the Fanvil request email (from izzy@loopcom.net to sales@fanvil.com, cc support@)
asking for partner/reseller status, FDPS agent account + API, FDMS, online-reseller info and a distributor
recommendation, and reports the VoIP Supply form submitted. **Now waiting on replies at izzy@loopcom.net.**
Nothing is approved yet — no FDPS/FDMS credentials exist.

## "I never got the code" (2026-09-14, same day)

- The email box had been changed to **billing@loopcom.net** when Send Codes was first pressed. Fanvil's
  `POST /getemailcode.aspx` answered `ok` (the page's 60 s `timmer` was already running), so that code went to
  billing@ — a mailbox never confirmed to exist in Google Workspace.
- ⛔ **While `timmer` is set the button silently ignores clicks and sends no request** — "I pressed it again
  and nothing happened" is that, not a broken site. Check with network capture, not by clicking.
- Switched to izzy@loopcom.net and called the same endpoint: **200 `ok` in ~5 s**. Delivery to the inbox is
  unconfirmed — the Claude Gmail connector is izzywgg@gmail.com and cannot see loopcom.net mail.
- If izzy@loopcom.net never receives it: Fanvil's mail may be held by Google Workspace quarantine / blocked
  sender rules (check Admin → Email log search for sender fanvil.com), or email sales@fanvil.com to register.

## ✅ FANVIL REPLIED (2026-09-15 — three emails at izzy@loopcom.net, read in Chrome; nothing clicked, replied, or logged into)

1. **"Re: Fw: Loopcom api.."** — Morchi Liu (sales rep, morchi.liu@fanvil.com) forwarded the request to
   Jack Yu (BD & Supporting Engineer, jack.yu@fanvil.com, WhatsApp +86 17631450827) asking for FDPS +
   FDMCS accounts with service-provider-level access. **Jack replied (3:55 AM): the FDPS account is
   CREATED** — username izzy@loopcom.net, temp password `Fanvil@2026`, server https://fdps.fanvil.com,
   ⛔ **must pick region "Europe" at login**. He also sent 4 FDMCS webinar YouTube links.
2. **FDMCS activation email** (FDMCS <info.fdms@fanvil.com>, "Please activate your account", 3:53 AM):
   activation link at fdmcs.fanvil.com.cn/system/activeUser?sn=… — **expires in 3 days (~2026-09-18)**.
   ⛔ Not clicked: activating = creating the account + setting a password, which is Izzy's to do.
   Note Fanvil's cloud device-management product is **FDMCS** (fdmcs.fanvil.com.cn), not "FDMS".
3. **"Re: Re: Loopcom API and Fanvil Partnership"** — Morchi Liu (2:41 AM): Fanvil "would be pleased to
   support Loopcom's reseller application and will initiate the internal review for Fanvil Authorized
   Reseller status". **FDPS API access is being reviewed by Jack**; docs to follow. For purchasing they
   recommend their **master distributor 888VoIP** (Orchard Park NY; Mary Cheney, (716) 714-8004,
   marketing@888voip.com, https://888voip.com/product-category/fanvil/).

VoIP Supply so far only sent an automated Fanvil Academy marketing email — no human reply to the
reseller lead form yet.

### What Izzy must do (agents may not create accounts or type passwords)
- ✅ **FDPS login DONE (2026-09-15):** Izzy logged into fdps.fanvil.com and changed the temp password.
- ⏳ **FDMCS activation still NEEDED — and the emailed link is BROKEN AS SENT.** ⛔ The email links to
  Fanvil's China host `fdmcs.fanvil.com.cn`, which is unreachable from the US (browser error page, both
  the link and the bare host). **The fix is the same path on the global host** — verified 2026-09-15 that
  `https://fdmcs.fanvil.com/system/activeUser?sn=YWN0aXZlVXNlcl8yMDk5NzY4NDY4MDA3MzUwMjc0XzE3ODk0NTg3ODk=`
  loads a working "Account Activation" form (User Name + Password + Confirm + Terms checkbox + Submit;
  password needs upper+lower+number+special, ≥8 chars). Izzy fills and submits it — same ~Sep 18 expiry —
  then logs in at https://fdmcs.fanvil.com/login. FDMCS is a SEPARATE account from FDPS; changing the
  FDPS password does not activate FDMCS.
- Optional: reply thanking Morchi/Jack and nudging for the FDPS API docs; contact 888VoIP when hardware
  purchasing starts.

### Still open
- FDPS API documentation (Jack reviewing) — the desk-phone wizard's Fanvil zero-touch build stays
  blocked on this.
- Authorized Reseller review outcome — ⛔ still no "authorized reseller/partner" claims anywhere.
- VoIP Supply human reply.

## Traps

- No prior Fanvil relationship existed (Gmail search for fanvil/fdps/ntsdirect/voipsupply returned nothing).
- www.fanvil.com/company/contact/ is a dead URL — the contact page is /contactus/index.html.
- VoIP Supply's page carries hidden store login/registration forms; a name-based JS fill touches them too
  (harmless, never submitted). Scope any fill to the HubSpot lead form.
- Do not claim authorized/approved status until Fanvil replies.
- Purchase volume, EIN, revenue, employee count were NOT entered anywhere (not asked by these forms).
