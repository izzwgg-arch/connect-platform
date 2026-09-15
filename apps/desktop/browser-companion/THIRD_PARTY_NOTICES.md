# Browser Companion third-party evaluation

Reviewed 2026-09-14. No Browser Controller, Browser MCP, or Playwright source was copied into the extension/bridge; those files are original Loopcom implementation. Existing Electron/Node distribution notices remain applicable.

| Project | Observed version/status | License | Assessment |
|---|---|---|---|
| [Browser Controller](https://github.com/compnew2006/browser-controller) | Current repository inspected; release version not verified | MIT per repository | Real-browser extension/MCP architecture with localhost enrollment. Useful comparison; not adopted. Full maintenance/security evaluation outstanding. |
| [Browser MCP](https://github.com/BrowserMCP/mcp) | package.json 0.1.3; README says standalone build lacks private monorepo dependencies | Apache-2.0 | Real-profile extension/MCP design, but incomplete standalone build source makes direct adoption unsuitable without further work. |
| [Playwright](https://github.com/microsoft/playwright) | Official npm latest 1.63.0 on this date; main source 1.64.0-next | Apache-2.0 | Existing-browser extension support and accessibility tooling. Used ONLY as isolated development test dependency, not shipped in Browser Companion. npm package retains its license notices. |
| Electron | Existing repo dependency 41.5.0 | MIT plus bundled component notices | Existing desktop runtime; safeStorage protects desktop pairing key. |

Official architectural references: [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger), [supported installation methods](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions), [Playwright extension](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md).

Native messaging avoids a TCP listener but requires an additional signed native executable, registry manifest, origin binding and installer lifecycle. This implementation uses the existing Electron main process with explicitly loopback-only, mutually authenticated polling, exact Origin/Host checks, expiration and replay checks. No unauthenticated automation endpoint is exposed. Complete native-messaging versus polling reliability/performance comparison is still pending.

Chrome permissions: storage (pairing/session state), alarms (bounded reconnect wakeup), scripting (isolated DOM operations), downloads (task downloads only), activeTab (explicit sharing), loopback host permission (bridge). Arbitrary site access is optional and requested per-origin by popup user gesture. Debugger is optional for screenshot/file-input operations. No cookies/history/webRequest permission; no all_urls required grant. Broad optional HTTP(S) patterns are necessary to let the person choose arbitrary task sites.

Production: Chrome Web Store or officially supported managed enterprise distribution; unpacked loading is development-only. No Chrome-security bypass, GPL or AGPL code is introduced.
