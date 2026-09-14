# HP / Poly partner + Poly Zero Touch + Poly Lens onboarding for Loopcom — 2026-09-14

**Research and browser navigation only.** No Loopcom code, PBX, wizard or phone was touched.
No account was created, no password was entered, no application was submitted and no email was sent:
every onboarding path begins with creating an HP account (a password), which the agent does not do.
The browser was not signed in to HP, the HP Partner Portal or Poly Lens.

## The chain, read from HP's own current docs

1. **HP ID** (HP account), created at partner.hp.com → Apply. It needs a password and email verification, so Izzy has to do this.
2. **HP Partner Portal registration, North America** (`HP_Partner Registration Process_NA.pdf`, 23 pages, read in full):
   - ⛔ **Only an OFFICER may apply** (a person able to bind the company, so Izzy).
   - The email must be a **corporate address that matches the company domain** (izzy@loopcom.net, never Gmail).
   - Search for the company first, then "Register a New Company" if it is not found, with the **legal address**.
   - **Partnership Type: Reseller.** Business info: form of organization, sales coverage, selling methods (must total 100%), and business owners.
   - Accept the Partner Portal Administrator responsibilities → Submit → wait for HP's approval email.
   - After approval: sign in → accept the Portal T&Cs → submit "Next stage" → **accept the HP Partner Agreement T&Cs.** ⛔ That is a contract; it is Izzy's decision.
   - Support: hp.amspartnersupport@hp.com.
   - HP Amplify is the single partner program. Poly was folded into it on 2023-11-01. Tiers are **Synergy** (entry) and **Power / Power Elite**.
   - Holding a partner agreement does NOT make you a print/supplies partner (not relevant to us).
3. **Poly Zero Touch (Poly ZT)** is the factory-fresh redirection service (Poly's equivalent of Yealink RPS / Fanvil FDPS).
   - ⛔ **It requires a valid HP Partner contract.** To request it, email **ztponboarding@hp.com** with the Company Name, **HP Partner ID** and the admin email address. HP creates the org and sends login instructions.
   - PDMS-SP was decommissioned into Poly ZT on 2025-05-30.
   - Poly ZT has: an organization switcher (multi-org under one login), 6 user roles, profiles (holding the provisioning server URL), device claiming by MAC (UI, CSV bulk upload, Partner REST API `POST /v1/devices`, `POST /v1/profiles`, plus the legacy Polycom ZTP XML API), and **client credentials that span multiple organizations**.
   - Active management covers **reboot, remote config sync, factory reset, config retrieval, log retrieval and remote packet capture**, depending on the model and firmware.
   - Claim codes (`pcc.accountCode`) can claim a device the provisioning server already reached.
   - The provisioning URL is validated (https/http/ftp/ftps/tftp only).
   - ZT is used ONLY when DHCP/static provisioning does not already point the phone somewhere.
   - **Supported for redirection:** Edge E100–E550 (all PVOS), Edge B10/20/30 (all PVOS-L), CCX 350–700, Trio, VVX Gen1/2/3, VVX OBi Edition, ATA 400/402, Rove.
   - **Active management:** Edge E and Edge B (all versions), CCX (PVOS 8.1.7.0842 / 9.0.0.10460+), VVX Gen3 (UCS 6.3.0+). NOT supported on OBi Edition, ATA or Rove.
   - Pre-2012 phones may have ZTP disabled by default.
4. **Poly Lens** (lens.poly.com). Signing in accepts Microsoft / Google / Apple / HP accounts, and it was not signed in here.
   - **Device Provisioning:** enable it on the account; the provisioning page shows the server address plus a username and password. DHCP format `https://user:pass@server`, via option 66/160/161, or entered on the phone's web UI. It needs the phone to be pointed at Lens: Lens is NOT a factory redirection service. Poly ZT is.
   - **API:** ACCOUNT → Manage Accounts → account → API Credentials. OAuth2 client credentials at `https://login.lens.poly.com/oauth/token`; GraphQL at `https://api.silica-prod01.io.lens.poly.com/graphql`; 24-hour JWT. Query cost limit is 10,000 per query and 100,000 per rolling 60 seconds. Scope is "Just this account" or "Multiple accounts"; other accounts grant or deny the incoming access request.
   - **Pricing:** APIs for Lens Core features cost nothing extra. Premium features (rooms analytics, Zoom device management, TC remote access, Power BI) need **Lens Pro for Rooms or Poly+ Enterprise / Elite / Managed Collaboration Services**, and a Lens Premium trial licence exists. The UI can restart and factory reset a voice device (Manage > Inventory > device) while it is online.
   - ⏳ Whether the GraphQL API exposes voice reboot/reset mutations is unverified; the docs don't list it.

## Distributors (US, authorized for HP/Poly)

- **ScanSource** — Poly reseller onboarding, Custom Configuration Center (staging/config). poly@scansource.com, 877-847-7000.
- **TD SYNNEX** — HP authorized. HPPoly@tdsynnex.com, HPPSG@tdsynnex.com.
- **888VoIP** — VoIP value-added distributor with staging/provisioning (site 403s WebFetch; not verified in browser).
- ⏳ Not yet asked: MAC/serial feeds, Poly ZT claiming on our behalf, drop ship, API/EDI.

## Pages opened and pre-filled for Izzy (2026-09-14, later)
- **HP account sign-up** (via partner.hp.com → Apply): Israel / Weinstock / izzy@loopcom.net filled, marketing box unticked. The password and "Create" are left for Izzy.
- **Poly Lens login** (lens.poly.com): opened. Izzy signs in, via Google for izzy@loopcom.net or another method.
- **ScanSource Specialty prospect form** (scansource.my.site.com/prospectscreening/s/): filled in except "Do you have an immediate opportunity?" (required) and "How did you hear". Company, name, email, phone 845-723-1213, US, email contact, resell=Yes, UC, Cisco=No, supplier "HP | Poly", federal=No, and the comments were entered. NOT submitted.

## Status: nothing applied. Next steps are Izzy's (see the final report in chat).
