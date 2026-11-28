"use client"

import { channelTypes } from "@chatbotx.io/database/partials"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@chatbotx.io/ui/components/ui/avatar"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@chatbotx.io/ui/components/ui/tooltip"
import { ArrowLeftIcon, BotIcon, UserRoundIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { toast } from "sonner"
import { contactDisplayName } from "@/features/contacts/lib/contact-display-name"
import { useAvatarUrl } from "@/features/contacts/utils"
import { withoutTranslationTurnedOn } from "@/features/translation/lib/conversation-translation"
import { getZaloGroupConversation } from "@/features/zalo-accounts/lib/group-content"
import { useWorkspaceId } from "@/hooks/routing"
import { useChatStore } from "../chat/store/chat-store-provider"
import { enableBotAction } from "../conversations/actions/enable-bot.action"
import { ThreadControlPassButton } from "../conversations/components/thread-control-pass-button"
import { ThreadControlReleaseButton } from "../conversations/components/thread-control-release-button"
import { UpdateConversationAssignee } from "../conversations/components/update-conversation-assignee"
import { ConversationAction } from "../conversations/conversation-action"
import { isConversationActive } from "../conversations/utils/bot-state"
import { findContactInboxByChannel } from "../conversations/utils/contact-inbox"
import { useOutboundCallMode } from "../integration-whatsapp/calling/voip/use-outbound-call-mode"
import { WhatsappVoipCallButton } from "../integration-whatsapp/calling/voip/whatsapp-voip-call-button"
import { useOptionalWhatsappVoipCallContext } from "../integration-whatsapp/calling/voip/whatsapp-voip-call-context"

/**
 * `onBack` and `onOpenContact` are supplied only by the mobile inbox layout,
 * where the conversation list and the contact panel are separate views rather
 * than adjacent columns. On desktop both are omitted and nothing extra renders.
 */
export default function MessageHead({
  onBack,
  onOpenContact,
  timelineSlotRef,
}: {
  onBack?: () => void
  onOpenContact?: () => void
  timelineSlotRef?: (node: HTMLDivElement | null) => void
}) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()

  const {
    conversations,
    activeConversationId,
    setAssignee,
    updateConversation,
  } = useChatStore((state) => state)

  const activeConversation = conversations.find(
    (c) => c.id === activeConversationId,
  )
  const groupAudience = getZaloGroupConversation(activeConversation)
  const contactName = contactDisplayName(activeConversation?.contact)
  const avatarUrl = useAvatarUrl(activeConversation?.contact)

  const voipCallContext = useOptionalWhatsappVoipCallContext()

  // Resolves in the background — never blocks this header's own render (the
  // VoIP call button below renders synchronously from data already in
  // scope). The query only decides what a CLICK on the VoIP button does — if
  // it is still pending when clicked, the `preparing` phase absorbs the wait.
  const outboundCallMode = useOutboundCallMode(
    workspaceId,
    activeConversation?.id,
    undefined,
    { enabled: Boolean(voipCallContext) },
  )

  // Whether this conversation has a WhatsApp contact inbox at all — the
  // VoIP call button renders for every WhatsApp conversation regardless of
  // whether `outboundCallMode` has resolved yet.
  const whatsappContactInbox = findContactInboxByChannel(
    activeConversation,
    channelTypes.enum.whatsapp,
  )

  const { execute: enableBot, isExecuting: isEnablingBot } = useAction(
    enableBotAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        if (activeConversation) {
          updateConversation(activeConversation.id, {
            botEnabled: true,
            botResumeAt: null,
            additionalAttributes: withoutTranslationTurnedOn(
              activeConversation.additionalAttributes,
            ),
          })
        }
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  return (
    activeConversation && (
      <div className="flex shrink-0 items-center gap-1 border-b px-3 pb-3 sm:gap-2">
        {onBack && (
          <Button
            aria-label={t("actions.back")}
            className="shrink-0"
            onClick={onBack}
            size="icon"
            variant="ghost"
          >
            <ArrowLeftIcon className="rtl:rotate-180" />
          </Button>
        )}
        <Avatar className="size-8 shrink-0 sm:size-9">
          <AvatarImage alt="" className="object-cover" src={avatarUrl} />
          <AvatarFallback aria-hidden="true">
            {contactName ? (
              contactName.slice(0, 2).toUpperCase()
            ) : (
              <UserRoundIcon className="size-4" />
            )}
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="truncate font-medium text-semibold">
            {contactName}
            {groupAudience && (
              <span className="ms-2 text-muted-foreground text-xs">
                {t("zaloAccount.groupBadge")} · {groupAudience.memberCount ?? 0}
              </span>
            )}
          </div>
          <UpdateConversationAssignee
            conversation={activeConversation}
            onChange={setAssignee}
          />
        </div>
        {whatsappContactInbox && (
          <WhatsappVoipCallButton
            contactInboxId={whatsappContactInbox.id}
            contactName={contactName}
            conversationId={activeConversation.id}
            outboundCallMode={outboundCallMode.data}
          />
        )}
        <ThreadControlReleaseButton conversation={activeConversation} />
        {!(groupAudience || isConversationActive(activeConversation)) && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={t("actions.transferConversationToBot")}
                  disabled={isEnablingBot}
                  onClick={() => {
                    enableBot({ ids: [activeConversation.id] })
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <BotIcon />
                </Button>
              }
            />
            <TooltipContent>
              <p>{t("actions.transferConversationToBot")}</p>
            </TooltipContent>
          </Tooltip>
        )}
        {timelineSlotRef &&
          activeConversation.contactInboxes?.[0]?.channel === "zaloAccount" && (
            <div
              className="flex shrink-0 items-center empty:hidden"
              ref={timelineSlotRef}
            />
          )}
        {onOpenContact && (
          <Button
            aria-label={
              groupAudience
                ? t("zaloAccount.groupBadge")
                : t("fields.contact.label")
            }
            className="shrink-0"
            onClick={onOpenContact}
            size="icon"
            variant="ghost"
          >
            <UserRoundIcon />
          </Button>
        )}
        <ThreadControlPassButton conversation={activeConversation} />
        <ConversationAction conversation={activeConversation} />
      </div>
    )
  )
}
