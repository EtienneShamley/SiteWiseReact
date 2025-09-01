// craco.config.js
const webpack = require("webpack");

module.exports = {
  webpack: {
    configure: (config) => {
      // Polyfill Node core modules required by html-to-docx deps
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
        fs: false, // not available in browser; html-to-docx doesn't use it at runtime in browser
      };

      // Provide globals some libs expect
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ["buffer", "Buffer"],
          process: ["process"],
        })
      );

      return config;
    },
  },
};
