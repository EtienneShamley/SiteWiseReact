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

/** Build the real app for one environment. Fresh modules each time. */
function buildApp(env, deps) {
  const { loadServerConfig } = require(path.join(REPO_ROOT, "server", "config"));
  const { createApp } = require(path.join(REPO_ROOT, "server", "app"));
  const config = loadServerConfig({ NODE_ENV: "test", ...env });
  return { app: createApp(config, deps), config };
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
