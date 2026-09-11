/**
 * One adapter per brand in the PBX's provisioning catalogue, so that EVERY model the PBX can
 * provision has a named way to be pointed at its tenant folder from a computer on the same LAN.
 *
 * Read `vendorCatalog.generated.ts` first: that file is the PBX's own truth (20 brands, 427
 * models, 1,143 OUI prefixes, which templates exist and which of them write the provisioning
 * URL back into the phone). This file is the hand-written half — how each brand is recognised
 * on a network and what actually makes it fetch a config — and every claim in it carries a
 * `confidence` so nothing here can quietly become a promise.
 *
 * ⛔ THE ONE RULE: `confidence` is not decoration. `"proven"` means we have watched it work on a
 * real handset on this platform. Anything less MUST reach the customer as "we will try", and a
 * phone is only ever reported Ready because Asterisk says it registered — never because an
 * adapter's step returned success. See `deskPhoneSetup/states.ts`.
 *
 * ⛔ Mechanisms are listed in the order the driver should attempt them, and the order is a
 * judgement about blast radius, not about likelihood: a mechanism that touches only the phone we
 * are provisioning comes before one that touches the customer's network (DHCP) or the public
 * internet (a vendor redirect service), and a step that needs a person at the handset is always
 * last.
 */

import { VENDOR_CATALOG, type VendorSlug } from "./vendorCatalog.generated";

/**
 * How a phone can be told where its settings live, from a computer on the same network.
 *
 * `pnp_multicast` is the one that works on a phone nobody has ever touched: the handset asks the
 * network for a provisioning URL at boot and obeys whoever answers first. Everything else needs
 * the phone to already be reachable, already be pointed somewhere, or a person to act.
 */
export type LocalMechanism =
  /** The phone multicasts a SIP SUBSCRIBE for `Event: ua-profile` at boot; we answer with the URL. */
  | "pnp_multicast"
  /** One authenticated HTTP request that reboots the phone or makes it re-read its config now. */
  | "http_action_uri"
  /** An authenticated HTTP request that WRITES the provisioning URL into the phone. */
  | "http_settings_write"
  /** A SIP NOTIFY (`check-sync` and relatives) that makes an already-pointed phone re-fetch. */
  | "sip_notify_check_sync"
  /** Multicast DNS service discovery (Bonjour) that the phone browses at boot. */
  | "mdns"
  /** A DHCP option carrying the URL. Needs the customer's own DHCP server, so it is never ours to set. */
  | "dhcp_option"
  /** The vendor's internet redirection service, keyed on the MAC. Not a LAN mechanism. */
  | "vendor_redirect"
  /** A person standing at the handset typing the URL into its menu. */
  | "phone_menu";

/**
 * How far a claim has been taken.
 *
 * - `proven`     watched working on a real handset on this platform.
 * - `documented` stated by the manufacturer's own documentation, unexercised by us.
 * - `inferred`   deduced from strong evidence (an identical template key, a shared OEM), untested.
 * - `unknown`    nobody has found out. The wizard must not attempt it silently.
 */
export type AdapterConfidence = "proven" | "documented" | "inferred" | "unknown";

/** A single HTTP request the desktop app can make to a phone on the LAN. */
export type PhoneHttpAction = {
  /** `GET` unless the phone insists otherwise. */
  method: "GET" | "POST";
  /** Path only. The host is always a private address the desktop app validated itself. */
  path: string;
  /** `basic` = HTTP Basic with the phone's own admin credentials; `session` = log in first. */
  auth: "none" | "basic" | "session";
  confidence: AdapterConfidence;
  /** Where this came from, so the next person can check it rather than trust it. */
  source: string;
};

export type PnpProfile = {
  supported: boolean;
  /** UDP port the phone multicasts to. 5060 unless a brand is known to differ. */
  port: number;
  /**
   * `Content-Type` the phone expects on the answering NOTIFY. Some firmware is fussy, so the
   * resident listener answers with the value the SUBSCRIBE asked for when it names one.
   */
  notifyContentType: string;
  /** The `vendor=` token in the phone's own `Event: ua-profile` header, when it is meaningful. */
  vendorToken: string | null;
  /** Whether the feature is on when the phone leaves the factory. */
  defaultOn: boolean | null;
  confidence: AdapterConfidence;
  source: string;
  notes?: string;
};

export type VendorAdapter = {
  slug: VendorSlug;
  /**
   * Who actually built the firmware, when that is not the brand on the box. This is the single
   * most useful fact for a rebadged phone: it says whose provisioning rules apply.
   */
  oem: string | null;
  /** Mechanisms in the order the driver should try them. */
  mechanisms: LocalMechanism[];
  pnp: PnpProfile;
  /** Default web credentials as the phone ships. `null` where the vendor randomises them. */
  defaultCredentials: { username: string; password: string } | null;
  /** `http` unless current firmware ships with the plain web server off. */
  webScheme: "http" | "https" | "either";
  /** The request that reboots the phone or forces a provisioning fetch, where one exists. */
  reboot: PhoneHttpAction | null;
  reprovision: PhoneHttpAction | null;
  /** The request that WRITES our URL into the phone. Very few brands expose one. */
  setProvisioningUrl: PhoneHttpAction | null;
  /** DHCP option numbers this brand reads, in the vendor's own order. */
  dhcpOptions: number[];
  /** The filenames the phone asks the server for, in the order it asks. */
  configFilenames: string[];
  /** Overall confidence that we can point a factory-fresh phone of this brand from the LAN. */
  confidence: AdapterConfidence;
  /** What is still unknown, in plain words. Empty means nothing material is outstanding. */
  gaps: string[];
  notes: string;
};

const UNSUPPORTED_PNP: PnpProfile = {
  supported: false,
  port: 5060,
  notifyContentType: "application/url",
  vendorToken: null,
  defaultOn: null,
  confidence: "documented",
  source: "no ua-profile multicast documented for this brand",
};

export const VENDOR_ADAPTERS: Record<VendorSlug, VendorAdapter> = {
  yealink: {
    slug: "yealink",
    oem: null,
    mechanisms: ["pnp_multicast", "http_action_uri", "dhcp_option", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "Yealink",
      defaultOn: true,
      confidence: "proven",
      source: "apps/desktop/src/phoneSetup/pnp.ts — the resident listener answers these in production",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    // Current firmware ships with the plain web server OFF; the adapter retries a refused
    // connection once over HTTPS and accepts the self-signed certificate.
    webScheme: "either",
    reboot: {
      method: "GET",
      path: "/servlet?key=Reboot",
      auth: "basic",
      confidence: "proven",
      source: "apps/desktop/src/phoneSetup/yealink.ts buildActionRequest",
    },
    reprovision: {
      method: "GET",
      path: "/servlet?key=AutoP",
      auth: "basic",
      confidence: "proven",
      source: "apps/desktop/src/phoneSetup/yealink.ts buildActionRequest",
    },
    setProvisioningUrl: null,
    dhcpOptions: [66, 43],
    configFilenames: ["<mac>.boot", "<mac>.cfg", "y000000000000.cfg"],
    confidence: "proven",
    gaps: [],
    notes:
      "The only brand proven end to end on this platform. A factory-reset handset answers a restart " +
      "from an unlisted address by asking at the phone, which is why plugging it in is the one " +
      "physical step the wizard cannot remove.",
  },

  snom: {
    slug: "snom",
    oem: null,
    mechanisms: ["pnp_multicast", "http_settings_write", "http_action_uri", "dhcp_option", "vendor_redirect"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "OEM",
      defaultOn: true,
      confidence: "documented",
      source: "service.snom.com pnp_config / Auto Provisioning",
      notes:
        "The Event header says vendor=\"OEM\" model=\"OEM\" on every Snom, so the SUBSCRIBE cannot " +
        "identify the model — recognise it by OUI. The delivered URL lands in `pnp_server`, which " +
        "is a different setting from `setting_server` and cannot itself be provisioned.",
    },
    defaultCredentials: null,
    webScheme: "either",
    reboot: {
      method: "GET",
      path: "/advanced_update.htm?reboot=Reboot",
      auth: "basic",
      confidence: "documented",
      source: "service.snom.com Remote phone control",
    },
    reprovision: null,
    setProvisioningUrl: {
      method: "GET",
      path: "/dummy.htm?settings=save&setting_server=<url>&update_policy=auto_update&store_settings=save",
      auth: "basic",
      confidence: "documented",
      source: "service.snom.com — Can I set or change phone settings via HTTP requests",
    },
    dhcpOptions: [66, 67],
    configFilenames: ["snom<MODEL>.htm", "snom<MODEL>-<MAC>.htm"],
    confidence: "documented",
    gaps: [
      "Neither HTTP path works on the D8xx generation; those have no documented HTTP API at all.",
      "The PBX's OUI table holds only 00:04:13. Snom's second registered block, 1C:71:26, is missing, " +
        "so a handset from that block is not recognised by MAC until it is added.",
      "A fresh Snom has no web password, so the settings write needs no credentials — which also " +
        "means anyone else on that network could make it.",
    ],
    notes:
      "Ships with `provisioning_order` starting at Snom's own redirection service, so a phone with " +
      "internet asks secure-provisioning.snom.com before it listens to us. Answering its multicast " +
      "first is what wins.",
  },

  vtech: {
    slug: "vtech",
    oem: "Snom (ET6xx series only; VSP6xx/VSP7xx are a different firmware line)",
    mechanisms: ["pnp_multicast", "http_settings_write", "sip_notify_check_sync", "dhcp_option", "vendor_redirect"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "OEM",
      defaultOn: true,
      confidence: "documented",
      source: "VTech ET685 Admin & Provisioning manual pp.19-20 (the exchange is printed verbatim)",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "either",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: {
      method: "GET",
      path: "/dummy.htm?settings=save&setting_server=<url>&update_policy=auto_update&store_settings=save",
      auth: "basic",
      confidence: "inferred",
      source: "the ET6xx runs Snom firmware and documents the same restrict_uri_queries switch",
    },
    dhcpOptions: [66, 67, 43],
    configFilenames: ["VTech<MODEL>.htm", "VTech<MODEL>-<MAC>.htm", "<MODEL>_<MAC>.cfg"],
    confidence: "documented",
    gaps: [
      "The VSP6xx/VSP7xx line has no HTTP API whatsoever — once pointed, only a SIP NOTIFY check-sync " +
        "makes it re-read, and the URL itself has to be typed in its web page.",
      "The two families take different config filenames, so the folder must offer both.",
    ],
    notes:
      "VTech has owned Snom since 2016 and the ET6xx is Snom firmware in a VTech case — its own manual " +
      "still uses a Snom OUI in the examples. Treat ET6xx as Snom and VSP7xx as its own thing.",
  },

  fanvil: {
    slug: "fanvil",
    oem: null,
    mechanisms: ["pnp_multicast", "http_action_uri", "dhcp_option", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "Fanvil",
      defaultOn: null,
      confidence: "documented",
      source: "Fanvil Auto Provision directions (the SUBSCRIBE/NOTIFY exchange is printed verbatim)",
      notes: "The Event header names the vendor but reports the model as the generic string \"VOIP PHONE\".",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: {
      method: "GET",
      path: "/cgi-bin/ConfigManApp.com?key=Reboot",
      auth: "basic",
      confidence: "documented",
      source: "Fanvil Action URL & Active URI spec V0.0.5",
    },
    reprovision: {
      method: "GET",
      path: "/cgi-bin/ConfigManApp.com?key=AutoP",
      auth: "basic",
      confidence: "documented",
      source: "Fanvil Action URL & Active URI spec V0.0.5",
    },
    setProvisioningUrl: null,
    dhcpOptions: [66, 43],
    configFilenames: ["<mac>.cfg", "f0<model>hw1.100.cfg"],
    confidence: "documented",
    gaps: [
      "There is no documented HTTP call that WRITES the provisioning URL — the URL has to arrive by " +
        "PnP or DHCP, and the action URI only reboots or re-reads.",
      "Whether SIP PnP is on out of the box on current X-series is stated by PBX vendors, not by Fanvil.",
    ],
    notes:
      "The phone has its own allow-list for who may call the action URI (Active URI Source IP); empty " +
      "means anyone, which is the factory state.",
  },

  attimo: {
    slug: "attimo",
    oem: "Fanvil (unconfirmed — inferred from the feature set and the template dialect)",
    mechanisms: ["pnp_multicast", "http_action_uri", "dhcp_option", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "Fanvil",
      defaultOn: null,
      confidence: "inferred",
      source: "Attimo A-G01/A-G02 datasheets list SIP PNP, DHCP OPT66 and TR-069 explicitly",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: {
      method: "GET",
      path: "/cgi-bin/ConfigManApp.com?key=Reboot",
      auth: "basic",
      confidence: "inferred",
      source: "Fanvil action URI, applied on the assumption Attimo is a Fanvil rebrand",
    },
    reprovision: {
      method: "GET",
      path: "/cgi-bin/ConfigManApp.com?key=AutoP",
      auth: "basic",
      confidence: "inferred",
      source: "Fanvil action URI, applied on the assumption Attimo is a Fanvil rebrand",
    },
    setProvisioningUrl: null,
    dhcpOptions: [66],
    configFilenames: ["<mac>.cfg"],
    confidence: "inferred",
    gaps: [
      "The OEM is not confirmed. Read one unit's MAC prefix and web banner before trusting the Fanvil " +
        "endpoints — if it is not Fanvil, the action URI will simply 404 and the phone stays unharmed.",
      "⛔ Attimo and Fanvil are both registered against the SAME OUI (0c383e) in the PBX's table, so a " +
        "MAC alone can never tell them apart. `vendorsForMac` returns both rather than choosing.",
    ],
    notes:
      "Attimo is a Brazilian operator that brands a hardware line rather than building one. Its own " +
      "PBX template writes the Fanvil key (\"Flash Server IP\"), which is the strongest evidence we have.",
  },

  htek: {
    slug: "htek",
    oem: null,
    mechanisms: ["pnp_multicast", "http_action_uri", "http_settings_write", "dhcp_option"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "Htek",
      defaultOn: true,
      confidence: "documented",
      source: "Htek auto-provision docs; corroborated by Yeastar and PortSIP PnP guides",
      notes: "Sends up to five SUBSCRIBEs and stops on a 200, a 500, or a timeout.",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: {
      method: "GET",
      path: "/Phone_ActionURL&key=Reboot",
      auth: "basic",
      confidence: "documented",
      source: "Htek Action URL documentation",
    },
    reprovision: {
      method: "GET",
      path: "/Phone_ActionURL&key=AutoP",
      auth: "basic",
      confidence: "documented",
      source: "Htek Action URL documentation",
    },
    setProvisioningUrl: null,
    dhcpOptions: [128, 150, 66],
    configFilenames: ["cfg<MAC>.xml", "cfg<model>.xml", "cfg000000000000.xml"],
    confidence: "documented",
    gaps: ["Setting the URL over HTTP needs the Auto Provision form posted; the CGI path is undocumented."],
    notes:
      "Htek's discovery order is PnP first, then DHCP, then whatever is in flash — so answering the " +
      "multicast beats anything already stored.",
  },

  clearlyip: {
    slug: "clearlyip",
    oem: "Htek (inferred — the PBX template writes Htek's P237 key verbatim)",
    mechanisms: ["pnp_multicast", "http_action_uri", "dhcp_option"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: null,
      defaultOn: true,
      confidence: "inferred",
      source: "template dialect identical to Htek",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: {
      method: "GET",
      path: "/Phone_ActionURL&key=Reboot",
      auth: "basic",
      confidence: "inferred",
      source: "Htek action URI, applied on the template-dialect match",
    },
    reprovision: {
      method: "GET",
      path: "/Phone_ActionURL&key=AutoP",
      auth: "basic",
      confidence: "inferred",
      source: "Htek action URI, applied on the template-dialect match",
    },
    setProvisioningUrl: null,
    dhcpOptions: [128, 150, 66],
    configFilenames: ["cfg<MAC>.xml", "cfg000000000000.xml"],
    confidence: "inferred",
    gaps: [
      "Only three models, and none has been seen on a network. Two of ClearlyIP's three OUI entries " +
        "are IEEE MA-M/MA-S blocks longer than six digits, so a MAC must be matched by prefix.",
    ],
    notes:
      "ClearlyIP's PBX template writes `P237 FirmwareUpGrade_ConfigServerPath`, which is Htek's own " +
      "parameter name — the same evidence that identifies the Sangoma S-series.",
  },

  sangoma: {
    slug: "sangoma",
    oem: "Htek for the S-series; Sangoma's own (Digium heritage) for the A/D/P series",
    mechanisms: ["pnp_multicast", "mdns", "sip_notify_check_sync", "http_action_uri", "dhcp_option", "vendor_redirect"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "Htek",
      defaultOn: true,
      confidence: "documented",
      source: "S-series is Htek firmware; its MAC prefix 00:1F:C1 belongs to Hanlong (Htek)",
      notes:
        "S-series only. The P-series does NOT answer a ua-profile multicast — it browses mDNS for " +
        "`_digiumproxy._udp` instead, which is why this brand needs two paths.",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: {
      method: "GET",
      path: "/Phone_ActionURL&key=Reboot",
      auth: "basic",
      confidence: "documented",
      source: "Htek Action URL documentation (S-series only)",
    },
    reprovision: {
      method: "GET",
      path: "/Phone_ActionURL&key=AutoP",
      auth: "basic",
      confidence: "documented",
      source: "Htek Action URL documentation (S-series only)",
    },
    setProvisioningUrl: null,
    dhcpOptions: [66, 128, 150],
    configFilenames: ["cfg<MAC>.xml", "<mac>.cfg", "<MAC>.cfg", "000000000000.cfg"],
    confidence: "documented",
    gaps: [
      "The P-series web page exists only while the phone is un-provisioned; once it has been set up it " +
        "locks and a factory reset is the only way back in.",
      "The P-series default web password is 789, not admin — and both become 222222 once a Sangoma " +
        "PBX has provisioned the phone.",
    ],
    notes:
      "Two unrelated platforms under one brand. Judge by the model: S2xx-S7xx are Htek, A/D/P are " +
      "Sangoma's own and take a SIP NOTIFY check-sync rather than an action URI.",
  },

  grandstream: {
    slug: "grandstream",
    oem: null,
    mechanisms: ["pnp_multicast", "http_settings_write", "http_action_uri", "dhcp_option"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "Grandstream",
      defaultOn: true,
      confidence: "documented",
      source: "Grandstream auto-provisioning documentation",
      notes:
        "Sources disagree on the port (5060 vs 5080) and on the content type (`application/url` vs " +
        "`application/x-gs-ucm-url`), so the listener must accept both rather than pick one.",
    },
    defaultCredentials: null,
    webScheme: "either",
    reboot: {
      method: "POST",
      path: "/cgi-bin/api-sys_operation?REBOOT",
      auth: "session",
      confidence: "documented",
      source: "Grandstream HTTP API — body `request=REBOOT&sid=<session>`",
    },
    reprovision: null,
    setProvisioningUrl: {
      method: "POST",
      path: "/cgi-bin/api.values.post",
      auth: "session",
      confidence: "documented",
      source:
        "Grandstream HTTP API — body `sid=<session>&P237=<path>&P212=<protocol>`. The two P-codes " +
        "are PROVEN: read off a real GXP2170 (`/cgi-bin/metaconfig_get`) and seen rendered by our " +
        "own PBX. The POST itself is still unexercised — see gaps.",
    },
    dhcpOptions: [66, 43, 160],
    // PROVEN: our PBX renders `cfg<MAC>.xml`, and that exact name serves 200 over HTTPS.
    configFilenames: ["cfg<MAC>.xml", "cfg<MAC>", "cfg<model>.xml", "cfg.xml"],
    confidence: "documented",
    gaps: [
      "Every unit built since 2017 ships with a RANDOM admin password printed on a sticker, so the " +
        "HTTP paths need the customer to read it off the phone — which is exactly the moment the " +
        "wizard has to ask, rather than guess.",
      "The WRITE has never been exercised: `dologin` was reached on a real GXP2170 but not passed " +
        "(no sticker password to hand), so `api.values.post` remains documented, not proven. The " +
        "P-codes it would carry ARE proven.",
      "Door stations (GDS) use a completely different login and config surface.",
    ],
    notes:
      "Log in first at `POST /cgi-bin/dologin` to get a session id; every other call carries it. " +
      "⛔⛔ P237 IS NOT A URL. Our PBX renders it as `209.145.60.79/phoneprov/<tenant-hash>` — no " +
      "scheme, no trailing slash — and puts the transport in P212 as a SEPARATE integer. Writing a " +
      "Yealink-shaped `https://…/` into P237 configures nothing. ⛔ And the two surfaces disagree " +
      "about P212's type: the CONFIG FILE takes an integer (0 TFTP, 1 HTTP, 2 HTTPS, 3 FTP, 4 " +
      "FTPS) while the phone's own metaconfig declares the STRINGS \"TFTP\"…\"FTPS\", so a value " +
      "correct for one surface is silently wrong on the other. " +
      "⛔ Never guess a P-code: `GET /cgi-bin/metaconfig_get` answers UNAUTHENTICATED with the " +
      "handset's own alias→P-code map (2,632 entries on a GXP2170), which is where every code " +
      "above was read from. `GET /cgi-bin/api.values.get?request=phone_model` is also " +
      "unauthenticated and returns the model — a credential-free fingerprint, useful precisely " +
      "because the admin password is on a sticker nobody has yet read.",
  },

  polycom: {
    slug: "polycom",
    oem: null,
    mechanisms: ["pnp_multicast", "http_settings_write", "dhcp_option", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: null,
      defaultOn: null,
      confidence: "inferred",
      source: "multicast provisioning is described for Poly UCS but not in the detail the others give",
    },
    defaultCredentials: { username: "Polycom", password: "456" },
    webScheme: "either",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: {
      method: "POST",
      path: "/form-submit/Utilities/configuration/importFile",
      auth: "session",
      confidence: "documented",
      source: "Poly UCS web configuration import",
    },
    dhcpOptions: [66, 160],
    configFilenames: ["<mac>.cfg", "<mac>-phone.cfg", "000000000000.cfg"],
    confidence: "documented",
    gaps: [
      "UCS 5.9.7 and later force the 456 password to be changed at first login, so a phone that has " +
        "ever been switched on may not accept the factory credentials.",
      "The common `000000000000.cfg` carries no MAC, and the tenant folder answers only filenames " +
        "that contain one — that file has to exist on disk or the phone gets a 404.",
    ],
    notes:
      "23 of the 39 Polycom models are the older SoundPoint and Edge lines whose template does not " +
      "write the provisioning URL back; those are pointed once and remember it.",
  },

  cisco: {
    slug: "cisco",
    oem: null,
    mechanisms: ["http_action_uri", "dhcp_option", "phone_menu"],
    pnp: UNSUPPORTED_PNP,
    defaultCredentials: null,
    webScheme: "either",
    reboot: {
      method: "GET",
      path: "/admin/reboot",
      auth: "basic",
      confidence: "documented",
      source: "Cisco SPA administration guide",
    },
    reprovision: {
      method: "GET",
      path: "/admin/resync?<url>",
      auth: "basic",
      confidence: "documented",
      source: "Cisco SPA administration guide — the resync URL is the whole request",
    },
    setProvisioningUrl: null,
    dhcpOptions: [160, 66, 150],
    configFilenames: ["SEP<MAC>.cnf.xml"],
    confidence: "documented",
    gaps: [
      "The MPP generation usually ships with web administration DISABLED, so nothing on the LAN can " +
        "reach it until somebody enables it at the handset.",
      "`resync` takes the URL directly, so it both points the phone and makes it fetch — but only on " +
        "the SPA generation.",
    ],
    notes:
      "The PBX template writes `Profile_Rule` pointing at `<folder>/SEP$MAU.cnf.xml`, so the filename " +
      "the phone asks for is derived from its own MAC by the firmware.",
  },

  mitel: {
    slug: "mitel",
    oem: null,
    mechanisms: ["mdns", "dhcp_option", "vendor_redirect", "phone_menu"],
    pnp: UNSUPPORTED_PNP,
    defaultCredentials: { username: "root", password: "73738" },
    webScheme: "http",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [43, 66],
    configFilenames: ["startup.cfg", "<MAC>.cfg"],
    confidence: "documented",
    gaps: [
      "This is the ONE brand whose PBX templates never write the provisioning URL at all — all 17 " +
        "models. The phone has to be pointed by DHCP, by Mitel's redirection service, or by hand.",
      "No documented HTTP request sets the server or reboots the phone.",
    ],
    notes:
      "Aastra/Mitel phones auto-discover over mDNS and otherwise expect DHCP option 43. The wizard " +
      "should say so plainly rather than appear to try and fail.",
  },

  alcatel: {
    slug: "alcatel",
    oem: null,
    mechanisms: ["dhcp_option", "phone_menu"],
    pnp: UNSUPPORTED_PNP,
    defaultCredentials: null,
    webScheme: "either",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [66, 67],
    configFilenames: ["sipconfig-<MAC>.txt"],
    confidence: "documented",
    gaps: [
      "No documented way to push a provisioning URL from the LAN — not multicast, not an HTTP call. " +
        "DHCP or the handset's own menu are the only routes found.",
    ],
    notes:
      "The template writes three different keys because the range spans two firmware families " +
      "(DeviceProvisionServerUrl / LocalEnetcfgDmUrl on the 80xx desk phones, FlashServerIP on the H series).",
  },

  dinstar: {
    slug: "dinstar",
    oem: null,
    mechanisms: ["dhcp_option", "phone_menu"],
    pnp: UNSUPPORTED_PNP,
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [66],
    configFilenames: ["<mac>.cfg"],
    confidence: "documented",
    gaps: [
      "Only DHCP 66 is documented. Seven of the fourteen models are DAG analogue gateways whose " +
        "template writes no provisioning URL at all.",
    ],
    notes: "A gateway rather than a handset for half the range, which is why so little of it is self-pointing.",
  },

  gigaset: {
    slug: "gigaset",
    oem: null,
    mechanisms: ["pnp_multicast", "dhcp_option", "vendor_redirect", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: null,
      defaultOn: true,
      confidence: "documented",
      source: "Gigaset PRO Provisioning Guide — SIP multicast is second in its discovery order",
      notes:
        "The SUBSCRIBE request URI is `sip:MAC%3A<MAC>@local` and the phone expects the PBX to " +
        "recognise the model from the User-Agent. The content type is not printed in the guide.",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "either",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [114],
    configFilenames: ["<MAC>.xml"],
    confidence: "documented",
    gaps: [
      "Gigaset reads DHCP option 114, NOT 66 — a network set up for every other brand will not " +
        "reach it.",
      "There is no HTTP or CLI way to set the URL or reboot; a booted base can only be pointed from " +
        "its own web page.",
      "Gigaset P820 IP PRO is in the catalogue with NO template on the PBX, so it cannot be rendered " +
        "at all today.",
    ],
    notes:
      "Forces a new password and a DECT band choice at first login, so the factory credentials are " +
      "good for exactly one visit.",
  },

  atcom: {
    slug: "atcom",
    oem: null,
    // The action URI is deliberately LAST: on Atcom it is not a cold-start lever at all (see gaps).
    mechanisms: ["pnp_multicast", "dhcp_option", "http_action_uri", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: "ATCOM",
      defaultOn: true,
      confidence: "documented",
      source: "How_to_Provision_ATCOM_Phones-EN.pdf — the SUBSCRIBE is printed as a packet capture",
      notes:
        "The captured Event header reads vendor=\"ATCOM\" model=\"ATCOM\", so like Snom it names the " +
        "brand but not the model. The request URI is sip:MAC%3a<MAC>@224.0.1.75.",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "either",
    reboot: {
      method: "GET",
      path: "/cgi-bin/server.cgi?key=REBOOT",
      auth: "none",
      confidence: "documented",
      source: "ATCOM Action URL and Active URI spec",
    },
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [66],
    configFilenames: ["<MAC>.cfg", "a0000000000<family>.cfg"],
    confidence: "documented",
    gaps: [
      "⛔ The action URI is gated by the phone's own allow-list of caller addresses, and the FIRST " +
        "request from an unlisted address does not run — the handset asks the person standing at it " +
        "to allow remote control. So it can never be a cold-start lever; PnP is.",
      "There is no re-provision key at all — REBOOT is the only lever, and a reboot re-runs discovery.",
      "The MAC-oriented filename is written upper-case in ATCOM's own example and lower-case " +
        "elsewhere; serve both spellings rather than pick one.",
      "base_templates carries an `atcom/a20` directory that matches no catalogue row, so nothing can " +
        "ever be pointed at it.",
    ],
    notes:
      "The PBX's OUI table already holds Atcom's real registered block (80:82:87), which matches the " +
      "MAC in the manufacturer's own packet capture — the table and the manufacturer agree.",
  },

  flyingvoice: {
    slug: "flyingvoice",
    oem: null,
    mechanisms: ["pnp_multicast", "http_action_uri", "sip_notify_check_sync", "dhcp_option", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: null,
      defaultOn: true,
      confidence: "documented",
      source: "Flyingvoice Phones Auto Provisioning Guide v1.0 — \"The PNP feature is enabled by default\"",
      notes:
        "Its own capture shows the NOTIFY body carrying the direct path to the MAC file " +
        "(tftp://host/<mac>.cfg), not just the folder — either shape is accepted.",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: {
      method: "GET",
      path: "/cgi-bin/ConfigManApp.com?key=Reboot",
      auth: "basic",
      confidence: "documented",
      source: "Flyingvoice User Guide of Action URL and Active URI",
    },
    reprovision: {
      method: "GET",
      path: "/cgi-bin/ConfigManApp.com?key=AutoP",
      auth: "basic",
      confidence: "documented",
      source: "Flyingvoice User Guide of Action URL and Active URI — \"Detect auto provision update\"",
    },
    setProvisioningUrl: null,
    dhcpOptions: [66, 67],
    configFilenames: ["<mac>.boot", "y000000000000.boot", "y000000000000.cfg", "<mac>.cfg"],
    confidence: "documented",
    gaps: [
      "⛔ The PBX's OUI table holds only 00:21:F2, which belongs to Easy3Call — the ODM block on older " +
        "stock. Flyingvoice's OWN registered block 78:99:12 (2024) is NOT in the table, so a " +
        "current-production handset is not recognised by MAC at all until it is added.",
      "The manufacturer says the action URI \"redirects to a login interface\", which reads more like a " +
        "session cookie than a plain 401 challenge — so admin/admin may not be answerable in one request.",
      "The MAC filenames are explicitly case-sensitive and must be lower-case.",
    ],
    notes:
      "A hybrid: it takes Yealink's exact filename scheme (<mac>.boot, y000000000000.cfg, with a " +
      "published fetch order) while exposing Fanvil's action-URI path (/cgi-bin/ConfigManApp.com). " +
      "It also honours a SIP NOTIFY `Event: check-sync;reboot=true`, which needs no HTTP auth at all.",
  },

  lvswitches: {
    slug: "lvswitches",
    oem: "Yealink dialect (inferred — the template writes `auto_provision.server_url`)",
    mechanisms: ["pnp_multicast", "dhcp_option", "phone_menu"],
    pnp: {
      supported: true,
      port: 5060,
      notifyContentType: "application/url",
      vendorToken: null,
      defaultOn: null,
      confidence: "inferred",
      source: "template dialect close to Yealink (underscore rather than dot before `url`)",
    },
    defaultCredentials: { username: "admin", password: "admin" },
    webScheme: "http",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [66],
    configFilenames: ["<mac>.cfg"],
    confidence: "inferred",
    gaps: [
      "No public documentation of any kind was found for this brand. Three models, and everything " +
        "here rests on the template key alone.",
    ],
    notes: "The parameter name differs from Yealink's by one character, which suggests a fork rather than a rebrand.",
  },

  nurivoice: {
    slug: "nurivoice",
    oem: null,
    mechanisms: ["dhcp_option", "phone_menu"],
    pnp: UNSUPPORTED_PNP,
    defaultCredentials: null,
    webScheme: "http",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [66],
    configFilenames: ["<mac>.cfg"],
    confidence: "unknown",
    gaps: ["No public documentation found. One model, and its `pvserverip` key matches no other brand except Hanyang."],
    notes: "Korean-market handset. The wizard should hand this to a person rather than appear to try.",
  },

  hanyang: {
    slug: "hanyang",
    oem: null,
    mechanisms: ["dhcp_option", "phone_menu"],
    pnp: UNSUPPORTED_PNP,
    defaultCredentials: null,
    webScheme: "http",
    reboot: null,
    reprovision: null,
    setProvisioningUrl: null,
    dhcpOptions: [66],
    configFilenames: ["<mac>.cfg"],
    confidence: "unknown",
    gaps: ["No public documentation found. One model, sharing Nurivoice's `pvserverip` key."],
    notes: "Almost certainly the same underlying firmware as Nurivoice, given the identical parameter name.",
  },
};

/** Every brand slug the PBX knows, in the order they appear in the catalogue. */
export const ADAPTER_SLUGS = Object.keys(VENDOR_ADAPTERS) as VendorSlug[];

/** The adapter for a brand. Total by construction — the type makes an unknown slug impossible. */
export function adapterFor(slug: VendorSlug): VendorAdapter {
  return VENDOR_ADAPTERS[slug];
}

/**
 * Every brand the PBX's OUI table says a MAC could belong to, by LONGEST prefix match.
 *
 * Returns a list, never a single answer, because the table is not a partition:
 *
 * ⛔ `0c383e` is claimed by BOTH Fanvil and Attimo — the operator added Fanvil's block to Attimo,
 * which is itself the best evidence we have that Attimo is a Fanvil rebrand. A MAC in that block
 * is genuinely ambiguous and the caller has to cope: try the Fanvil endpoints (identical either
 * way) and let the phone's own banner settle the name.
 *
 * ⛔ Longest match rather than first match: two ClearlyIP entries are IEEE MA-M/MA-S assignments
 * 7 and 9 digits long. They do not currently sit inside another brand's 24-bit block in this
 * table, but a first-match scan would be wrong the day one does.
 *
 * An empty result means the PBX has never heard of that block — which is a real state, not an
 * error. Two blocks the manufacturers publish are missing from this table today (see the
 * `gaps` on the snom and flyingvoice adapters).
 */
export function vendorsForMac(mac: string): VendorSlug[] {
  const normalized = mac.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (normalized.length < 6) return [];
  let best: VendorSlug[] = [];
  let bestLength = 0;
  for (const slug of Object.keys(VENDOR_CATALOG) as VendorSlug[]) {
    for (const prefix of VENDOR_CATALOG[slug].ouis) {
      if (!normalized.startsWith(prefix)) continue;
      if (prefix.length > bestLength) {
        best = [slug];
        bestLength = prefix.length;
      } else if (prefix.length === bestLength && !best.includes(slug)) {
        best.push(slug);
      }
    }
  }
  return best;
}

/**
 * The single brand a MAC belongs to, or null when the table is silent OR ambiguous.
 *
 * ⛔ Prefer `vendorsForMac` anywhere the ambiguity can be shown to a person. This helper exists
 * for the paths that genuinely need one answer, and it refuses rather than picking a side.
 */
export function vendorForMac(mac: string): VendorSlug | null {
  const matches = vendorsForMac(mac);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The catalogue row for a model string as a phone reports it, matched on the normalised key.
 *
 * Discovered model strings arrive with spaces, hyphens and case the catalogue does not use
 * ("SIP-T46G", "sip t46g"), so both sides are stripped to alphanumerics before comparing.
 */
export function findCatalogModel(
  modelText: string,
): { slug: VendorSlug; model: (typeof VENDOR_CATALOG)[VendorSlug]["models"][number] } | null {
  const key = modelText.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!key) return null;
  for (const slug of Object.keys(VENDOR_CATALOG) as VendorSlug[]) {
    for (const model of VENDOR_CATALOG[slug].models) {
      if (model.key === key) return { slug, model };
    }
  }
  return null;
}

/**
 * Whether the desktop app can attempt anything at all for this brand, or whether the honest
 * answer is that a person has to act.
 *
 * ⛔ This is the check the wizard must consult BEFORE showing a progress bar. Four brands -
 * Alcatel-Lucent, Dinstar, Nurivoice and Hanyang Digitech - have no mechanism a computer on the
 * LAN can drive at all, and telling a customer we are working on it would be a lie. Aastra-Mitel
 * scrapes in only because it browses mDNS.
 */
export function hasLocallyDrivableMechanism(slug: VendorSlug): boolean {
  const adapter = VENDOR_ADAPTERS[slug];
  return adapter.mechanisms.some(
    (m) => m === "pnp_multicast" || m === "http_action_uri" || m === "http_settings_write" || m === "sip_notify_check_sync" || m === "mdns",
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
 * The capability gates the wizard actually asks.
 *
 * ⛔⛔ THERE ARE TWO QUESTIONS HERE AND CONFLATING THEM COST 314 MODELS.
 *
 * Until 2026-09-11 one gate answered both, and it was `vendor === "yealink"`. Its
 * own reasoning was about the INTRUSIVE half — "the adapter speaks Yealink's Action
 * URI and check-sync; sending those at a Grandstream is not worth a try" — and that
 * reasoning is correct. But it was also gating the PASSIVE half, and the passive
 * half is not Yealink's at all:
 *
 *   • ANSWERING a phone's own PnP request is plain RFC 6080 SIP. The phone
 *     multicasts `SUBSCRIBE … Event: ua-profile` at boot and believes whoever
 *     answers. `pnp.ts` parses and builds that exchange with nothing vendor-specific
 *     in it, and TEN brands covering 369 of the PBX's 427 models send exactly that
 *     shape — every one of them port 5060, body `application/url` (measured across
 *     the catalogue, not assumed).
 *   • SENDING an HTTP request at a phone is the opposite: a vendor-specific,
 *     unauthenticated request pattern another maker's device may log or mishandle.
 *
 * So: we may LISTEN for anybody, and we may only SPEAK to a brand whose endpoints
 * we hold. Splitting the gate is what lets a Grandstream, a Polycom or a Snom be
 * finished by the same power-cycle that already finishes a Yealink.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Free-text vendor name → catalogue slug, or null when we do not recognise it.
 *
 * Vendor strings reach us from three places and none of them agree: a phone's web
 * banner ("Yealink SIP-T46G"), a SIP `User-Agent` ("Grandstream GXP2170"), and our
 * own OUI lookup (already a slug). So: strip to alphanumerics, try the slug, try a
 * short alias table of the names manufacturers actually print, then allow a longer
 * banner to carry a slug as its PREFIX ("grandstreamnetworks" → grandstream).
 *
 * ⛔ A prefix match must be unique. Two slugs matching means we do not know, and
 * "we do not know" has to stay available as an answer — the gates below are safe
 * for an unknown brand precisely because they fail toward listening, never toward
 * poking an unidentified device.
 */
const VENDOR_ALIASES: Record<string, VendorSlug> = {
  poly: "polycom",
  polycominc: "polycom",
  plantronics: "polycom",
  aastra: "mitel",
  aastramitel: "mitel",
  alcatellucent: "alcatel",
  alcatellucententerprise: "alcatel",
  flyingvoicetechnology: "flyingvoice",
  gigasetcommunications: "gigaset",
  ciscosystems: "cisco",
  clearlyipinc: "clearlyip",
};

export function vendorSlugFor(vendor: string | null | undefined): VendorSlug | null {
  const key = String(vendor ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  const slugs = Object.keys(VENDOR_ADAPTERS) as VendorSlug[];
  if ((slugs as string[]).includes(key)) return key as VendorSlug;
  const alias = VENDOR_ALIASES[key];
  if (alias) return alias;
  // A banner that CONTAINS a slug as its opening ("snomtechnologyag" -> snom). Unique
  // or nothing. ⛔ The floor is 4, not 5: the two shortest slugs are "snom" and
  // "htek" and a floor of 5 silently excluded both — Snom alone is 20 models, and
  // "snom technology AG" is exactly how that vendor's own banner reads.
  const hits = slugs.filter((s) => s.length >= 4 && key.startsWith(s));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Is this hardware address in ANY phone maker's block the PBX knows?
 *
 * ⛔ This is the admission question, and it is deliberately not "which brand". The
 * one ambiguous prefix in the table (`0c383e`, claimed by both Fanvil and Attimo —
 * which is itself the evidence Attimo is a Fanvil rebrand) is still, unambiguously,
 * a phone. Refusing to show a device because we cannot choose between two phone
 * makers would be the worst possible reading of an ambiguity.
 */
export function macIsPhoneMaker(mac: string): boolean {
  return vendorsForMac(mac).length > 0;
}

/**
 * May the office machine arm its standing PnP responder for this brand?
 *
 * ⛔⛔ TRUE FOR AN UNIDENTIFIED DEVICE, ON PURPOSE, AND THIS IS SAFE BY
 * CONSTRUCTION. Arming costs one hardware address on a listener that answers
 * nothing else: if the device is not a PnP phone it simply never asks and nothing
 * whatsoever happens to it. If it IS a PnP phone whose web page refused to identify
 * it — which is exactly what a locked phone from another provider looks like — it
 * gets connected. Failing toward listening cannot damage a device; failing away
 * from it is how the wizard abandoned the phones it exists for.
 */
export function vendorSupportsPnpHandoff(vendor: string | null | undefined): boolean {
  const slug = vendorSlugFor(vendor);
  if (!slug) return true;
  return VENDOR_ADAPTERS[slug].pnp.supported;
}

/**
 * May the office machine send an HTTP request AT a phone of this brand?
 *
 * ⛔ Requires a POSITIVE identification of a brand whose endpoints are recorded in
 * this file. An unknown brand answers FALSE — the opposite of the gate above, and
 * for the opposite reason: listening at an unidentified device is free, talking to
 * one is a guess made against somebody's hardware.
 *
 * ⛔ Today the desktop's executor (`apps/desktop/src/phoneSetup/yealink.ts`) only
 * implements Yealink's request shapes, so this is Yealink alone regardless of what
 * the catalogue records for other brands. It is written as a lookup rather than a
 * literal so that shipping a second brand's executor is a one-line change HERE,
 * beside the endpoints it would use — and so the reason is written down.
 */
const VENDORS_WITH_A_SHIPPED_HTTP_EXECUTOR: ReadonlySet<VendorSlug> = new Set<VendorSlug>(["yealink"]);

export function vendorSupportsHttpActions(vendor: string | null | undefined): boolean {
  const slug = vendorSlugFor(vendor);
  if (!slug) return false;
  if (!VENDORS_WITH_A_SHIPPED_HTTP_EXECUTOR.has(slug)) return false;
  const a = VENDOR_ADAPTERS[slug];
  return Boolean(a.reboot || a.reprovision || a.setProvisioningUrl);
}

/**
 * Can this machine attempt ANYTHING for this brand, by any mechanism?
 *
 * ⛔ This is the question the wizard must answer before it shows a progress bar.
 * False means a person has to act, and the honest screen says so rather than
 * spinning — four brands (Alcatel-Lucent, Dinstar, Nurivoice, Hanyang Digitech,
 * 31 models between them) have no mechanism a computer on the LAN can drive at all.
 */
export function vendorCanBeDrivenLocally(vendor: string | null | undefined): boolean {
  return vendorSupportsPnpHandoff(vendor) || vendorSupportsHttpActions(vendor);
}
