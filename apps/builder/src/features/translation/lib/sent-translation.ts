import { z } from "zod"
import { messageTranslationResource } from "../schema/resource"

const sentMessageSchema = z.object({
  id: z.string(),
  translation: messageTranslationResource.optional(),
  translationFallback: z.object({ reason: z.string() }).nullable().optional(),
})

/** Reasons worth telling the agent about: a translation was wanted and failed. */
const WARN_REASONS = new Set([
  "timeout",
  "providerError",
  "rateLimited",
  "unsafeOutput",
  "tooLong",
  "integrationUnavailable",
])

export type SentTranslation = {
  messageId: string
  translation: NonNullable<z.infer<typeof messageTranslationResource>> | null
  /** Set when the original sentence was sent and the agent should be told. */
  warnFallback: boolean
}

/** What the send action returned about translation; `null` when it carried none. */
export function readSentTranslation(data: unknown): SentTranslation | null {
  const parsed = sentMessageSchema.safeParse(data)
  if (!parsed.success) {
    return null
  }
  const { id, translation, translationFallback } = parsed.data
  return {
    messageId: id,
    translation: translation ?? null,
    warnFallback: translationFallback
      ? WARN_REASONS.has(translationFallback.reason)
      : false,
  }
}
