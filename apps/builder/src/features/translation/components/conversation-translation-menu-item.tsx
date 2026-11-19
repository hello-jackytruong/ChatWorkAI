"use client"

import { DropdownMenuCheckboxItem } from "@chatbotx.io/ui/components/ui/dropdown-menu"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { toast } from "sonner"
import { useChatStore } from "@/features/chat/store/chat-store-provider"
import { useWorkspaceId } from "@/hooks/routing"
import { updateConversationTranslationStateAction } from "../actions/update-conversation-state.action"
import { useInvalidateTranslation } from "../hooks/use-invalidate-translation"
import { useTranslationSettings } from "../hooks/use-translation-settings"
import {
  readConversationTranslation,
  withConversationTranslation,
} from "../lib/conversation-translation"
import { useTranslationUiStore } from "../store/translation-ui-store"

/**
 * "Translate this conversation": a per-conversation off switch under the
 * workspace setting, and "Show original text" for the conversation. Rendered only while the workspace has translation on (it
 * cannot turn it on), so a workspace without the feature sees an unchanged menu.
 */
export function ConversationTranslationMenuItem(props: {
  conversation: { id: string; additionalAttributes?: unknown }
}) {
  const { conversation } = props
  const t = useTranslations("inboxTranslation.menu")
  const workspaceId = useWorkspaceId()
  const { data: settings } = useTranslationSettings()
  const updateConversation = useChatStore((state) => state.updateConversation)
  const invalidate = useInvalidateTranslation()
  const current = readConversationTranslation(conversation)
  const showAllOriginals = useTranslationUiStore(
    (state) => state.showAllOriginals[conversation.id] ?? false,
  )
  const setShowAllOriginals = useTranslationUiStore(
    (state) => state.setShowAllOriginals,
  )

  const { execute, isExecuting } = useAction(
    updateConversationTranslationStateAction.bind(
      null,
      workspaceId,
      conversation.id,
    ),
    {
      onSuccess: ({ input }) => {
        updateConversation(conversation.id, {
          additionalAttributes: withConversationTranslation(
            conversation.additionalAttributes,
            {
              ...(current.language ? { language: current.language } : {}),
              ...(current.languageSource
                ? { languageSource: current.languageSource }
                : {}),
              ...(input.enabledOverride === false
                ? { enabledOverride: false }
                : {}),
            },
          ),
        })
        invalidate()
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  if (!settings?.enabled) {
    return null
  }

  const translating = current.enabledOverride !== false
  return (
    <>
      <DropdownMenuCheckboxItem
        checked={translating}
        disabled={isExecuting}
        onCheckedChange={(checked) =>
          execute({ enabledOverride: checked ? null : false })
        }
      >
        {t("translateConversation")}
      </DropdownMenuCheckboxItem>
      {translating && (
        <DropdownMenuCheckboxItem
          checked={showAllOriginals}
          onCheckedChange={(checked) =>
            setShowAllOriginals(conversation.id, checked === true)
          }
        >
          {t("showOriginals")}
        </DropdownMenuCheckboxItem>
      )}
    </>
  )
}
