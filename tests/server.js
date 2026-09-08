const httpServer = require("http-server");

const server = httpServer.createServer({
  root: ".",
  cache: -1,
  cors: true,
  showDir: false,
  headers: {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Origin-Agent-Cluster": "?1",
  },
});

server.listen(3000, "0.0.0.0", () => {
  console.log("Test server listening on http://localhost:3000");
});
