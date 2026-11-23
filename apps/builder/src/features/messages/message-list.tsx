"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Skeleton } from "@chatbotx.io/ui/components/ui/skeleton"
import { cn } from "@chatbotx.io/ui/lib/utils"
import { ArrowDownIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useEffect, useRef, useState } from "react"
import {
  type GridComponents,
  Virtuoso,
  type VirtuosoHandle,
} from "react-virtuoso"
import { toast } from "sonner"
import { TranslatedMessage } from "@/features/translation/components/translated-message"
import { useRequestTranslations } from "@/features/translation/hooks/use-request-translations"
import { useZaloInspectPermission } from "@/features/zalo-accounts/components/zalo-inspect-permission"
import { useWorkspaceId } from "@/hooks/routing"
import { INBOX_MESSAGES_PER_PAGE } from "../chat/store/chat-store"
import { useChatStore } from "../chat/store/chat-store-provider"
import { ConversationInfo } from "../conversations/components/conversation-info"
import {
  getZaloGroupConversation,
  zaloGroupProviderMessageId,
} from "../zalo-accounts/lib/group-content"
import { useZaloGroupMessageState } from "../zalo-accounts/queries/use-group-message-state"
import { changeMessageAttributesAction } from "./actions/change-message-attributes.action"
import { deleteMessageAction } from "./actions/delete-message.action"
import { editMessageAction } from "./actions/edit-message.action"
import { MessageItem } from "./components/message-item"
import { ResendMessageButton } from "./components/resend-message-button"
import { ZaloAccountMessageActions } from "./components/zalo-account-message-actions"
import { canPrivateReplyToComment } from "./lib/private-reply"
import type { MessageResourceWithRelations } from "./schema/resource"

const START_INDEX = 100_000

export function MessageList() {
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
  } = useChatStore((state) => state)

  // Asks for the visible inbound messages to be translated; a no-op while
  // translation is off, so the Inbox is unchanged for such workspaces.
  useRequestTranslations()

  // Which channel this conversation belongs to, for the private-reply gate
  // below. The same `contactInboxes[0].channel` the store reads elsewhere.
  const currentConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId,
  )
  const activeChannel = currentConversation?.contactInboxes?.[0]?.channel
  const groupAudience = getZaloGroupConversation(currentConversation)
  const [visibleProviderIds, setVisibleProviderIds] = useState<string[] | null>(
    null,
  )
  const groupState = useZaloGroupMessageState(
    workspaceId,
    groupAudience,
    visibleProviderIds ??
      messages.slice(-50).flatMap((message) => {
        const id = zaloGroupProviderMessageId(message, groupAudience)
        return id ? [id] : []
      }),
  )

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
    setVisibleProviderIds(null)
    handleAtBottomStateChange(true)
    prevLengthRef.current = 0
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
    const lengthDelta = messages.length - previousLength
    const isAcceptedPrepend = pendingPrependSeqRef.current === prependSeq
    const appendedCount = isAcceptedPrepend
      ? lengthDelta - lastPrependedCount
      : lengthDelta

    if (isAcceptedPrepend) {
      setFirstItemIndex((index) => index - lastPrependedCount)
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
  }, [lastPrependedCount, messages.length, prependSeq])

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

  return (
    // `min-h-0`: Virtuoso's scroller is `height: 100%`, so without it this item
    // is floored at the full list height and pushes the composer below the fold
    // instead of scrolling inside itself.
    <div className="relative flex min-h-0 flex-1 flex-col px-3">
      <Virtuoso
        alignToBottom={true}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={100}
        components={{
          Footer: MessageComponentFooter,
          List: MessageComponentList,
          Header: MessageComponentHeader,
        }}
        data={messages}
        firstItemIndex={firstItemIndex}
        followOutput
        initialTopMostItemIndex={{ index: "LAST" }}
        itemContent={(_, message) => (
          <div className="pb-1.5">
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
                  renderZaloActions={
                    activeChannel === "zaloAccount"
                      ? (target) => (
                          <ZaloAccountMessageActions
                            key={`${workspaceId}:${target.conversationId}:${target.id}:${new Date(target.createdAt).toISOString()}`}
                            message={target}
                            workspaceId={workspaceId}
                          />
                        )
                      : undefined
                  }
                  translation={translation}
                  zaloGroup={!!groupAudience}
                  zaloInspect={
                    activeChannel === "zaloAccount"
                      ? {
                          accountId:
                            getZaloAccountId(message.contentAttributes) ??
                            groupAudience?.accountId ??
                            "",
                          canInspect:
                            canInspectZalo &&
                            Boolean(
                              getZaloAccountId(message.contentAttributes) ??
                                groupAudience?.accountId,
                            ),
                        }
                      : undefined
                  }
                  zaloState={
                    groupAudience
                      ? {
                          receipt: groupState.data?.receipts.find(
                            (receipt) =>
                              receipt.providerMessageId ===
                              zaloGroupProviderMessageId(
                                message,
                                groupAudience,
                              ),
                          ),
                          reactions:
                            groupState.data?.reactions.filter(
                              (reaction) =>
                                reaction.providerMessageId ===
                                zaloGroupProviderMessageId(
                                  message,
                                  groupAudience,
                                ),
                            ) ?? [],
                        }
                      : undefined
                  }
                />
              )}
            </TranslatedMessage>
          </div>
        )}
        itemsRendered={(items) => {
          const ids = items
            .flatMap((item) => {
              const id = item.data
                ? zaloGroupProviderMessageId(item.data, groupAudience)
                : null
              return id ? [id] : []
            })
            .slice(0, 50)
          setVisibleProviderIds((current) =>
            current?.length === ids.length &&
            ids.every((id, index) => current[index] === id)
              ? current
              : ids,
          )
        }}
        ref={virtuosoRef}
        startReached={loadMoreItems}
      />
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
