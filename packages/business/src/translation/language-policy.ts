import type { MessageTranslationFailureCode } from "@chatbotx.io/database/partials"

/** A detection below this confidence never sets the conversation language. */
export const LANGUAGE_MIN_CONFIDENCE = 0.8
/** Fewer words than this is too little text to trust a detection (spaced scripts). */
export const LANGUAGE_MIN_WORDS = 3
/** Fewer characters than this is too little text to trust a detection (unspaced scripts). */
export const LANGUAGE_MIN_CHARS = 12

/** Languages written without spaces between words: judged by characters, not words. */
const UNSPACED_LANGUAGES = new Set(["zh", "ja", "th", "lo", "km", "my"])

/** `und` is what the translator reports when it cannot tell the language. */
const UNKNOWN_LANGUAGE = "und"

const TRADITIONAL_REGIONS = new Set(["tw", "hk", "mo"])

/**
 * The canonical key two languages are compared by: the primary subtag
 * (`es-MX` -> `es`, `pt-BR` -> `pt`), except Chinese, whose scripts are two
 * languages for a reader: `zh-Hans` (`zh`, `zh-CN`, `zh-SG`) and `zh-Hant`
 * (`zh-TW`, `zh-HK`, `zh-MO`). Without that split a customer writing
 * Traditional in a Simplified workspace would be skipped as "same language".
 *
 * Returns `null` for an empty or unknown (`und`) language.
 */
export function normalizeLanguageCode(
  code: string | null | undefined,
): string | null {
  const parts = (code ?? "")
    .trim()
    .replaceAll("_", "-")
    .toLowerCase()
    .split("-")
    .filter(Boolean)
  const primary = parts[0]
  if (!primary || primary === UNKNOWN_LANGUAGE) {
    return null
  }
  if (primary !== "zh") {
    return primary
  }
  const rest = parts.slice(1)
  if (
    rest.includes("hant") ||
    rest.some((part) => TRADITIONAL_REGIONS.has(part))
  ) {
    return "zh-Hant"
  }
  return "zh-Hans"
}

/** Both languages known and equal under {@link normalizeLanguageCode}. */
export function isSameLanguage(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeLanguageCode(a)
  return left !== null && left === normalizeLanguageCode(b)
}

/** English display name of a language code, for the translator prompt. */
export function languagePromptName(code: string): string {
  const key = normalizeLanguageCode(code) ?? code
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(key) ?? code
  } catch {
    return code
  }
}

const WHITESPACE = /\s+/u

const countWords = (text: string): number =>
  text.trim().split(WHITESPACE).filter(Boolean).length

/**
 * Whether a detection is trustworthy enough to set the conversation language:
 * confident, and made on enough text. Short replies ("ok thanks", "gracias")
 * are still translated and shown, they just never decide the language.
 */
export function isReliableDetection(
  text: string,
  detection: { detectedLanguage: string; confidence: number },
): boolean {
  const language = normalizeLanguageCode(detection.detectedLanguage)
  if (!language || detection.confidence < LANGUAGE_MIN_CONFIDENCE) {
    return false
  }
  const trimmed = text.trim()
  if (UNSPACED_LANGUAGES.has(language.split("-")[0] ?? language)) {
    return [...trimmed].length >= LANGUAGE_MIN_CHARS
  }
  return countWords(trimmed) >= LANGUAGE_MIN_WORDS
}

export type ConversationTranslationFlags = {
  workspaceEnabled: boolean
  /** The conversation's own choice; it can only turn translation off. */
  enabledOverride?: boolean | null
}

/**
 * Translation applies to a conversation when the workspace turned it on and
 * the conversation did not opt out. The override
 * sits below the workspace setting: it cannot enable a workspace that is off.
 */
export function isTranslationEffective(
  flags: ConversationTranslationFlags,
): boolean {
  return flags.workspaceEnabled && flags.enabledOverride !== false
}

/** Maps a thrown value to a stored failure code; anything unknown is `providerError`. */
export function failureCodeOf(error: unknown): MessageTranslationFailureCode {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined
  switch (code) {
    case "integrationUnavailable":
    case "timeout":
    case "providerError":
    case "rateLimited":
    case "unsafeOutput":
      return code
    default:
      return "providerError"
  }
}
