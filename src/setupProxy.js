// src/setupProxy.js
const { createProxyMiddleware } = require("http-proxy-middleware");
module.exports = function (app) {
  console.log("[setupProxy] /api -> http://localhost:5050");
  app.use("/api", createProxyMiddleware({
    target: "http://localhost:5050",
    changeOrigin: true,
    ws: true,
    logLevel: "debug",
  }));
};
