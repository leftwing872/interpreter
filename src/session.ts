import type { WebSocket, RawData } from "ws";
import { config, perLang } from "./config.js";
import { isSupportedLanguage, AUTO } from "./languages.js";
import { TranscribeSession, type TranscriptSegment } from "./transcribe.js";
import { translate, warm, RefusalError, type ContextPair } from "./translator.js";
import { RecentLines, collapseRepeats, contentWords } from "./captioning.js";

type ClientMessage =
  | { type: "start"; language: string }
  | { type: "stop" };

type ServerMessage =
  | { type: "ready" }
  /** Live (not yet committed) text of a result. An empty text clears the live line. */
  | { type: "partial"; id: string; text: string; language?: string }
  /** A committed piece of speech; its translation follows under the same id. */
  | { type: "final"; id: string; text: string; language?: string }
  | { type: "translation_delta"; id: string; delta: string }
  /** Completed translation. `skipped` means the model found nothing to translate (filler, repeat). */
  | { type: "translation"; id: string; text: string; model?: string; ms?: number; skipped?: boolean; failed?: boolean }
  | { type: "info"; message: string }
  | { type: "ended" }
  | { type: "error"; message: string };

const MAX_RESTARTS = 5;

interface Held {
  id: string;
  text: string;
  language?: string;
  words: string[];
  timer: NodeJS.Timeout;
}

/**
 * Orchestrates one browser connection: audio in -> Transcribe -> Claude -> text out.
 */
export class InterpreterSession {
  private transcribe: TranscribeSession | null = null;
  private language = AUTO;
  private restarts = 0;
  private context: ContextPair[] = [];
  private pending = 0;
  private userStopped = false;
  private closed = false;
  private endedSent = false;
  private held: Held | null = null;
  private recent = new RecentLines(config.repeatWindowMs);

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", () => this.shutdown());
    ws.on("error", (err) => console.error("ws error", err));
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      this.transcribe?.push(new Uint8Array(chunk));
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      this.send({ type: "error", message: "invalid JSON" });
      return;
    }
    if (msg.type === "start") this.start(msg.language ?? AUTO);
    else if (msg.type === "stop") {
      this.userStopped = true;
      this.transcribe?.end();
    }
  }

  private start(language: string): void {
    if (this.transcribe) {
      this.send({ type: "error", message: "session already started" });
      return;
    }
    if (!isSupportedLanguage(language)) {
      this.send({ type: "error", message: `unsupported language: ${language}` });
      return;
    }
    this.language = language;
    this.send({ type: "ready" });
    void warm(); // first lines after a cold start otherwise wait 3-4 s on Bedrock
    this.startTranscribe();
  }

  /** Starts (or restarts) the Transcribe stream. Audio keeps flowing into the new session. */
  private startTranscribe(): void {
    const session = new TranscribeSession(this.language);
    this.transcribe = session;
    session
      .run((seg) => this.onSegment(seg))
      .then(() => {
        console.log("transcribe stream closed by service", { userStopped: this.userStopped });
      })
      .catch((err: unknown) => {
        const e = err as Error & { $metadata?: unknown };
        console.error("transcribe error", e.name, e.message, e.$metadata ?? "");
        this.send({ type: "error", message: `Transcribe ${e.name}: ${e.message}` });
      })
      .finally(() => {
        if (this.transcribe !== session) return;
        if (this.userStopped || this.closed) {
          this.releaseHeld();
          this.finishWhenIdle();
          return;
        }
        if (this.restarts >= MAX_RESTARTS) {
          this.send({ type: "error", message: `Transcribe 재연결 ${MAX_RESTARTS}회 실패, 세션을 종료합니다.` });
          this.userStopped = true;
          this.releaseHeld();
          this.finishWhenIdle();
          return;
        }
        this.restarts++;
        this.send({ type: "info", message: `Transcribe 스트림이 끊겨 재연결합니다 (${this.restarts}/${MAX_RESTARTS})` });
        this.startTranscribe();
      });
  }

  private onSegment(seg: TranscriptSegment): void {
    this.restarts = 0; // the stream is healthy; don't count earlier reconnects against the cap
    if (seg.isPartial) {
      this.send({ type: "partial", id: seg.id, text: seg.text, language: seg.language });
      return;
    }
    this.submit(seg);
  }

  /**
   * A committed piece of speech. Filler is dropped, short fragments wait to be joined with what
   * follows, and each piece is translated once and never revised.
   */
  private submit(seg: TranscriptSegment): void {
    let { id, text, words } = seg;
    const language = seg.language;
    if (this.held) {
      const h = this.held;
      this.held = null;
      clearTimeout(h.timer);
      if (h.language === language) {
        id = h.id;
        text = `${h.text}${joiner(language)}${text}`;
        words = [...h.words, ...words];
      } else {
        this.flushHeld(h);
      }
    }
    const n = contentWords(words, language);
    if (n === 0) {
      console.log(`[skip filler] ${text}`);
      return;
    }
    if (n < perLang(config.minWords, language) && !/[.?!。？！]\s*$/.test(text)) {
      const timer = setTimeout(() => this.releaseHeld(), config.holdMs);
      this.held = { id, text, language, words, timer };
      return;
    }
    this.dispatch(id, text, language, n);
  }

  private releaseHeld(): void {
    if (!this.held) return;
    const h = this.held;
    this.held = null;
    clearTimeout(h.timer);
    this.flushHeld(h);
  }

  /** Nothing followed: a lone word is usually a recognition scrap; show it only if it is a real phrase. */
  private flushHeld(h: Held): void {
    const n = contentWords(h.words, h.language);
    if (n >= perLang(config.minWords, h.language) - 1) this.dispatch(h.id, h.text, h.language, n);
    else console.log(`[skip fragment] ${h.text}`);
  }

  private dispatch(id: string, rawText: string, language: string | undefined, words: number): void {
    const text = collapseRepeats(rawText);
    if (this.recent.isRepeat(text, language)) {
      console.log(`[skip repeat] ${text}`);
      return;
    }
    this.send({ type: "final", id, text, language });
    // Snapshot the context now so translations of rapid-fire segments stay ordered.
    const context = this.context.slice(-config.contextSegments);
    const pair: ContextPair = { source: text, translation: "" };
    this.context.push(pair);
    if (this.context.length > config.contextSegments * 2) this.context.splice(0, this.context.length - config.contextSegments);
    this.pending++;
    const t0 = Date.now();
    translate(text, language, context, {
      onDelta: (delta) => this.send({ type: "translation_delta", id, delta }),
      retryOnSkip: words >= perLang(config.minWords, language),
    })
      .then((t) => {
        if (!t.text) {
          console.log(`[skip model ${t.model} ${t.ms}ms] ${text}`);
          this.send({ type: "translation", id, text: "", skipped: true, model: t.model, ms: t.ms });
          return;
        }
        pair.translation = t.text;
        console.log(`[${t.model} ${t.ms}ms] ${text} → ${t.text}`);
        this.send({ type: "translation", id, text: t.text, model: t.model, ms: t.ms });
      })
      .catch((err: unknown) => {
        const ms = Date.now() - t0;
        if (err instanceof RefusalError) {
          this.send({ type: "translation", id, text: "[번역이 거부되었습니다]", failed: true, ms });
          return;
        }
        console.error("translate error", err);
        this.send({ type: "translation", id, text: "[번역 실패]", failed: true, ms });
        this.send({ type: "error", message: `Bedrock: ${(err as Error).message}` });
      })
      .finally(() => {
        this.pending--;
        this.finishWhenIdle();
      });
  }

  /** User stopped and Transcribe has closed; once outstanding translations finish, tell the client. */
  private finishWhenIdle(): void {
    if (!this.userStopped || this.pending > 0 || this.held || this.endedSent) return;
    this.endedSent = true;
    this.send({ type: "ended" });
  }

  private shutdown(): void {
    this.closed = true;
    this.userStopped = true;
    this.transcribe?.end();
  }
}

/** Word separator when joining a held fragment with the next piece: none for CJK transcripts. */
function joiner(language: string | undefined): string {
  return /^(ja|zh)/i.test(language ?? "") ? "" : " ";
}
