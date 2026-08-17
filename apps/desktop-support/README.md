# Loopcom Support (test build)

A **separate** Windows application from the Connect desktop app. It exists so
remote support can be installed on a couple of machines and proven before it
goes anywhere near a customer's phone system.

⛔ **Do not merge this into `apps/desktop`.** Installing this must not touch,
upgrade or replace Connect.

## Why every identifier differs from the Connect app

| | Connect | Loopcom Support |
|---|---|---|
| `appId` | `com.connectcommunications.desktop` | `com.connectcommunications.supporttools` |
| `productName` | `Connect` | `Loopcom Support` |
| Installer | `Connect-Setup-<v>.exe` | `LoopcomSupport-Setup-<v>.exe` |
| Auto-update feed | `/desktop/latest.yml` | **none** |

- A shared `appId` would make Windows treat this as an **upgrade of Connect**
  and replace it.
- A shared `productName` would make both apps share one settings folder.

## ⛔ There is deliberately no publish block and no auto-updater

Connect's updater polls `https://app.connectcomunications.com/desktop/latest.yml`.
**If this app ever published to that URL, every customer's Connect install would
download it as an update and replace their phone system with a support tool.**

When this is eventually published it MUST use its own directory — e.g.
`/desktop-support/` — and that decision is the owner's to make.

## What it does

Loads the same hosted portal as Connect, and supplies the three things a web
page cannot do:

1. Enumerate real screens (`desktopCapturer` + `setDisplayMediaRequestHandler`).
2. Drive the real mouse and keyboard (`remoteSupport/inputInjector.ts`).
3. Keep a banner above every other window (`remoteSupport/mainWiring.ts`).

Plus desk-phone discovery on the local network (`remoteSupport/lanScan.ts`).

It is deliberately much smaller than the Connect shell: one window, no tray, no
mini dialer, no SIP phone, no updater.

## How the portal knows which app it is running in

The portal's `RemoteSupportConsent` component activates **only** when
`window.connectDesktop.remoteSupport` exists. This app exposes it; the Connect
app deliberately does not.

⛔ **Adding a `remoteSupport` key to the Connect app's preload would silently
switch remote support on for the entire customer base.** That is the single
line standing between "a test build on two laptops" and "every customer polling
for support requests".

## Build and test

```bash
pnpm --filter @connect/desktop-support test        # 31 tests
pnpm --filter @connect/desktop-support typecheck
pnpm --filter @connect/desktop-support dist        # installer in release/
```

Point it at a different portal with `CONNECT_PORTAL_URL`.

## Where it actually lands on disk (verified by installing, not assumed)

| | Connect | Loopcom Support |
|---|---|---|
| Program files | `%LOCALAPPDATA%\Programs\@connectdesktop` | `%LOCALAPPDATA%\Programs\Loopcom Support` |
| App data | `%APPDATA%\@connect\desktop` | `%APPDATA%\@connect\desktop-support` |
| Logs | — | `%APPDATA%\@connect\desktop-support\logs\support.log` |

⛔ The data folders share the `@connect` parent because Electron derives
`userData` from the package **name**, not `productName` — but the subfolders
differ, so settings, localStorage and cache stay completely separate. Do not
"tidy" the two package names into one.

⛔ The install directory does NOT follow `productName` predictably either:
Connect displays as "Connect" and installs to `@connectdesktop`. Read the real
path off the installer or off disk; never guess it (an antivirus exclusion
pointing at a folder that does not exist looks like protection and is not).

## ⛔ Known: it loads the whole portal, including the softphone

Because it loads the same portal, the SIP phone starts here too. Signing into
BOTH Connect and Loopcom Support as the same user puts two registrations on one
extension, which is the contact-churn problem documented for Loopcom Demo.

For now: do not run both signed in as the same person. The proper fix is for the
portal to skip `SipPhoneProvider` when the `support=1` parameter is present
(this app already sends it).
