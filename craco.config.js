// craco.config.js
const webpack = require("webpack");

module.exports = {
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
