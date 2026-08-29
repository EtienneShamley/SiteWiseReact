// src/lib/backendTestHarness.js
//
// Shared helpers for the backend's executable tests: build the REAL Express
// app from a plain environment object, listen on an ephemeral port, and make
// raw HTTP requests against it (JSON and multipart). No supertest, no mocks
// of Express — the app under test is the app production runs
// (server/app.js), only the provider SDK is mocked by the individual suites.
//
// Not a test file itself; required by src/lib/server*.test.js and
// src/lib/transcribeRoute.test.js.

const http = require("http");
const path = require("path");

// Node 22 exposes `File` globally and the OpenAI SDK's `toFile` needs it;
// Jest's node sandbox does not copy that global in. Provide the platform's
// own implementation so the shipped route code runs unmodified under test.
if (typeof global.File === "undefined") {
  global.File = require("buffer").File;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/* ------------------------------ identity -------------------------------- */
//
// Tests never hold Firebase credentials and never contact Firebase. They
// inject a verifier double into the real app (server/app.js `deps`) that
// accepts only tokens minted by `issueTestIdToken` below — three base64url
// segments like a real JWS, with a fixed test "signature" — and rejects
// everything else with the SDK's own error codes. The middleware under test
// is the shipped one; only the cryptographic check is replaced.

const TEST_TOKEN_SIGNATURE = "test-signature";
const TEST_PROJECT_ID = "notewise-test";

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * A token the test verifier accepts. `exp` (seconds since epoch) in the past
 * makes the verifier reject it as expired.
 */
function issueTestIdToken({ uid = "user-test-1", emailVerified = true, exp } = {}) {
  const header = { alg: "RS256", typ: "JWT", kid: "test" };
  const payload = { uid, sub: uid, email_verified: emailVerified, aud: TEST_PROJECT_ID };
  if (exp !== undefined) payload.exp = exp;
  return `${b64url(header)}.${b64url(payload)}.${TEST_TOKEN_SIGNATURE}`;
}

function firebaseStyleError(code) {
  return Object.assign(new Error(`Firebase ID token verification failed (${code})`), { code });
}

/** The verifier double: accepts `issueTestIdToken` output and nothing else. */
function testIdTokenVerifier() {
  return async (idToken) => {
    const parts = String(idToken).split(".");
    if (parts.length !== 3 || parts[2] !== TEST_TOKEN_SIGNATURE) {
      throw firebaseStyleError("auth/argument-error");
    }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      throw firebaseStyleError("auth/argument-error");
    }
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      throw firebaseStyleError("auth/id-token-expired");
    }
    return payload;
  };
}

/** `{ Authorization }` for a verified (by default) test user. */
function authHeaders(options) {
  return { Authorization: `Bearer ${issueTestIdToken(options)}` };
}

/**
 * Build the real app for one environment. Fresh modules each time. Unless a
 * test passes its own `verifyIdToken` (including `null` for "no verifier"),
 * the test verifier above is injected, and FIREBASE_PROJECT_ID is supplied
 * so a production-mode config resolves — the Firebase SDK is never loaded.
 */
function buildApp(env, deps = {}) {
  const { loadServerConfig } = require(path.join(REPO_ROOT, "server", "config"));
  const { createApp } = require(path.join(REPO_ROOT, "server", "app"));
  const config = loadServerConfig({ NODE_ENV: "test", FIREBASE_PROJECT_ID: TEST_PROJECT_ID, ...env });
  const withVerifier = "verifyIdToken" in deps ? deps : { ...deps, verifyIdToken: testIdTokenVerifier() };
  return { app: createApp(config, withVerifier), config };
}

/** Start the app on an ephemeral port; returns { port, close }. */
function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        server,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * One raw HTTP request. `body` may be a string or Buffer; headers are sent
 * as given (Content-Length is filled in when a body is present and none was
 * declared). The response body is parsed as JSON when it is JSON.
 */
function request(port, { method = "GET", path: reqPath = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    const finalHeaders = { ...headers };
    if (payload && finalHeaders["Content-Length"] === undefined && finalHeaders["content-length"] === undefined) {
      finalHeaders["Content-Length"] = payload.length;
    }
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers: finalHeaders },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          if (/application\/json/i.test(res.headers["content-type"] || "")) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function postJson(port, reqPath, value, headers = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return request(port, {
    method: "POST",
    path: reqPath,
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

/**
 * Build a multipart/form-data body by hand.
 * @param {Array<{name: string, value?: string, filename?: string, type?: string, data?: Buffer}>} parts
 */
function multipart(parts, boundary = "----notewise-test-boundary") {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.data !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename || "audio.webm"}"\r\n` +
            `Content-Type: ${part.type || "audio/webm"}\r\n\r\n`
        )
      );
      chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ""}`));
    }
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  };
}

// Byte-accurate audio container headers for the sniffer. The rest of each
// buffer is filler: the route decides on the header, the provider is mocked.
function webmBytes(size = 64) {
  const b = Buffer.alloc(size, 0x11);
  b[0] = 0x1a;
  b[1] = 0x45;
  b[2] = 0xdf;
  b[3] = 0xa3;
  return b;
}
function oggBytes(size = 64) {
  const b = Buffer.alloc(size, 0x22);
  b.write("OggS", 0, "latin1");
  return b;
}
function wavBytes(size = 64) {
  const b = Buffer.alloc(size, 0x33);
  b.write("RIFF", 0, "latin1");
  b.write("WAVE", 8, "latin1");
  return b;
}
function m4aBytes(size = 64) {
  const b = Buffer.alloc(size, 0x44);
  b.write("ftyp", 4, "latin1");
  return b;
}
function mp3Id3Bytes(size = 64) {
  const b = Buffer.alloc(size, 0x55);
  b.write("ID3", 0, "latin1");
  return b;
}
function mp3FrameBytes(size = 64) {
  const b = Buffer.alloc(size, 0x66);
  b[0] = 0xff;
  b[1] = 0xfb;
  return b;
}
function flacBytes(size = 64) {
  const b = Buffer.alloc(size, 0x77);
  b.write("fLaC", 0, "latin1");
  return b;
}

/** A logger that records every event instead of printing it. */
function recordingLogger() {
  const events = [];
  return {
    events,
    logger: {
      event(name, fields) {
        events.push({ name, ...fields });
      },
    },
    text: () => JSON.stringify(events),
  };
}

module.exports = {
  REPO_ROOT,
  TEST_PROJECT_ID,
  TEST_TOKEN_SIGNATURE,
  issueTestIdToken,
  testIdTokenVerifier,
  authHeaders,
  buildApp,
  listen,
  request,
  postJson,
  multipart,
  webmBytes,
  oggBytes,
  wavBytes,
  m4aBytes,
  mp3Id3Bytes,
  mp3FrameBytes,
  flacBytes,
  recordingLogger,
};
