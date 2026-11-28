"use client"

import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
import type { ZaloAccountQuote } from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Skeleton } from "@chatbotx.io/ui/components/ui/skeleton"
import { cn } from "@chatbotx.io/ui/lib/utils"
import { createId } from "@chatbotx.io/utils"
import { ArrowDownIcon, ReplyIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  type GridComponents,
  Virtuoso,
  type VirtuosoHandle,
} from "react-virtuoso"
import { toast } from "sonner"
import { contactDisplayName } from "@/features/contacts/lib/contact-display-name"
import { TranslatedMessage } from "@/features/translation/components/translated-message"
import { useRequestTranslations } from "@/features/translation/hooks/use-request-translations"
import { useZaloInspectPermission } from "@/features/zalo-accounts/components/zalo-inspect-permission"
import { useWorkspaceId } from "@/hooks/routing"
import { INBOX_MESSAGES_PER_PAGE } from "../chat/store/chat-store"
import { useChatStore } from "../chat/store/chat-store-provider"
import { ConversationInfo } from "../conversations/components/conversation-info"
import {
  getZaloMessageActivityDetailsAction,
  setZaloMessageReactionAction,
} from "../zalo-accounts/actions/message-activity.action"
import {
  getZaloGroupConversation,
  getZaloGroupMessage,
  getZaloGroupQuote,
} from "../zalo-accounts/lib/group-content"
import {
  getZaloMessageActivityThread,
  providerMessageIdForZaloActivity,
} from "../zalo-accounts/lib/message-activity"
import { useZaloMessageState } from "../zalo-accounts/queries/use-group-message-state"
import { changeMessageAttributesAction } from "./actions/change-message-attributes.action"
import { deleteMessageAction } from "./actions/delete-message.action"
import { editMessageAction } from "./actions/edit-message.action"
import { MessageItem } from "./components/message-item"
import { ResendMessageButton } from "./components/resend-message-button"
import { ZaloAccountMessageActions } from "./components/zalo-account-message-actions"
import { ZaloAlbumBubble } from "./components/zalo-album-bubble"
import { ZaloForwardDialog } from "./components/zalo-forward-dialog"
import type { ZaloMessageActivity } from "./components/zalo-message-activity"
import { ZaloMessageEvidence } from "./components/zalo-message-evidence"
import { ZaloQuoteDialog } from "./components/zalo-quote-dialog"
import { ZaloTimelineDialog } from "./components/zalo-timeline-dialog"
import { canPrivateReplyToComment } from "./lib/private-reply"
import { enqueueSend, isSendQueueLocked } from "./lib/send-queue"
import { buildZaloConversationRows } from "./lib/zalo-conversation-rows"
import { zaloMessageLabel } from "./lib/zalo-message-label"
import { getZaloAccountAttributes } from "./lib/zalo-rich-message"
import { createMessageWithRoutingBypassRequest } from "./schema/mutation"
import type { MessageResourceWithRelations } from "./schema/resource"

const START_INDEX = 100_000

export function MessageList({
  timelineSlot,
}: {
  timelineSlot?: HTMLElement | null
}) {
  const canInspectZalo = useZaloInspectPermission()
  const workspaceId = useWorkspaceId()
  const t = useTranslations()

  const {
    conversations,
    messages,
    loadInitialMessages,
    loadMoreMessages,
    isLoadMoreMessage,
    hasNextMessagePage,
    lastPrependedCount,
    prependSeq,
    activeConversationId,
    setReplyToMessage,
    markMessagesDeleted,
    markMessagesRestored,
    updateMessageText,
    updateMessageAttributes,
    sendQueues,
    updateSendQueue,
  } = useChatStore((state) => state)

  // Asks for the visible inbound messages to be translated; a no-op while
  // translation is off, so the Inbox is unchanged for such workspaces.
  useRequestTranslations()

  // Which channel this conversation belongs to, for the private-reply gate
  // below. The same `contactInboxes[0].channel` the store reads elsewhere.
  const currentConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const activeInbox = currentConversation?.contactInboxes?.[0]
  const activeChannel = activeInbox?.channel
  const zaloInboxes = useMemo(
    () =>
      new Set(
        (currentConversation?.contactInboxes ?? []).flatMap((inbox) =>
          inbox.channel === "zaloAccount" ? [inbox.id] : [],
        ),
      ),
    [currentConversation?.contactInboxes],
  )
  const rows = useMemo(
    () => buildZaloConversationRows(messages, zaloInboxes),
    [messages, zaloInboxes],
  )
  const rowIndexByMessage = useMemo(
    () =>
      new Map(
        rows.flatMap((row, index) =>
          row.items.map((message) => [message.id, index] as const),
        ),
      ),
    [rows],
  )
  const membersBySource = useMemo(
    () =>
      new Map(
        messages.flatMap((message) =>
          message.sourceId ? [[message.sourceId, message] as const] : [],
        ),
      ),
    [messages],
  )
  const [highlightedId, setHighlightedId] = useState<string>()
  const [quoteDialog, setQuoteDialog] = useState<{
    conversationId: string
    contactInboxId: string
    accountId: string
    quote: ZaloAccountQuote
  }>()
  const [forwardMessageId, setForwardMessageId] = useState<string>()
  const forwardMessage = messages.find(
    (message) =>
      message.id === forwardMessageId &&
      message.conversationId === activeConversationId &&
      canForward(message),
  )
  const forwardInboxId = currentConversation?.contactInboxes.find(
    (inbox) =>
      inbox.channel === "zaloAccount" &&
      inbox.id === forwardMessage?.contactInboxId,
  )?.inboxId
  const forwardDestinations = forwardInboxId
    ? conversations.flatMap((conversation) => {
        const name = contactDisplayName(conversation.contact)
        return name &&
          conversation.contactInboxes.some(
            (inbox) =>
              inbox.channel === "zaloAccount" &&
              inbox.inboxId === forwardInboxId,
          )
          ? [{ id: conversation.id, name }]
          : []
      })
    : []
  const groupAudience = getZaloGroupConversation(currentConversation)
  const activityThread = getZaloMessageActivityThread(
    currentConversation,
    messages,
  )
  const groupProfileScope = activityThread?.group
    ? {
        workspaceId,
        accountId: activityThread.accountId,
        conversationId: activityThread.conversationId,
        contactInboxId: activityThread.contactInboxId,
      }
    : undefined
  const groupProfileFor = (message: MessageResourceWithRelations) =>
    groupProfileScope &&
    providerMessageIdForZaloActivity(message, activityThread)
      ? groupProfileScope
      : undefined
  const activeZaloAccountId =
    activeInbox?.channel === "zaloAccount"
      ? (groupAudience?.accountId ??
        messages.find(
          (message) =>
            message.contactInboxId === activeInbox.id &&
            parseZaloAccountSourceId(message.sourceId),
        )?.sourceId)
      : undefined
  const timelineAccountId =
    parseZaloAccountSourceId(activeZaloAccountId)?.accountId ??
    activeZaloAccountId
  const [visibleProviderIds, setVisibleProviderIds] = useState<{
    conversationId: string | null
    ids: string[]
  }>()
  const messageState = useZaloMessageState(
    workspaceId,
    activityThread,
    visibleProviderIds?.conversationId === activeConversationId
      ? (visibleProviderIds?.ids ?? [])
      : [],
  )
  const actorNames = new Map<string, string>()
  if (activityThread?.group) {
    for (const message of messages) {
      const sender = getZaloGroupMessage(message.contentAttributes)
      if (
        message.conversationId === activeConversationId &&
        message.contactInboxId === activityThread.contactInboxId &&
        sender?.threadId === activityThread.group.providerGroupId &&
        sender.senderName?.trim()
      ) {
        actorNames.set(sender.senderId, sender.senderName.trim())
      }
    }
  } else if (activityThread?.directProviderUid) {
    const contactName = currentConversation?.contact?.fullName?.trim()
    if (contactName) {
      actorNames.set(activityThread.directProviderUid, contactName)
    }
  }
  const activityFor = (
    message: MessageResourceWithRelations,
  ): ZaloMessageActivity | undefined => {
    const providerMessageId = providerMessageIdForZaloActivity(
      message,
      activityThread,
    )
    if (
      !(activityThread && providerMessageId) ||
      message.deletedAt ||
      zaloMessageLabel(message)
    ) {
      return
    }
    const { accountId, conversationId } = activityThread
    const pointer = {
      conversationId,
      messageId: message.id,
      messageCreatedAt: message.createdAt,
    }
    const receipt = messageState.data?.receipts.find(
      (item) => item.providerMessageId === providerMessageId,
    )
    const reactions =
      messageState.data?.reactions.filter(
        (item) => item.providerMessageId === providerMessageId,
      ) ?? []
    return {
      threadType: activityThread.group ? "group" : "user",
      outgoing: message.messageType === "outgoing",
      sent: !message.sendError,
      receipt,
      reactions,
      actorName: (actorId) => actorNames.get(actorId),
      loadDetails: async () => {
        const result = await getZaloMessageActivityDetailsAction(
          workspaceId,
          accountId,
          pointer,
        )
        if (!result?.data) {
          throw new Error("Could not load Zalo message activity details")
        }
        return result.data
      },
      changeReaction: messageState.data?.canReact
        ? async (reaction) => {
            try {
              const result = await setZaloMessageReactionAction(
                workspaceId,
                accountId,
                {
                  ...pointer,
                  reaction,
                  commandId: crypto.randomUUID(),
                },
              )
              if (result?.data?.accepted) {
                await messageState.invalidate()
                return true
              }
            } catch {
              // The provider echo is the source of truth for visible evidence.
            }
            toast.error(t("zaloAccount.activity.reactionFailed"))
            return false
          }
        : undefined,
    }
  }

  const { execute: deleteMessage } = useAction(
    deleteMessageAction.bind(null, workspaceId, activeConversationId ?? ""),
    {
      onSuccess: () => {
        toast.success(t("messages.deleteMessageSuccess"))
      },
      onError: ({ error, input }) => {
        markMessagesRestored([input.id])
        toast.error(error.serverError)
      },
    },
  )

  const { execute: editMessage } = useAction(
    editMessageAction.bind(null, workspaceId, activeConversationId ?? ""),
    {
      onSuccess: ({ data }) => {
        if (data?.messageId) {
          updateMessageText(data.messageId, data.newText, {
            newAttachmentPath: data.newAttachmentPath,
            newAttachmentPublicUrl: data.newAttachmentPublicUrl,
            newAttachmentMimeType: data.newAttachmentMimeType,
            newAttachmentWidth: data.newAttachmentWidth,
            newAttachmentHeight: data.newAttachmentHeight,
            removedAttachment: data.removedAttachment,
          })
        }
        toast.success(t("messages.editMessageSuccess"))
      },
      onError: ({ error }) => {
        toast.error(error.serverError)
      },
    },
  )

  const { execute: changeMessageAttributes } = useAction(
    changeMessageAttributesAction.bind(
      null,
      workspaceId,
      activeConversationId ?? "",
    ),
    {
      onSuccess: ({ data, input }) => {
        if (data?.messageId) {
          const current = messages.find((m) => m.id === data.messageId)
          const currentAttrs =
            (current?.attributes as {
              liked?: boolean
              hidden?: boolean
            } | null) ?? {}
          updateMessageAttributes(data.messageId, {
            liked:
              input.liked === undefined
                ? (currentAttrs.liked ?? false)
                : input.liked,
            hidden:
              input.hidden === undefined
                ? (currentAttrs.hidden ?? false)
                : input.hidden,
          })
        }
      },
      onError: ({ error }) => {
        toast.error(error.serverError)
      },
    },
  )

  const handleReplyComment = (comment: { commentId: string; text: string }) => {
    const message = messages.find((m) => m.sourceId === comment.commentId)
    if (message) {
      setReplyToMessage(message)
    }
  }

  const handlePrivateReplyComment = (comment: {
    commentId: string
    text: string
  }) => {
    const message = messages.find((m) => m.sourceId === comment.commentId)
    if (message) {
      setReplyToMessage(message, true)
    }
  }

  const handleDeleteComment = ({
    id,
    createdAt,
  }: {
    id: string
    createdAt: Date
  }) => {
    markMessagesDeleted([id])
    deleteMessage({
      id,
      createdAt,
    })
  }

  const handleEditMessage = (message: {
    id: string
    createdAt: Date
    text: string
    newAttachmentPath?: string
    newAttachmentPublicUrl?: string
    newAttachmentMimeType?: string
    newAttachmentName?: string
    newAttachmentSize?: number
    removeAttachment?: boolean
  }) => {
    editMessage({
      messageId: message.id,
      createdAt: message.createdAt,
      newText: message.text,
      newAttachmentPath: message.newAttachmentPath,
      newAttachmentPublicUrl: message.newAttachmentPublicUrl,
      newAttachmentMimeType: message.newAttachmentMimeType,
      newAttachmentName: message.newAttachmentName,
      newAttachmentSize: message.newAttachmentSize,
      removeAttachment: message.removeAttachment,
    })
  }

  const handleChangeLikeState = (message: MessageResourceWithRelations) => {
    const current =
      (message.attributes as { liked?: boolean; hidden?: boolean } | null) ?? {}
    changeMessageAttributes({
      messageId: message.id,
      createdAt: message.createdAt,
      liked: !current.liked,
    })
  }

  const handleChangeHideState = (message: MessageResourceWithRelations) => {
    const current =
      (message.attributes as { liked?: boolean; hidden?: boolean } | null) ?? {}
    changeMessageAttributes({
      messageId: message.id,
      createdAt: message.createdAt,
      hidden: !current.hidden,
    })
  }

  const [firstItemIndex, setFirstItemIndex] = useState(START_INDEX)
  const prevLengthRef = useRef(0)
  const previousFirstRow = useRef<string | undefined>(undefined)
  const pendingPrependSeqRef = useRef<number | null>(null)
  const didAutoSelectCommentRef = useRef(false)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  // Mirrors `isAtBottom` so the message-length effect can read it without
  // re-running on every scroll.
  const isAtBottomRef = useRef(true)
  const [hasUnseenIncoming, setHasUnseenIncoming] = useState(false)

  const handleAtBottomStateChange = (atBottom: boolean) => {
    isAtBottomRef.current = atBottom
    setIsAtBottom(atBottom)
    if (atBottom) {
      setHasUnseenIncoming(false)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: wip
  useEffect(() => {
    setFirstItemIndex(START_INDEX)
    handleAtBottomStateChange(true)
    prevLengthRef.current = 0
    previousFirstRow.current = undefined
    setHighlightedId(undefined)
    setQuoteDialog(undefined)
    pendingPrependSeqRef.current = null
    didAutoSelectCommentRef.current = false
    if (activeConversationId) {
      loadInitialMessages(workspaceId, INBOX_MESSAGES_PER_PAGE)
    }
  }, [activeConversationId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: only runs once per conversation activation
  useEffect(() => {
    if (didAutoSelectCommentRef.current) {
      return
    }
    if (messages.length === 0) {
      return
    }
    didAutoSelectCommentRef.current = true
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (
        message.messageType === "incoming" &&
        message.type === "comment" &&
        message.deletedAt == null &&
        message.sourceId
      ) {
        setReplyToMessage(message)
        break
      }
    }
  }, [messages])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to list growth and accepted prepend tokens only
  useEffect(() => {
    const previousLength = prevLengthRef.current
    const previousAnchor = previousFirstRow.current
    previousFirstRow.current = rows[0]?.id
    const lengthDelta = messages.length - previousLength
    const isAcceptedPrepend = pendingPrependSeqRef.current === prependSeq
    const appendedCount = isAcceptedPrepend
      ? lengthDelta - lastPrependedCount
      : lengthDelta

    if (isAcceptedPrepend) {
      const prependedRows = previousAnchor
        ? rows.findIndex((row) => row.id === previousAnchor)
        : -1
      setFirstItemIndex(
        (index) =>
          index - (prependedRows >= 0 ? prependedRows : lastPrependedCount),
      )
      pendingPrependSeqRef.current = null
    }
    if (
      appendedCount > 0 &&
      previousLength > 0 &&
      !isAtBottomRef.current &&
      messages.at(-1)?.messageType === "incoming"
    ) {
      // A contact message was appended while the agent is reading older
      // history — flag it so the scroll-to-bottom button draws attention.
      setHasUnseenIncoming(true)
    }
    prevLengthRef.current = messages.length
  }, [lastPrependedCount, messages.length, prependSeq, rows])

  const loadMoreItems = () => {
    if (isLoadMoreMessage || !hasNextMessagePage || messages.length === 0) {
      return
    }
    pendingPrependSeqRef.current = prependSeq + 1
    loadMoreMessages(workspaceId, INBOX_MESSAGES_PER_PAGE)
  }

  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: "smooth",
    })
  }

  const highlightMessage = (message: MessageResourceWithRelations) => {
    const row = rowIndexByMessage.get(message.id)
    if (row === undefined || message.conversationId !== activeConversationId) {
      return false
    }
    setHighlightedId(message.id)
    virtuosoRef.current?.scrollToIndex({
      index: firstItemIndex + row,
      align: "center",
      behavior: "auto",
    })
    return true
  }

  const renderZaloActions = (target: MessageResourceWithRelations) =>
    zaloInboxes.has(target.contactInboxId) ? (
      <ZaloAccountMessageActions
        forward={
          canForward(target) && activeInbox?.id === target.contactInboxId
            ? {
                inboxId: activeInbox.inboxId,
                open: () => setForwardMessageId(target.id),
              }
            : undefined
        }
        inspect={{
          accountId:
            getZaloAccountId(target.contentAttributes) ??
            groupAudience?.accountId ??
            "",
          canInspect: canInspectZalo,
        }}
        key={`${workspaceId}:${target.conversationId}:${target.id}:${new Date(target.createdAt).toISOString()}`}
        message={target}
        workspaceId={workspaceId}
      />
    ) : null

  const quoteProps = (message: MessageResourceWithRelations) => {
    if (!zaloInboxes.has(message.contactInboxId)) {
      return {}
    }
    const source = parseZaloAccountSourceId(message.sourceId)
    const quote = getZaloGroupQuote(message.contentAttributes)
    if (!(source && quote)) {
      return {}
    }
    const quotedKey = [
      "za",
      encodeURIComponent(source.accountId),
      source.threadType,
      encodeURIComponent(source.threadId),
      encodeURIComponent(quote.providerMessageId),
    ].join(":")
    const candidate = membersBySource.get(quotedKey)
    const original =
      candidate?.contactInboxId === message.contactInboxId &&
      candidate?.conversationId === message.conversationId
        ? candidate
        : undefined
    const author =
      original && !zaloMessageLabel(original)
        ? {
            name:
              getZaloGroupMessage(original.contentAttributes)?.senderName ||
              original.user?.name ||
              contactDisplayName(original.contact) ||
              undefined,
            avatar:
              original.user?.image ||
              (source.threadType === "user"
                ? original.contact?.avatar
                : undefined) ||
              undefined,
          }
        : undefined
    return {
      zaloQuoteAuthor: author,
      onOpenZaloQuote: () => {
        if (original && highlightMessage(original)) {
          return
        }
        setQuoteDialog({
          accountId: source.accountId,
          contactInboxId: message.contactInboxId,
          conversationId: message.conversationId,
          quote,
        })
      },
    }
  }

  return (
    // `min-h-0`: Virtuoso's scroller is `height: 100%`, so without it this item
    // is floored at the full list height and pushes the composer below the fold
    // instead of scrolling inside itself.
    <div className="relative flex min-h-0 flex-1 flex-col px-3">
      {timelineSlot &&
        activeConversationId &&
        activeInbox?.channel === "zaloAccount" &&
        timelineAccountId &&
        createPortal(
          <ZaloTimelineDialog
            accountId={timelineAccountId}
            contactInboxId={activeInbox.id}
            conversationId={activeConversationId}
            key={activeConversationId}
            onSelectMessage={highlightMessage}
            workspaceId={workspaceId}
          />,
          timelineSlot,
        )}
      <Virtuoso
        alignToBottom={true}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={100}
        components={{
          Footer: MessageComponentFooter,
          List: MessageComponentList,
          Header: MessageComponentHeader,
        }}
        computeItemKey={(_, row) => row.id}
        data={rows}
        firstItemIndex={firstItemIndex}
        followOutput
        initialTopMostItemIndex={{ index: "LAST" }}
        itemContent={(_, row) => {
          const [message] = row.items
          if (!message) {
            return null
          }
          if (row.album) {
            return (
              <div className="pb-1.5">
                <ZaloAlbumBubble
                  highlightedId={highlightedId}
                  items={row.items}
                  profileScope={groupProfileFor(message)}
                  renderActions={(item) => (
                    <>
                      {renderZaloActions(item)}
                      {item.sourceId &&
                        !item.deletedAt &&
                        !zaloMessageLabel(item) && (
                          <Button
                            aria-label={t("zaloAccount.reply")}
                            className="size-7"
                            onClick={() => setReplyToMessage(item)}
                            size="icon"
                            type="button"
                            variant="ghost"
                          >
                            <ReplyIcon aria-hidden className="size-4" />
                          </Button>
                        )}
                    </>
                  )}
                  renderEvidence={(item) => {
                    const activity = activityFor(item)
                    return (
                      activity && (
                        <ZaloMessageEvidence
                          activity={activity}
                          attributes={item.contentAttributes}
                          message={item}
                        />
                      )
                    )
                  }}
                />
              </div>
            )
          }
          return (
            <div
              className={cn(
                "pb-1.5",
                highlightedId === message.id &&
                  "rounded-lg ring-2 ring-primary",
              )}
              data-message-id={message.id}
            >
              <TranslatedMessage message={message}>
                {(translation) => (
                  <MessageItem
                    canPrivateReply={(comment) =>
                      canPrivateReplyToComment({
                        channel: activeChannel,
                        message: comment,
                      })
                    }
                    key={message.id}
                    message={message}
                    onChangeHide={() => handleChangeHideState(message)}
                    onChangeLike={() => handleChangeLikeState(message)}
                    onDelete={
                      groupAudience
                        ? undefined
                        : () => {
                            handleDeleteComment({
                              id: message.id,
                              createdAt: message.createdAt,
                            })
                          }
                    }
                    onEdit={groupAudience ? undefined : handleEditMessage}
                    onPrivateReply={handlePrivateReplyComment}
                    onReply={handleReplyComment}
                    renderResend={(failed) => (
                      <ResendMessageButton message={failed} />
                    )}
                    renderZaloActions={renderZaloActions}
                    translation={translation}
                    zaloAccount={zaloInboxes.has(message.contactInboxId)}
                    {...quoteProps(message)}
                    zaloActivity={activityFor(message)}
                    zaloGroup={!!groupAudience}
                    zaloGroupProfileScope={groupProfileFor(message)}
                  />
                )}
              </TranslatedMessage>
            </div>
          )
        }}
        itemsRendered={(items) => {
          if (!activityThread) {
            return
          }
          const ids = [
            ...new Set(
              items
                .flatMap((item) => item.data?.items ?? [])
                .flatMap((message) => {
                  const id =
                    message.deletedAt || zaloMessageLabel(message)
                      ? null
                      : providerMessageIdForZaloActivity(
                          message,
                          activityThread,
                        )
                  return id ? [id] : []
                }),
            ),
          ]
            .slice(0, 50)
            .sort()
          setVisibleProviderIds((current) =>
            current?.conversationId === activeConversationId &&
            current?.ids.length === ids.length &&
            ids.every((id, index) => current.ids[index] === id)
              ? current
              : { conversationId: activeConversationId, ids },
          )
        }}
        ref={virtuosoRef}
        startReached={loadMoreItems}
      />
      {quoteDialog?.conversationId === activeConversationId && (
        <ZaloQuoteDialog
          {...quoteDialog}
          key={`${activeConversationId}:${quoteDialog.quote.providerMessageId}`}
          onClose={() => setQuoteDialog(undefined)}
          workspaceId={workspaceId}
          zaloGroup={Boolean(groupAudience)}
        />
      )}
      {forwardMessage && forwardInboxId && (
        <ZaloForwardDialog
          copiesMedia={Boolean(forwardMessage.attachments?.length)}
          destinations={forwardDestinations}
          key={forwardMessage.id}
          onClose={() => setForwardMessageId(undefined)}
          onSend={(destinationId) => {
            if (!forwardDestinations.some(({ id }) => id === destinationId)) {
              return false
            }
            const queue = sendQueues[destinationId]
            if (queue && isSendQueueLocked(queue)) {
              return false
            }
            const clientId = createId()
            const input = createMessageWithRoutingBypassRequest.safeParse({
              clientId,
              inboxId: forwardInboxId,
              zaloAccountForward: {
                conversationId: forwardMessage.conversationId,
                messageId: forwardMessage.id,
                messageCreatedAt: forwardMessage.createdAt,
              },
            })
            if (!input.success) {
              return false
            }
            updateSendQueue(destinationId, (current) =>
              enqueueSend(current, { clientId, input: input.data }),
            )
            toast.info(t("zaloAccount.evidence.pending"))
            return true
          }}
        />
      )}
      {!isAtBottom && messages.length > 0 && (
        <Button
          aria-label={t("actions.scrollToBottom")}
          className={cn(
            "absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md",
            hasUnseenIncoming && "animate-bounce",
          )}
          onClick={scrollToBottom}
          size="icon"
          title={t("actions.scrollToBottom")}
          type="button"
          variant="default"
        >
          <ArrowDownIcon />
          {hasUnseenIncoming && (
            <span className="absolute -top-0.5 -right-0.5 flex size-3">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-75" />
              <span className="relative inline-flex size-3 rounded-full border-2 border-background bg-destructive" />
            </span>
          )}
        </Button>
      )}
    </div>
  )
}

function canForward(message: MessageResourceWithRelations) {
  if (message.deletedAt || zaloMessageLabel(message) || message.sendError) {
    return false
  }
  if (message.attachments?.length) {
    return message.attachments.every(
      (attachment) =>
        (attachment.fileType === "image" || attachment.fileType === "file") &&
        Boolean(attachment.url),
    )
  }
  const attrs = getZaloAccountAttributes(message.contentAttributes)
  return (
    Boolean(message.text?.trim()) &&
    !(
      attrs &&
      typeof attrs === "object" &&
      ("richContent" in attrs || "unsupported" in attrs)
    )
  )
}

const MessageComponentHeader: GridComponents["Header"] = () => {
  const { isLoadMoreMessage } = useChatStore((state) => state)

  return (
    <div className="pt-3">
      <ConversationInfo />
      {isLoadMoreMessage && (
        <div className="flex items-center space-x-2 px-3 py-2">
          <Skeleton className="h-8 w-3/5 rounded-xl" />
        </div>
      )}
    </div>
  )
}

const MessageComponentFooter: GridComponents["Footer"] = () => (
  <div className="h-3" />
)

const MessageComponentList: GridComponents["List"] = ({
  children,
  ...props
}) => (
  <div {...props} className="virtuoso-item-list flex flex-col">
    {children}
  </div>
)

const ZALO_ACCOUNT_ID = /^\d{1,200}$/
function getZaloAccountId(attributes: unknown): string | undefined {
  if (!attributes || typeof attributes !== "object") {
    return
  }
  const account = (attributes as { zaloAccount?: unknown }).zaloAccount
  if (!account || typeof account !== "object") {
    return
  }
  const id = (account as { accountId?: unknown }).accountId
  return typeof id === "string" && ZALO_ACCOUNT_ID.test(id) ? id : undefined
}
