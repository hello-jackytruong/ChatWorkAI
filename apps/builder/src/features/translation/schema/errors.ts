import { z } from "zod"

/**
 * Why a translation could not be made. Public API errors carry these as
 * `ChatbotXException.code` (`translation<Name>`); the outbound path turns any of
 * them into "send the original sentence" instead of failing the send.
 */
export const translationApiErrorCodes = z.enum([
  "disabled",
  "notConfigured",
  "integrationUnavailable",
  "unknownLanguage",
  "timeout",
  "providerError",
  "rateLimited",
  "unsafeOutput",
  "tooLong",
])
export type TranslationApiErrorCode = z.infer<typeof translationApiErrorCodes>

export const TRANSLATION_API_ERRORS = {
  disabled: {
    code: "translationDisabled",
    status: 422,
    message:
      "Translation is turned off for this workspace or conversation, or switched off by the operator.",
  },
  notConfigured: {
    code: "translationNotConfigured",
    status: 422,
    message: "Choose an AI integration and model for translation first.",
  },
  integrationUnavailable: {
    code: "translationIntegrationUnavailable",
    status: 422,
    message:
      "The AI integration chosen for translation is missing, disabled or its credentials are invalid.",
  },
  unknownLanguage: {
    code: "translationUnknownLanguage",
    status: 422,
    message:
      "The customer's language is not known yet. Set it with `translation.updateConversationState`, or wait until a customer message has been translated.",
  },
  timeout: {
    code: "translationTimeout",
    status: 504,
    message: "The AI model did not answer in time.",
  },
  providerError: {
    code: "translationProviderError",
    status: 502,
    message: "The AI provider failed to translate the text.",
  },
  rateLimited: {
    code: "translationRateLimited",
    status: 429,
    message: "The AI provider is rate limiting translation requests.",
  },
  unsafeOutput: {
    code: "translationUnsafeOutput",
    status: 422,
    message:
      "The translation changed protected content (links, variables, code) and was discarded.",
  },
  tooLong: {
    code: "translationTooLong",
    status: 422,
    message: "The translation is longer than the channel accepts.",
  },
} as const satisfies Record<
  TranslationApiErrorCode,
  { code: string; status: number; message: string }
>
