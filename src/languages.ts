/**
 * Supported *input* languages. Add a new entry here to support another language.
 * `code` must be a language code supported by Amazon Transcribe streaming.
 * https://docs.aws.amazon.com/transcribe/latest/dg/supported-languages.html
 */
export interface InputLanguage {
  code: string;     // Transcribe language code
  label: string;    // shown in UI
  name: string;     // English name passed to Claude in the prompt
}

export const INPUT_LANGUAGES: InputLanguage[] = [
  { code: "en-US", label: "English", name: "English" },
  { code: "ja-JP", label: "日本語", name: "Japanese" },
  // e.g. { code: "zh-CN", label: "中文", name: "Mandarin Chinese" },
];

export const AUTO = "auto";

export function isSupportedLanguage(code: string): boolean {
  return code === AUTO || INPUT_LANGUAGES.some((l) => l.code === code);
}

export function languageName(code: string | undefined): string {
  return INPUT_LANGUAGES.find((l) => l.code === code)?.name ?? "the source language";
}
