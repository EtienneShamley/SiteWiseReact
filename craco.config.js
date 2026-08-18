// craco.config.js
const webpack = require("webpack");

module.exports = {
  // Test-only resolution. `@tiptap/pm/*` is an alias package whose published
  // entry points are TypeScript sources resolved through the "exports" field;
  // webpack handles that, Jest's CommonJS resolver does not and fails on the
  // raw `export *`. Mapping the ProseMirror sub-paths the app and its tests
  // actually import onto the underlying packages (which ship a CJS build)
  // lets the Free-form page-spacer plugin, the media drop-indicator plugin
  // and the media move transaction be tested against a REAL ProseMirror
  // schema, document, DecorationSet and history instead of source-text
  // assertions. This affects the test runner only — no production build,
  // dependency or import changes.
  jest: {
    configure: (config) => ({
      ...config,
      moduleNameMapper: {
        ...(config.moduleNameMapper || {}),
        "^@tiptap/pm/([a-z-]+)$": "prosemirror-$1",
        "^@tiptap/core/(jsx-runtime|jsx-dev-runtime)$": "@tiptap/core/$1/index.cjs",
      },
    }),
  },
  webpack: {
    configure: (config) => {
      // Polyfills
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        buffer: require.resolve("buffer/"),
        process: require.resolve("process/browser"),
        util: require.resolve("util/"),
        path: require.resolve("path-browserify"),
        stream: require.resolve("stream-browserify"),
        url: require.resolve("url/"),
        crypto: require.resolve("crypto-browserify"),
        http: require.resolve("stream-http"),
        https: require.resolve("https-browserify"),
        zlib: require.resolve("browserify-zlib"),
        assert: require.resolve("assert/"),
        fs: false,
        vm: require.resolve("vm-browserify"),
      };

      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
          process: ["process"],
        })
      );

      // Suppress noisy third-party source-map warnings
      config.ignoreWarnings = [
        (warning) =>
          typeof warning?.message === "string" &&
          warning.message.includes("Failed to parse source map") &&
          (
            warning.message.includes("@oozcitak") ||
            warning.message.includes("xmlbuilder2")
          ),
      ];

      // Belt-and-braces: ensure source-map-loader doesn't try to pre-load for these deps
      config.module.rules.push({
        enforce: "pre",
        test: /\.js$/,
        exclude: [
          /node_modules\/xmlbuilder2/,
          /node_modules\/@oozcitak/,
        ],
        loader: require.resolve("source-map-loader"),
      });

      return config;
    },
  },
};
