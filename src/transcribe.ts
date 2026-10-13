import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type AudioStream,
  type Item,
  type LanguageCode,
  type Result,
  type StartStreamTranscriptionCommandInput,
} from "@aws-sdk/client-transcribe-streaming";
import { config, perLang } from "./config.js";
import { AUTO, INPUT_LANGUAGES } from "./languages.js";

export interface TranscriptSegment {
  /** Committed pieces get `<ResultId>:<n>`; partial text keeps the bare ResultId. */
  id: string;
  text: string;
  isPartial: boolean;
  language?: string;
  /** Pronunciation items (words) of a committed piece; empty for partials. */
  words: string[];
}

const client = new TranscribeStreamingClient({ region: config.transcribeRegion });

// 100 ms of silent 16-bit PCM, injected to keep the Transcribe stream alive
// when the browser pauses sending (backgrounded tab, AudioContext suspension,
// a silent passage, or a paused video). Transcribe closes the stream after
// ~15 s with no audio; sending silence every KEEPALIVE_MS prevents that.
const KEEPALIVE_MS = 2000;
const SILENT_FRAME = new Uint8Array((config.sampleRate / 10) * 2);

const SENTENCE_END = new Set([".", "?", "!", "。", "？", "！"]);
const COMMA = new Set([",", "、", "，"]);

function isWord(it: Item): boolean {
  return it.Type !== "punctuation";
}

/** Rebuilds text from items. CJK transcripts carry no spaces between words; follow the transcript's own convention. */
function joinItems(items: Item[], spaced: boolean): string {
  let out = "";
  for (const it of items) {
    const c = it.Content ?? "";
    if (!c) continue;
    out += !out || !isWord(it) || !spaced ? c : ` ${c}`;
  }
  return out.trim();
}

/**
 * Commits each sentence as soon as Transcribe marks it stable, instead of waiting for the whole
 * segment to be finalized. Long answers without pauses would otherwise lag 15 s or more.
 *
 * Each stretch of audio is committed exactly once. Multiple-language mode sometimes re-sends audio it
 * already returned under a new result id, or re-segments a result between its partials and its final;
 * that is why the committed position is audio time, not an item index per result.
 */
class Committer {
  private until = 0; // audio time (s) up to which words have been committed
  private chunks = new Map<string, number>();

  constructor(private readonly fallbackLanguage: string | undefined, private readonly emit: (seg: TranscriptSegment) => void) {}

  /** Index of the first word not yet committed. */
  private fresh(items: Item[]): number {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (isWord(it) && ((it.StartTime ?? 0) + (it.EndTime ?? 0)) / 2 > this.until) return i;
    }
    return items.length;
  }

  private commit(rid: string, items: Item[], start: number, upto: number, language: string | undefined, spaced: boolean): void {
    const part = items.slice(start, upto);
    const text = joinItems(part, spaced);
    const ends = part.filter((it) => isWord(it) && it.EndTime).map((it) => it.EndTime as number);
    if (ends.length) this.until = Math.max(this.until, ...ends);
    if (!text || !ends.length) return;
    const n = (this.chunks.get(rid) ?? 0) + 1;
    this.chunks.set(rid, n);
    this.emit({
      id: `${rid}:${n}`,
      text,
      isPartial: false,
      language,
      words: part.filter(isWord).map((it) => it.Content ?? ""),
    });
  }

  handle(r: Result): void {
    const alt = r.Alternatives?.[0];
    const rid = r.ResultId;
    if (!alt || !rid) return;
    const items = alt.Items ?? [];
    const transcript = alt.Transcript?.trim() ?? "";
    const spaced = transcript.includes(" ") || items.filter(isWord).length <= 1;
    const language = r.LanguageCode ?? this.fallbackLanguage;
    const start = this.fresh(items);

    if (r.IsPartial) {
      let end = 0;
      let comma = 0; // last stable comma that leaves a real phrase before it
      let last = 0;
      let words = 0;
      const minBeforeComma = perLang(config.minWords, language) + 1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.Stable) break;
        if (i < start) continue;
        if (isWord(it)) {
          words++;
          last = i + 1;
        } else if (SENTENCE_END.has(it.Content ?? "")) {
          end = i + 1;
        } else if (COMMA.has(it.Content ?? "") && words >= minBeforeComma) {
          comma = i + 1;
        }
      }
      // run-on speech without a period: cut at the last stable comma once it gets long
      if (end <= start && words >= config.commit.longWords && comma > start) end = comma;
      else if (end <= start && words >= perLang(config.commit.maxWords, language)) end = last;
      if (end > start) this.commit(rid, items, start, end, language, spaced);
      const rest = items.length ? joinItems(items.slice(this.fresh(items)), spaced) : transcript;
      // an empty rest clears the live line (everything up to here has been committed)
      this.emit({ id: rid, text: rest, isPartial: true, language, words: [] });
      return;
    }

    if (items.length) {
      this.commit(rid, items, start, items.length, language, spaced);
    } else if (transcript && !this.chunks.has(rid)) {
      this.emit({ id: `${rid}:1`, text: transcript, isPartial: false, language, words: transcript.split(/\s+/) });
    }
    this.chunks.delete(rid);
    this.emit({ id: rid, text: "", isPartial: true, language, words: [] });
  }
}

/**
 * One Amazon Transcribe streaming session. Audio chunks are pushed in from the
 * WebSocket and pulled by the SDK through an async generator.
 */
export class TranscribeSession {
  private queue: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  private lastAudioAt = Date.now();
  private keepalive: NodeJS.Timeout | null = null;

  constructor(private readonly language: string) {}

  push(chunk: Uint8Array): void {
    if (this.ended) return;
    this.lastAudioAt = Date.now();
    this.queue.push(chunk);
    this.wake?.();
  }

  private startKeepalive(): void {
    this.keepalive = setInterval(() => {
      if (this.ended) return;
      if (Date.now() - this.lastAudioAt >= KEEPALIVE_MS) {
        // Do not update lastAudioAt: if the browser stays silent we keep
        // feeding silence so the stream never idles out.
        this.queue.push(SILENT_FRAME);
        this.wake?.();
      }
    }, KEEPALIVE_MS);
  }

  end(): void {
    this.ended = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    this.wake?.();
  }

  private async *audioStream(): AsyncGenerator<AudioStream> {
    while (true) {
      const chunk = this.queue.shift();
      if (chunk) {
        yield { AudioEvent: { AudioChunk: chunk } };
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }

  private buildInput(): StartStreamTranscriptionCommandInput {
    const base: StartStreamTranscriptionCommandInput = {
      MediaEncoding: "pcm",
      MediaSampleRateHertz: config.sampleRate,
      AudioStream: this.audioStream(),
      EnablePartialResultsStabilization: true,
      PartialResultsStability: "medium",
    };
    if (this.language === AUTO) {
      return {
        ...base,
        IdentifyMultipleLanguages: true,
        LanguageOptions: INPUT_LANGUAGES.map((l) => l.code).join(","),
        PreferredLanguage: INPUT_LANGUAGES[0].code as LanguageCode,
      };
    }
    return { ...base, LanguageCode: this.language as LanguageCode };
  }

  /** Runs until the audio stream ends or Transcribe closes the connection. */
  async run(onSegment: (seg: TranscriptSegment) => void): Promise<void> {
    this.startKeepalive();
    const committer = new Committer(this.language === AUTO ? undefined : this.language, onSegment);
    const response = await client.send(new StartStreamTranscriptionCommand(this.buildInput()));
    for await (const event of response.TranscriptResultStream ?? []) {
      for (const r of event.TranscriptEvent?.Transcript?.Results ?? []) committer.handle(r);
    }
  }
}
