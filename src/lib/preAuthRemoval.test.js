// src/lib/preAuthRemoval.test.js
//
// The temporary pre-authentication production escape hatch
// (NOTEWISE_AI_ROUTES_PRE_AUTH=allow, Phase 3) is GONE. Once code is deleted
// no behavioural test can show it is absent, so — as with the earlier
// save-progress removal — this file asserts from source text, and only here.
// Its behavioural counterpart (the variable no longer opening anything) is
// in serverApp.test.js and serverBoot.test.js.
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.js$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("NOTEWISE_AI_ROUTES_PRE_AUTH is retired", () => {
  test("no application or server code reads it, exports it, or names the interim policy", () => {
    const files = [...walk(path.join(ROOT, "server")), ...walk(path.join(ROOT, "routes")), ...walk(path.join(ROOT, "src"))].filter(
      (f) => !/\.test\.js$/.test(f) && !/backendTestHarness\.js$/.test(f)
    );
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect({ file, hit: /NOTEWISE_AI_ROUTES_PRE_AUTH|PRE_AUTH_AI_ROUTES|preAuthOptIn|PRE-AUTH INTERIM|ai_routes_disabled|aiRoutesGate/.test(text) }).toEqual({
        file,
        hit: false,
      });
    }
  });

  test("the config exposes no route-enabling switch: identity is the only gate", () => {
    const config = read("server/config.js");
    expect(config).not.toMatch(/routesEnabled/);
    expect(config).toMatch(/FIREBASE_PROJECT_ID/);
    expect(config).toMatch(/required in production/);
    const app = read("server/app.js");
    expect(app).toMatch(/requireFirebaseUser\(/);
    expect(app).toMatch(/requireVerifiedEmail\(\)/);
    // Both provider routes are mounted through the same policy chain.
    expect(app.match(/\.\.\.providerRoutePolicy\(config, verifyIdToken/g)).toHaveLength(2);
  });

  test("the deployment/security documentation no longer describes it as a live setting", () => {
    // docs/ is gitignored and may be absent on a clean checkout (CI); assert
    // only when present.
    for (const doc of ["docs/SECURITY.md", "docs/DEPLOYMENT.md"]) {
      const full = path.join(ROOT, doc);
      if (!fs.existsSync(full)) continue;
      const text = fs.readFileSync(full, "utf8");
      // Historical mentions must say it was removed; no line may instruct
      // setting it.
      expect(text).not.toMatch(/NOTEWISE_AI_ROUTES_PRE_AUTH=allow`?\s*\|\s*`?allow`?\s*\*\*only\*\*/);
      expect(text).not.toMatch(/set NOTEWISE_AI_ROUTES_PRE_AUTH=allow/);
    }
  });
});
