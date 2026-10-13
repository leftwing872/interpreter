/**
 * Text rules for live captions: filler and mic checks, stutter loops, re-sent duplicates, and a check
 * that the model produced a subtitle rather than a reply. Ported from leeay0219/live-interpreter (Apache-2.0).
 */
import { langKey } from "./config.js";

export const SKIP = "<skip/>";

const FILLER_EN = /^(?:u+h+|u+m+|h+m+|a+h+|o+h+|e+r+|m+|h+[ae]+(?:h+[ae]+)*|y+eah|okay|ok|testing|check|mic|\d+)$/i;
const FILLER_JA = /^(?:[えあーうんおぉ]+|えっと|えーと|あの|あのー|その|そのー|はい|ええ|まあ|なんか|うーん|えっ|ん|んー|\d+)$/;
const FILLER_KO = /^(?:[어음아으에흠허하헤호오]+|그|이|저|뭐|네|예|자|막|좀|테스팅|\d+)$/;

// a microphone check is only counting and "testing"
const MIC_CHECK_WORD = /^(?:one|two|three|four|five|testing|test|check|mic|hello|テスト|マイク|もしもし|いち|に|さん|よん|ご|一|二|三|四|五|하나|둘|셋|넷|마이크|테스트|\d+)$/i;

function isFiller(word: string, lang: string): boolean {
  const w = word.replace(/[^\p{L}\p{N}']/gu, "");
  if (!w) return true;
  if (lang === "ja") return FILLER_JA.test(w) || FILLER_EN.test(w);
  if (lang === "ko") return FILLER_KO.test(w) || FILLER_EN.test(w);
  return FILLER_EN.test(w);
}

/** Words (Transcribe pronunciation items) that carry meaning: not filler, hesitation or mic-check counting. */
export function contentWords(words: string[], langCode: string | undefined): number {
  const lang = langKey(langCode);
  const clean = words.map((w) => w.replace(/[^\p{L}\p{N}']/gu, "")).filter(Boolean);
  if (clean.length && clean.every((w) => MIC_CHECK_WORD.test(w))) return 0;
  return clean.filter((w) => !isFiller(w, lang)).length;
}

/**
 * Stutters and recognition loops: "its accounts its its accounts its" → "its accounts its".
 * A run of 1 to 6 words repeated back to back is kept once (punctuation and case ignored when comparing).
 * Space-separated languages only; Japanese text without spaces passes through unchanged.
 */
export function collapseRepeats(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const key = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase());
  let n = 6;
  while (n) {
    let i = 0;
    let changed = false;
    while (i + 2 * n <= words.length) {
      const a = key.slice(i, i + n);
      const b = key.slice(i + n, i + 2 * n);
      if (a.some(Boolean) && a.every((k, j) => k === b[j])) {
        words.splice(i + n, n);
        key.splice(i + n, n);
        changed = true;
      } else {
        i++;
      }
    }
    // collapsing a short repeat can reveal a longer one, so start over from the longest
    n = changed ? 6 : n - 1;
  }
  return words.join(" ");
}

/** Comparison key for duplicate detection: lowercase content words only. */
export function norm(text: string, langCode: string | undefined): string {
  const lang = langKey(langCode);
  const words = text.match(/[\p{L}\p{N}']+/gu) ?? [];
  return words.map((w) => w.toLowerCase()).filter((w) => !isFiller(w, lang)).join(" ");
}

/** Recently translated source lines, to drop re-sent duplicates (multi-language mode re-emits audio at times). */
export class RecentLines {
  private sent: { key: string; at: number }[] = [];
  constructor(private readonly windowMs: number) {}

  /** Returns true if `text` repeats something sent within the window; otherwise records it. */
  isRepeat(text: string, langCode: string | undefined): boolean {
    const key = norm(text, langCode);
    const now = Date.now();
    this.sent = this.sent.filter((s) => now - s.at < this.windowMs);
    if (key && this.sent.some((s) => key === s.key || (key.length > 8 && s.key.includes(key)))) return true;
    this.sent.push({ key, at: now });
    return false;
  }
}

const HANGUL = /[가-힣]/;
const KANA_KANJI = /[぀-ヿ一-鿿]/;

// the model talking to us instead of subtitling; only at the start of the reply
const META = new RegExp(
  "^\\s*(?:I appreciate|I'?m ready|I am ready|I need|I don'?t see|I do not see|Let me wait|I cannot|I can'?t|" +
    "I'?m sorry|Could you (?:provide|clarify|share|give)|Please provide|No subtitle|Note:|" +
    "(?:The|This) (?:line|fragment|input|utterance)\\b|죄송|번역할 (?:내용|문장|텍스트)|번역할 수 없|맥락이|문맥이|제공해 ?주세요|다음 발화)",
  "i",
);
const NON_SPEECH = /^\s*[(*\[].*[)*\]]\s*$/; // "(silence)", "*laughter*", "[inaudible]"
export const TAGS = /<\/?(?:current_utterance|previous_utterances|line|skip)\b[^>]*>/gi;

export function isNonSpeech(tx: string): boolean {
  return NON_SPEECH.test(tx);
}

/**
 * Catch the model talking to us (asking for context, explaining) or leaving the line untranslated,
 * for a Korean target. Throws nothing; the caller decides what to do with `false`.
 */
export function looksLikeSubtitle(src: string, tx: string): boolean {
  if (!tx) return false;
  // Korean is dense: a translation several times longer than the source is not a subtitle
  if (tx.length > Math.max(60, 3 * src.length) || (tx.match(/\n/g)?.length ?? 0) > 8) return false;
  if (META.test(tx) && !META.test(src)) return false;
  const srcWords = src.split(/\s+/).filter(Boolean).length;
  if (!HANGUL.test(tx) && (srcWords > 2 || KANA_KANJI.test(src))) return false; // left untranslated
  // Latin words taken from the source (names, acronyms, code) don't count against the Hangul share
  const kept = new Set((src.match(/[A-Za-z]+/g) ?? []).map((w) => w.toLowerCase()));
  const stripped = tx.replace(/[A-Za-z]+/g, (w) => (kept.has(w.toLowerCase()) ? "" : w));
  const letters = stripped.replace(/[^A-Za-z가-힣぀-ヿ一-鿿]/g, "");
  if (!letters) return true; // only names or numbers
  const hangul = (letters.match(HANGUL_G) ?? []).length / letters.length;
  return hangul > 0.25;
}
const HANGUL_G = /[가-힣]/g;
