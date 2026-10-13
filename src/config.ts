import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Optional shared secret. When set, /api/config and /ws require it. */
  accessToken: process.env.ACCESS_TOKEN?.trim() || null,
  transcribeRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-northeast-2",
  bedrockRegion: process.env.BEDROCK_REGION ?? "ap-northeast-2",
  bedrockModelId: process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-opus-5-5",
  /** Faster model asked in parallel when the main one is slow or fails. Empty string disables hedging. */
  bedrockFallbackModelId: process.env.BEDROCK_FALLBACK_MODEL_ID ?? "global.anthropic.claude-haiku-5-5",
  translateEffort: (process.env.TRANSLATE_EFFORT ?? "low") as "low" | "medium" | "high",
  /** If the main model has not produced its first token after this long, the fallback model is asked too. */
  hedgeAfterMs: Number(process.env.HEDGE_AFTER_MS ?? 1800),
  /** No model answered within this long: the translation fails. */
  translateDeadlineMs: Number(process.env.TRANSLATE_DEADLINE_MS ?? 12000),
  /** Audio format the browser sends: 16 kHz, 16-bit signed little-endian PCM, mono. */
  sampleRate: 16000,
  /** Number of previous finalized segments passed to Claude as context. */
  contextSegments: 6,
  /** Target language for translations. */
  targetLanguage: { code: "ko-KR", name: "Korean (한국어)" },

  /**
   * Early commit: a sentence is sent for translation as soon as Transcribe marks its words stable,
   * instead of waiting for the whole segment to be finalized (which can take 10 s+ in run-on speech).
   */
  commit: {
    /** Stable words without a sentence end before cutting at the last stable comma. */
    longWords: 14,
    /** Run-on speech with no comma either: cut at the last stable word. Keyed by language prefix. */
    maxWords: { default: 34, ja: 22 } as Record<string, number>,
  },
  /**
   * Fragments with fewer content words than this (and no sentence end) wait `holdMs` to be joined
   * with what follows. A lone fragment that is still shorter than minWords - 1 is dropped.
   */
  minWords: { default: 3, ja: 2 } as Record<string, number>,
  holdMs: 2500,
  /** A source line equal to (or contained in) one translated within this window is a re-send: dropped. */
  repeatWindowMs: 8000,
};

export function langKey(code: string | undefined): string {
  return (code ?? "").split("-")[0].toLowerCase();
}

export function perLang<T>(table: Record<string, T>, code: string | undefined): T {
  return table[langKey(code)] ?? table.default;
}
