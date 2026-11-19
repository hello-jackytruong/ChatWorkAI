"use client"

import { useMemo } from "react"
import { useChatStore } from "@/features/chat/store/chat-store-provider"
import { readConversationTranslation } from "../lib/conversation-translation"
import { useTranslationSettings } from "./use-translation-settings"

export type ActiveConversationTranslation = {
  /** The workspace switch is on (settings loaded). */
  workspaceEnabled: boolean
  /** Not turned off for this conversation. */
  conversationEnabled: boolean
  /** Translation applies to the open conversation. */
  effective: boolean
  workspaceLanguage: string | null
  language: string | null
  languageSource: "auto" | "manual" | null
}

/**
 * Whether and how translation applies to the open conversation, from the cached
 * workspace settings and the conversation's own state in the chat store. While
 * the settings load (or when the workspace has it off) everything is "off", so
 * the Inbox behaves exactly as it did before the feature.
 */
export function useConversationTranslation(): ActiveConversationTranslation {
  const { data: settings } = useTranslationSettings()
  const additionalAttributes = useChatStore(
    (state) =>
      state.conversations.find(
        (conversation) => conversation.id === state.activeConversationId,
      )?.additionalAttributes,
  )

  return useMemo(() => {
    const own = readConversationTranslation({ additionalAttributes })
    const workspaceEnabled = settings?.enabled === true
    const conversationEnabled = own.enabledOverride !== false
    return {
      workspaceEnabled,
      conversationEnabled,
      effective: workspaceEnabled && conversationEnabled,
      workspaceLanguage: settings?.workspaceLanguage ?? null,
      language: own.language,
      languageSource: own.languageSource,
    }
  }, [additionalAttributes, settings])
}
