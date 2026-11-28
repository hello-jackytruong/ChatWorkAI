"use client"

import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
import {
  toZaloAccountWebUrl,
  zaloAccountRichContentSchema,
} from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { FolderOpenIcon } from "lucide-react"
import Image from "next/image"
import { useFormatter, useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import {
  lookupZaloQuoteAction,
  searchZaloTimelineAction,
} from "../actions/zalo-timeline.action"
import { getZaloRichMessage } from "../lib/zalo-rich-message"
import type { MessageResourceWithRelations } from "../schema/resource"
import { MessageItem } from "./message-item"
import { ZaloRichClip } from "./zalo-rich-clip"
import { ZaloStickerArtwork } from "./zalo-sticker-artwork"

const kinds = ["media", "file", "link", "text"] as const
const whitespace = /\s+/
type Kind = (typeof kinds)[number]

const linkOf = (message: MessageResourceWithRelations) => {
  const contentAttrs = message.contentAttributes
  const attributes =
    contentAttrs &&
    typeof contentAttrs === "object" &&
    "zaloAccount" in contentAttrs
      ? contentAttrs.zaloAccount
      : undefined
  if (
    attributes &&
    typeof attributes === "object" &&
    "richContent" in attributes
  ) {
    const content = zaloAccountRichContentSchema.safeParse(
      attributes.richContent,
    ).data
    if (content?.kind === "link") {
      return toZaloAccountWebUrl(content.url)?.href
    }
  }
  return message.text
    ?.split(whitespace, 64)
    .map((value) => toZaloAccountWebUrl(value))
    .find(Boolean)?.href
}

export function ZaloTimelineDialog({
  workspaceId,
  conversationId,
  accountId,
  contactInboxId,
  onSelectMessage,
}: {
  workspaceId: string
  conversationId: string
  accountId: string
  contactInboxId: string
  onSelectMessage?: (message: MessageResourceWithRelations) => boolean
}) {
  const t = useTranslations("zaloAccount.timeline")
  const tZalo = useTranslations("zaloAccount")
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<Kind>("media")
  const [text, setText] = useState("")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<{
    providerMessageId: string
    timestampMs: number
  }>()

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text])

  const history = useInfiniteQuery({
    queryKey: [
      "zalo-timeline",
      workspaceId,
      conversationId,
      accountId,
      contactInboxId,
      kind,
      query,
    ],
    enabled: open && Boolean(accountId && contactInboxId),
    initialPageParam: undefined as string | undefined,
    staleTime: 15_000,
    gcTime: 60_000,
    maxPages: 4,
    retry: false,
    queryFn: async ({ pageParam }) => {
      const result = await searchZaloTimelineAction(
        workspaceId,
        conversationId,
        {
          accountId,
          contactInboxId,
          kind,
          query: query || undefined,
          cursor: pageParam,
        },
      )
      if (!result?.data) {
        throw new Error("Cannot read Zalo Account history")
      }
      return result.data
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const rows = history.data?.pages.flatMap((page) => page.data) ?? []
  const detail = useQuery({
    queryKey: [
      "zalo-timeline-original",
      workspaceId,
      conversationId,
      contactInboxId,
      selected,
    ],
    enabled: open && Boolean(selected),
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      if (!selected) {
        return null
      }
      const result = await lookupZaloQuoteAction(workspaceId, conversationId, {
        ...selected,
        accountId,
        contactInboxId,
      })
      return result?.data ?? null
    },
  })

  const selectMessage = (message: MessageResourceWithRelations) => {
    if (onSelectMessage?.(message)) {
      setOpen(false)
      return
    }
    const source = parseZaloAccountSourceId(message.sourceId)
    if (source && source.accountId === accountId) {
      setSelected({
        providerMessageId: source.providerMessageId,
        timestampMs: new Date(message.createdAt).getTime(),
      })
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setSelected(undefined)
        }
      }}
      open={open}
    >
      <DialogTrigger
        render={
          <Button
            aria-label={t("title")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <FolderOpenIcon aria-hidden="true" />
          </Button>
        }
      />
      <DialogContent className="w-[calc(100%-1rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {selected ? (
          <>
            <Button
              onClick={() => setSelected(undefined)}
              type="button"
              variant="ghost"
            >
              {t("back")}
            </Button>
            <div
              aria-busy={detail.isPending}
              className="max-h-[45vh] overflow-y-auto"
            >
              {detail.isPending && <p role="status">{t("loading")}</p>}
              {detail.isError && <p role="alert">{t("error")}</p>}
              {detail.isSuccess &&
                (detail.data ? (
                  <MessageItem message={detail.data} zaloAccount />
                ) : (
                  <p role="status">{t("unavailable")}</p>
                ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {kinds.map((tab) => (
                <Button
                  aria-pressed={tab === kind}
                  key={tab}
                  onClick={() => setKind(tab)}
                  size="sm"
                  type="button"
                  variant={tab === kind ? "secondary" : "ghost"}
                >
                  {t(tab)}
                </Button>
              ))}
            </div>
            <Input
              aria-label={t("search")}
              maxLength={120}
              onChange={(event) => setText(event.currentTarget.value)}
              placeholder={t("search")}
              type="search"
              value={text}
            />
            <div
              aria-busy={history.isFetching}
              className="max-h-[45vh] space-y-2 overflow-y-auto"
            >
              {history.isPending && (
                <p className="text-muted-foreground text-sm" role="status">
                  {t("loading")}
                </p>
              )}
              {history.isError && (
                <p className="text-destructive text-sm" role="alert">
                  {t("error")}
                </p>
              )}
              {!(history.isPending || history.isError) && rows.length === 0 && (
                <p className="text-muted-foreground text-sm" role="status">
                  {t("empty")}
                </p>
              )}
              {rows.map((message) => {
                const link = kind === "link" ? linkOf(message) : undefined
                const rich =
                  kind === "media" ? getZaloRichMessage(message) : undefined
                const attachments = (
                  rich?.attachments ??
                  message.attachments ??
                  []
                ).filter((file) => {
                  if (kind === "file") {
                    return file.fileType === "file"
                  }
                  return kind === "media" && file.fileType !== "file"
                })
                return (
                  <article
                    className="space-y-1 rounded-md border px-3 py-2"
                    key={message.id}
                  >
                    <p className="text-muted-foreground text-xs">
                      {format.dateTime(new Date(message.createdAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </p>
                    {message.text && (
                      <p className="wrap-anywhere line-clamp-2 text-sm">
                        {message.text}
                      </p>
                    )}
                    {link && (
                      <a
                        className="block truncate text-primary text-sm underline"
                        href={link}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {link}
                      </a>
                    )}
                    {rich?.clips.map((clip) => (
                      <ZaloRichClip clip={clip} key={clip.id} />
                    ))}
                    {rich?.sticker && (
                      <ZaloStickerArtwork
                        artwork={rich.sticker}
                        label={tZalo("sticker")}
                        size={64}
                      />
                    )}
                    {attachments.map((file) => {
                      const url = toZaloAccountWebUrl(file.url)?.href
                      const preview =
                        file.fileType === "image" || file.fileType === "gif"
                          ? toZaloAccountWebUrl(file.thumbnailPath ?? url)?.href
                          : undefined
                      return url ? (
                        <a
                          className="flex items-center gap-2 break-all text-primary text-sm underline"
                          href={url}
                          key={file.id}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {preview && (
                            <Image
                              alt=""
                              className="size-12 rounded object-cover"
                              height={48}
                              loading="lazy"
                              src={preview}
                              unoptimized
                              width={48}
                            />
                          )}
                          {file.name || t(kind)}
                        </a>
                      ) : (
                        <p
                          className="text-muted-foreground text-xs"
                          key={file.id}
                        >
                          {file.name || t("unavailable")}
                        </p>
                      )
                    })}
                    {message.sourceId && (
                      <Button
                        onClick={() => selectMessage(message)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("openMessage")}
                      </Button>
                    )}
                  </article>
                )
              })}
            </div>
            {history.hasNextPage && (
              <Button
                disabled={history.isFetchingNextPage}
                onClick={() => history.fetchNextPage()}
                type="button"
                variant="outline"
              >
                {t("older")}
              </Button>
            )}
            {history.isError && (
              <Button
                onClick={() => history.refetch()}
                type="button"
                variant="outline"
              >
                {t("retry")}
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
