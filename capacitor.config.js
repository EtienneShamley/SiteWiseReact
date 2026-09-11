// Capacitor configuration — Phase 8A minimal core spike.
//
// Wraps the existing CRA production build (`npm run build` → `build/`) as
// bundled local web assets. No `server.url` is configured: the native app
// never loads NoteWise from a remote host.
//
// TEMPORARY IDENTIFIER: `com.notewise.spike` exists only for this
// feasibility spike. It is NOT the production bundle ID / application ID and
// must be replaced with the final, deliberately chosen identifier before any
// App Store Connect or Google Play provisioning, signing or submission.
//
// Capacitor defaults are intentionally preserved (nothing under `server`):
//   iOS     origin  capacitor://localhost   (iosScheme "capacitor")
//   Android origin  https://localhost       (androidScheme "https")
//   hostname        localhost
// Android cleartext traffic and mixed content are left at their secure
// defaults (disabled).

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: "com.notewise.spike",
  appName: "NoteWise",
  webDir: "build",
};

module.exports = config;
