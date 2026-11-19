import { z } from "zod"

const attributesSchema = z.object({
  translation: z
    .object({
      enabledOverride: z.boolean().optional(),
      language: z.string().optional(),
      languageSource: z.enum(["auto", "manual"]).optional(),
    })
    .optional(),
})

export type ConversationTranslationAttributes = {
  /** `false`: translation was turned off for this conversation only. */
  enabledOverride: boolean | null
  language: string | null
  languageSource: "auto" | "manual" | null
}

/** Reads `additionalAttributes.translation` of a conversation; tolerates any other shape. */
export function readConversationTranslation(conversation: {
  additionalAttributes?: unknown
}): ConversationTranslationAttributes {
  const parsed = attributesSchema.safeParse(
    conversation.additionalAttributes ?? {},
  )
  const translation = parsed.success ? parsed.data.translation : undefined
  return {
    enabledOverride: translation?.enabledOverride ?? null,
    language: translation?.language ?? null,
    languageSource: translation?.languageSource ?? null,
  }
}

const recordSchema = z.record(z.string(), z.unknown())

/**
 * `additionalAttributes` with its `translation` object replaced, every other key
 * kept (a `challenge` set by a flow must survive).
 */
export function withConversationTranslation(
  additionalAttributes: unknown,
  translation: {
    enabledOverride?: boolean
    language?: string
    languageSource?: "auto" | "manual"
  },
): Record<string, unknown> {
  return {
    ...(recordSchema.safeParse(additionalAttributes).data ?? {}),
    translation,
  }
}
