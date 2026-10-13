import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { languageName } from "./languages.js";
import { SKIP, TAGS, isNonSpeech, looksLikeSubtitle } from "./captioning.js";

// Legacy InvokeModel client. The Mantle client prefers AWS_BEARER_TOKEN_BEDROCK
// when that env var is set, which breaks SigV4 auth on this machine.
const client = new AnthropicBedrock({ awsRegion: config.bedrockRegion });

export interface ContextPair {
  source: string;
  translation: string;
}

export interface Translation {
  /** Empty when the model skipped the line (filler, repeat, nothing to translate). */
  text: string;
  model: string;
  ms: number;
}

export class RefusalError extends Error {
  constructor() {
    super("translation refused");
    this.name = "RefusalError";
  }
}

const SYSTEM_PROMPT = `You are a professional simultaneous interpreter producing live subtitles.
Translate each utterance into natural, fluent ${config.targetLanguage.name}.

Rules:
- Output ONLY the translation. No quotes, labels, notes, romanization, or explanations. Never ask questions, explain, or refuse: every line is real speech from the session, even when it is rude or broken.
- The input is live speech-to-text: it may lack punctuation or contain recognition errors. Infer the intended meaning from context and translate what was meant. If a few words stay unclear, translate the rest and render the unclear words as heard; do not skip the line.
- The utterance is often only a piece of a sentence that continues in the next one. Translate that piece as a piece: keep it open the way the speaker left it (connective ending such as ~하고, ~는데, ~해서, or no verb). Never finish the sentence, guess where it was going, or add words that were not said. A shorter subtitle is better than a fuller one.
- Output exactly ${SKIP} only when the utterance has no content at all: filler, hesitation, laughter, a microphone check (counting, "testing"), or the same words just said again. A line with any new content is never skipped, even if it is broken or partly misheard.
- Earlier utterances and the subtitles already shown for them are context only, so terminology stays consistent and nothing is repeated. Never repeat, restate, complete, or correct them; translate only the current utterance.
- Preserve meaning, tone, strength, and who says what about whom. Convey criticism or hostility faithfully in meaning, but in an interpreter's professional words: never reproduce profanity or insults word for word, and never add or sharpen them.
- Proper nouns, product names, model names, acronyms, and code identifiers stay in their original Latin form when that is how Koreans normally write them (AWS Bedrock, Claude Opus, Kubernetes). Never translate a product or model name by its meaning.

Korean style:
- Polite spoken 합니다/해요 endings for finished sentences, even when the speaker is casual; never 반말, never 너/너희/당신 (say 여러분 or leave it out).
- Drop subjects and pronouns Korean leaves out (저는, 우리는, 그것, 그들). Never write 그것을, 그들은.
- No translationese: "X makes Y easier" → "X로 Y가 쉬워집니다". No middle dots (·) or dashes between words; write 일본과 한국 or 일본, 한국.
- Keep numbers, dates, prices, and names exactly; never round or drop them.`;

// repeated right next to every line: the model follows a reminder here far more reliably than a rule in the system prompt
const REGISTER = `(Interpreter's register: natural spoken Korean, polite 합니다/해요, never 반말 or 너/당신, no 그것/그들, no translationese; keep the meaning, its strength and who says what about whom. Output only the subtitle, or exactly ${SKIP}.)`;

function buildUserMessage(text: string, sourceLang: string | undefined, context: ContextPair[], retry: boolean): string {
  const prev = context
    .map((c) => `- ${c.source}` + (c.translation ? `\n  shown: ${c.translation}` : ""))
    .join("\n");
  const lang = languageName(sourceLang);
  return [
    prev
      ? `<previous_utterances>\n${prev}\n</previous_utterances>\n(context only; never repeat what a subtitle already said)`
      : "(start of session)",
    `Translate only this new utterance:\n<current_utterance language="${lang}">\n${text}\n</current_utterance>`,
    REGISTER,
    retry ? "This line has new content. Translate it as a piece; do not skip it." : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** Model output → subtitle text, "" for a skip. Throws when the output is not a subtitle. */
function clean(src: string, raw: string): string {
  if (raw.includes(SKIP) || isNonSpeech(raw)) return "";
  let tx = raw.replace(TAGS, "").trim(); // the model sometimes echoes the request's markup
  tx = tx.replace(/\s*[·•]\s*/g, ", ");
  if (!looksLikeSubtitle(src, tx)) throw new Error(`not a subtitle: ${JSON.stringify(tx.slice(0, 80))}`);
  return tx;
}

interface Attempt {
  model: string;
  stream: ReturnType<typeof client.messages.stream>;
  aborted: boolean;
  failed: boolean;
}

interface Options {
  onDelta?: (delta: string) => void;
  /** Ask once more when the model skips a line that clearly has content. */
  retryOnSkip?: boolean;
  models?: string[];
}

/**
 * Streams the Korean translation of `text`. The main model is asked first; if it has not produced a
 * token after `hedgeAfterMs` (or fails), the fallback model is asked too and whichever answers first is
 * shown. Deltas of the winning stream go to `onDelta`. Deltas are held back while the output could still
 * be the skip sentinel, so "<skip/>" never reaches the screen.
 */
export function translate(
  text: string,
  sourceLang: string | undefined,
  context: ContextPair[],
  opts: Options = {},
): Promise<Translation> {
  return attempt(text, sourceLang, context, opts, false).then((t) =>
    !t.text && opts.retryOnSkip ? attempt(text, sourceLang, context, opts, true).then((r) => ({ ...r, ms: t.ms + r.ms })) : t,
  );
}

function attempt(text: string, sourceLang: string | undefined, context: ContextPair[], opts: Options, retry: boolean): Promise<Translation> {
  const [main, fallback] = opts.models ?? [config.bedrockModelId, config.bedrockFallbackModelId];
  const user = buildUserMessage(text, sourceLang, context, retry);
  const t0 = Date.now();

  return new Promise<Translation>((resolve, reject) => {
    const attempts: Attempt[] = [];
    let winner: Attempt | null = null;
    let fallbackStarted = !fallback || fallback === main;
    let settled = false;
    let hedgeTimer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    // deltas held back while they could still be the start of the skip sentinel
    let held = "";
    let holding = true;

    const abort = (a: Attempt) => {
      if (a.aborted) return;
      a.aborted = true;
      try {
        a.stream.abort();
      } catch {
        /* already finished */
      }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      for (const a of attempts) abort(a);
      fn();
    };
    const claim = (a: Attempt): boolean => {
      if (settled || a.failed) return false;
      if (winner) return winner === a;
      winner = a;
      for (const o of attempts) if (o !== a) abort(o);
      return true;
    };
    const emit = (delta: string) => {
      if (!opts.onDelta) return;
      if (holding) {
        held += delta;
        if (SKIP.startsWith(held.trimStart())) return; // could still become <skip/>
        holding = false;
        delta = held;
        held = "";
      }
      opts.onDelta(delta);
    };
    const fail = (a: Attempt, err: unknown) => {
      if (settled || a.aborted) return;
      a.failed = true;
      console.warn(`translate via ${a.model} failed:`, err instanceof Error ? `${err.name}: ${err.message}` : err);
      if (winner === a) {
        // the stream we were showing broke; whatever the fallback answers will replace it
        winner = null;
        holding = true;
        held = "";
      }
      if (!fallbackStarted) {
        fallbackStarted = true;
        if (hedgeTimer) clearTimeout(hedgeTimer);
        start(fallback);
        return;
      }
      if (attempts.every((x) => x.failed)) finish(() => reject(err));
    };
    const start = (model: string) => {
      const params: Anthropic.MessageStreamParams = {
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: user }],
        output_config: { effort: config.translateEffort },
      };
      const a: Attempt = { model, stream: client.messages.stream(params), aborted: false, failed: false };
      attempts.push(a);
      a.stream.on("text", (delta: string) => {
        if (claim(a)) emit(delta);
      });
      a.stream
        .finalMessage()
        .then((message: Anthropic.Message) => {
          if (a.aborted) return;
          if (message.stop_reason === "refusal") throw new RefusalError();
          const tx = clean(text, extractText(message));
          if (!claim(a)) return;
          finish(() => resolve({ text: tx, model, ms: Date.now() - t0 }));
        })
        .catch((err: unknown) => fail(a, err));
    };

    start(main);
    if (!fallbackStarted) {
      hedgeTimer = setTimeout(() => {
        if (!winner && !fallbackStarted && !settled) {
          fallbackStarted = true;
          start(fallback);
        }
      }, config.hedgeAfterMs);
    }
    deadlineTimer = setTimeout(
      () => finish(() => reject(new Error(`no translation within ${config.translateDeadlineMs} ms`))),
      config.translateDeadlineMs,
    );
  });
}

const warmed = new Set<string>();

/**
 * Prime each model once per process (opens connections, warms the Bedrock path) while the speaker is
 * still getting started; without it the first real line after a deploy took 3-4 s.
 */
export async function warm(): Promise<void> {
  const models = [config.bedrockModelId, config.bedrockFallbackModelId].filter((m) => m && !warmed.has(m));
  for (const m of models) warmed.add(m);
  await Promise.all(
    models.map((m) =>
      attempt("Hello.", undefined, [], { models: [m, ""] }, false)
        .then((t) => console.log(`warm-up ${m}: ${t.ms} ms`))
        .catch((err) => console.warn(`warm-up ${m} failed:`, (err as Error).message)),
    ),
  );
}
