import {
  resolveTranslationModel,
  TranslationIntegrationUnavailableError,
  TranslationProviderError,
  toTranslationFailureCode,
  translateSentence,
} from "@chatbotx.io/ai/translation"
import {
  isWithinChannelLimit,
  languagePromptName,
  maskFragments,
  normalizeLanguageCode,
  restoreFragments,
  UnsafeTranslationOutputError,
} from "@chatbotx.io/business"
import type { AIAgentModelConfig } from "@chatbotx.io/database/partials"
import { getChildLogger, toLogSafeError } from "@chatbotx.io/logger"
import type { TranslationApiErrorCode } from "../schema/errors"

const logger = getChildLogger("translation")

/** An agent's outgoing message waits at most this long for its translation. */
export const OUTBOUND_TRANSLATION_TIMEOUT_MS = 3000
/** A preview or a settings test may take longer: nothing is waiting to be sent. */
export const INTERACTIVE_TRANSLATION_TIMEOUT_MS = 15_000

export type TranslateTextResult =
  | {
      ok: true
      text: string
      modelId: string
    }
  | { ok: false; code: TranslationApiErrorCode }

/**
 * Translates one agent-written sentence for the customer. Shared by sending
 * (3 s), the composer preview and the settings test, so all three behave and
 * fail the same way. Never throws for a provider problem: the caller decides
 * whether that means "send the original" or "show an error".
 *
 * Fragments (links, variables, code) are masked before the call and must come
 * back intact; a translation longer than the channel accepts is `tooLong`.
 */
export async function translateText(props: {
  workspaceId: string
  modelConfig: AIAgentModelConfig | null
  text: string
  targetLanguage: string
  /** Where the text will be sent; omitted for a preview or test with no channel. */
  channel?: string
  timeoutMs: number
}): Promise<TranslateTextResult> {
  const { workspaceId, text, timeoutMs } = props
  if (props.modelConfig === null) {
    return { ok: false, code: "notConfigured" }
  }

  let resolved: Awaited<ReturnType<typeof resolveTranslationModel>>
  try {
    resolved = await resolveTranslationModel({
      workspaceId,
      modelConfig: props.modelConfig,
    })
  } catch (error) {
    if (error instanceof TranslationIntegrationUnavailableError) {
      return { ok: false, code: "integrationUnavailable" }
    }
    throw error
  }

  const targetLanguage =
    normalizeLanguageCode(props.targetLanguage) ?? props.targetLanguage
  const { masked, fragments } = maskFragments(text)
  const startedAt = Date.now()
  try {
    const translatedText = await translateSentence({
      model: resolved.model,
      maskedText: masked,
      targetLanguage,
      targetLanguageName: languagePromptName(targetLanguage),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!translatedText) {
      return { ok: false, code: "providerError" }
    }
    const translated = restoreFragments(translatedText, fragments)
    if (props.channel && !isWithinChannelLimit(props.channel, translated)) {
      return { ok: false, code: "tooLong" }
    }
    return {
      ok: true,
      text: translated,
      modelId: resolved.modelId,
    }
  } catch (error) {
    if (error instanceof UnsafeTranslationOutputError) {
      return { ok: false, code: "unsafeOutput" }
    }
    const code = toTranslationFailureCode(error)
    logger.warn(
      {
        err: toLogSafeError(error),
        workspaceId,
        action: "translateText",
        reason: code,
        elapsedMs: Date.now() - startedAt,
        retryable:
          error instanceof TranslationProviderError ? error.retryable : null,
      },
      "[translation] translating text failed",
    )
    return { ok: false, code }
  }
}
