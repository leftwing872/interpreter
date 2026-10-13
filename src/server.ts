import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request } from "express";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { INPUT_LANGUAGES } from "./languages.js";
import { InterpreterSession } from "./session.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

function tokenFrom(req: Request | http.IncomingMessage): string | null {
  const header = req.headers["x-access-token"];
  if (typeof header === "string" && header) return header;
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams.get("token");
}

function authorized(req: Request | http.IncomingMessage): boolean {
  return !config.accessToken || tokenFrom(req) === config.accessToken;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/config", (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({
    languages: INPUT_LANGUAGES.map(({ code, label }) => ({ code, label })),
    target: config.targetLanguage,
    sampleRate: config.sampleRate,
    model: config.bedrockModelId,
    authRequired: Boolean(config.accessToken),
  });
});
app.use(express.static(path.join(here, "..", "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ req }, done) => done(authorized(req), 401, "unauthorized"),
});
wss.on("connection", (ws) => new InterpreterSession(ws));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    for (const client of wss.clients) client.close(1001, "server shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server.listen(config.port, () => {
  console.log(`Interpreter listening on http://localhost:${config.port}`);
  console.log(`  Transcribe region: ${config.transcribeRegion}`);
  console.log(`  Bedrock: ${config.bedrockModelId} @ ${config.bedrockRegion} (effort=${config.translateEffort})`);
  console.log(`  Access token: ${config.accessToken ? "required" : "disabled"}`);
});
