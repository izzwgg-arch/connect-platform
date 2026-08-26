// Which app is this bundle running as? The phone app and the Loopcom Driver
// app share one codebase; the DRIVER entry (index.driver.js) calls
// markDriverApp() before the tree mounts, and the DEMO entry
// (index.driverdemo.js) additionally calls markDriverDemo(). Shared screens
// read isDriverApp() to decide whether driver-only chrome (map/settings
// buttons, start-run) is navigable — the phone app's navigator does not
// register those routes, so rendering a button that navigates to them there
// would crash on tap. The delivery client reads isDriverDemo() to answer from
// the built-in demo run instead of the server.
//
// ⛔ Pure JS on purpose: no BuildConfig bridge, no native module — the split
// is decided by WHICH entry file the build bundled, which cannot drift from
// the applicationId because android/app/build.gradle sets both from the same
// CONNECT_DRIVER_APP / CONNECT_DRIVER_DEMO env check.

let driverApp = false;
let driverDemo = false;

export function markDriverApp(): void {
  driverApp = true;
}

export function isDriverApp(): boolean {
  return driverApp;
}

/** Demo build: fully populated run, local login, no server round-trips. */
export function markDriverDemo(): void {
  driverDemo = true;
}

export function isDriverDemo(): boolean {
  return driverDemo;
}
