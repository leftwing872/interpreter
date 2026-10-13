/**
 * End-to-end smoke test against a running server (npm start).
 * Usage: tsx scripts/smoke-test.ts <pcm-file-16k-s16le-mono> [language=auto] [ws://localhost:3000/ws]
 * Streams the PCM in real time, prints every server message, exits on "ended".
 */
import fs from "node:fs";
import WebSocket from "ws";

const [file, language = "auto", url = "ws://localhost:3000/ws"] = process.argv.slice(2);
if (!file) {
  console.error("usage: tsx scripts/smoke-test.ts <pcm file> [language] [ws url]");
  process.exit(1);
}
const pcm = fs.readFileSync(file);
const CHUNK = 3200; // 100 ms @ 16 kHz, 16-bit mono
const ws = new WebSocket(url);
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

ws.on("open", () => ws.send(JSON.stringify({ type: "start", language })));
ws.on("message", async (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === "translation_delta") return;
  if (msg.type === "partial" && !msg.text) return;
  const tag = msg.type === "translation" ? `${msg.skipped ? "skipped" : msg.failed ? "FAILED" : msg.model} ${msg.ms ?? ""}ms` : (msg.language ?? "");
  log(msg.type.padEnd(11), msg.id ?? "", tag, msg.text ?? msg.message ?? "");
  if (msg.type === "ready") {
    for (let off = 0; off < pcm.length; off += CHUNK) {
      ws.send(pcm.subarray(off, off + CHUNK));
      await new Promise((r) => setTimeout(r, 100));
    }
    // trailing silence so Transcribe finalizes the last segment
    const silence = Buffer.alloc(CHUNK);
    for (let i = 0; i < 20; i++) { ws.send(silence); await new Promise((r) => setTimeout(r, 100)); }
    ws.send(JSON.stringify({ type: "stop" }));
  }
  if (msg.type === "ended") { ws.close(); process.exit(0); }
});
ws.on("error", (e) => { console.error(e); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(2); }, 120_000);
