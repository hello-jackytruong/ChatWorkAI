"use client"

import { cn } from "@chatbotx.io/ui/lib/utils"
import { format } from "date-fns"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"
import { getZaloGroupMessage } from "@/features/zalo-accounts/lib/group-content"
import { zaloMessageLabel } from "../lib/zalo-message-label"
import {
  getZaloAccountAttributes,
  getZaloMediaUrl,
} from "../lib/zalo-rich-message"
import type { MessageResourceWithRelations } from "../schema/resource"
import { MessageBubble } from "./message-bubble"
import { RenderImageGridItem } from "./message-item"

type Message = MessageResourceWithRelations

export function ZaloAlbumBubble({
  items,
  highlightedId,
  renderActions,
}: {
  items: Message[]
  highlightedId?: string
  renderActions?: (message: Message) => ReactNode
}) {
  const t = useTranslations("zaloAccount")
  const tMessages = useTranslations("messages")
  const first = items[0]
  if (!first) {
    return null
  }
  const direction = first.messageType === "outgoing" ? "right" : "left"
  const caption = items.find(
    (message) => !zaloMessageLabel(message) && message.text?.trim(),
  )?.text
  const sender = items
    .map((item) => getZaloGroupMessage(item.contentAttributes))
    .find((group) => group && !group.isSelf)
  const createdAt = new Date(first.createdAt)

  return (
    <MessageBubble variant={direction}>
      <div className="flex min-w-0 max-w-[70%] flex-col gap-1">
        {sender && (
          <p className="text-muted-foreground text-xs">
            {sender.senderName || sender.senderId}
          </p>
        )}
        <div
          className={cn(
            "grid w-80 max-w-full gap-1",
            items.length > 1 && "grid-cols-2 sm:grid-cols-3",
          )}
        >
          {items.map((message) => {
            const label = zaloMessageLabel(message)
            const attachment = message.attachments?.[0]
            const attributes = getZaloAccountAttributes(
              message.contentAttributes,
            ) as
              | {
                  mediaResources?: Array<{
                    attachmentId?: string
                    role?: string
                    state?: string
                  }>
                }
              | undefined
            const resources = attributes?.mediaResources?.filter(
              (resource) => resource.attachmentId === attachment?.id,
            )
            const processing = resources?.some(
              (resource) =>
                resource.role === "original" &&
                (resource.state === "pending" ||
                  resource.state === "downloading"),
            )
            const preview = resources?.some(
              (resource) =>
                resource.role === "thumbnail" && resource.state === "stored",
            )
            return (
              <div
                className={cn(
                  "group relative aspect-square min-w-0 rounded-lg",
                  message.id === highlightedId &&
                    "ring-2 ring-primary ring-offset-2",
                )}
                data-message-id={message.id}
                key={message.id}
              >
                {label || message.deletedAt || !attachment ? (
                  <div className="flex size-full items-center justify-center rounded-lg bg-muted p-1.5 text-center text-muted-foreground text-xs">
                    {label
                      ? t(label)
                      : tMessages(
                          message.deletedAt
                            ? "messageDeleted"
                            : "failedToPreviewImage",
                        )}
                  </div>
                ) : (
                  <RenderImageGridItem
                    attachment={attachment}
                    isZalo
                    previewUrl={
                      preview
                        ? getZaloMediaUrl(attachment.thumbnailPath)
                        : undefined
                    }
                    processing={processing}
                  />
                )}
                {renderActions && (
                  <div className="absolute end-1 top-1 flex gap-1 rounded bg-background/80">
                    {renderActions(message)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {caption && (
          <p className="wrap-break-word whitespace-pre-wrap rounded-lg bg-secondary px-2.5 py-2 text-sm">
            {caption}
          </p>
        )}
        <time
          className="text-end text-muted-foreground text-xs"
          dateTime={createdAt.toISOString()}
        >
          {format(createdAt, "HH:mm")}
        </time>
      </div>
    </MessageBubble>
  )
}
