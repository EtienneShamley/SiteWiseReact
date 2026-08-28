// server/index.js
//
// Process entry point: resolve the configuration, print what this process
// will do, listen. Everything else — middleware, routes, the error contract —
// is server/app.js, so the application the tests build is the one that runs.

require("dotenv").config();

const { loadServerConfig, describeServerConfig, ServerConfigError } = require("./config");
const { createApp } = require("./app");

let config;
try {
  config = loadServerConfig(process.env);
} catch (err) {
  if (err instanceof ServerConfigError) {
    // A misconfigured server does not start with a quietly different policy.
    // eslint-disable-next-line no-console
    console.error(`[server] configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const app = createApp(config);

const server = app.listen(config.port, () => {
  const { port } = server.address();
  // eslint-disable-next-line no-console
  console.log(
    `[server] NoteWise backend listening on http://localhost:${port}\n  ${describeServerConfig(config)}`
  );
});
