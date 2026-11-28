"use client"

import {
  type ZaloAccountStickerCatalogEntry,
  type ZaloAccountStickerCatalogQuery,
  zaloAccountStickerCatalogEntrySchema,
} from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import { useQuery } from "@tanstack/react-query"
import { LoaderCircleIcon, SmileIcon, StarIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { z } from "zod"
import { listZaloComposerStickersAction } from "../actions/zalo-composer-capability.action"
import { ZaloStickerArtwork } from "./zalo-sticker-artwork"

const maxPreferences = 20
const preferencesSchema = z.object({
  recent: z.array(zaloAccountStickerCatalogEntrySchema).max(maxPreferences),
  favourite: z.array(zaloAccountStickerCatalogEntrySchema).max(maxPreferences),
})
type Preferences = z.infer<typeof preferencesSchema>
const empty: Preferences = { recent: [], favourite: [] }
const tabs = {
  search: "actions.search",
  category: "fields.category.label",
  recent: "mediaLibrary.recent",
  favourite: "mediaLibrary.favourite",
} as const
type Tab = keyof typeof tabs
type Entry = ZaloAccountStickerCatalogEntry
type StickerSend = Pick<Entry, "stickerId" | "categoryId" | "stickerType"> & {
  kind: "sticker"
}

function readPreferences(key: string) {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        return preferencesSchema.safeParse(JSON.parse(raw)).data ?? empty
      }
    } catch {
      return empty
    }
  }
  return empty
}

function remember(entries: Entry[], sticker: Entry) {
  return [
    sticker,
    ...entries.filter((entry) => entry.stickerId !== sticker.stickerId),
  ].slice(0, maxPreferences)
}

export function ZaloStickerPicker({
  userId,
  workspaceId,
  conversationId,
  inboxId,
  onSend,
}: {
  userId: string
  workspaceId: string
  conversationId: string
  inboxId: string
  onSend: (content: StickerSend) => boolean
}) {
  const t = useTranslations()
  const preferencesKey = `zalo-stickers:${workspaceId}:${inboxId}:${userId}`
  const [preferences, setPreferences] = useState(() =>
    readPreferences(preferencesKey),
  )
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>("search")
  const [search, setSearch] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [categoryId, setCategoryId] = useState("")
  const [categories, setCategories] = useState<string[]>([])
  const [failedSend, setFailedSend] = useState(false)
  const trimmedSearch = search.trim()

  useEffect(() => {
    if (open && tab === "search") {
      const timeout = window.setTimeout(() => setSearchTerm(trimmedSearch), 250)
      return () => window.clearTimeout(timeout)
    }
  }, [open, tab, trimmedSearch])

  let query: ZaloAccountStickerCatalogQuery | undefined
  if (tab === "search" && searchTerm && searchTerm === trimmedSearch) {
    query = { kind: "search", query: searchTerm, limit: 20 }
  } else if (tab === "category" && categoryId) {
    query = { kind: "category", categoryId, limit: 20 }
  }
  const catalog = useQuery({
    queryKey: [
      "zalo-sticker-catalog",
      workspaceId,
      conversationId,
      inboxId,
      query,
    ],
    enabled: open && Boolean(query),
    staleTime: 30_000,
    gcTime: 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!query) {
        return []
      }
      const result = await listZaloComposerStickersAction(
        workspaceId,
        conversationId,
        { inboxId, query },
      )
      signal.throwIfAborted()
      if (!result?.data) {
        throw new Error(
          result?.serverError ?? "Zalo sticker catalog unavailable",
        )
      }
      return result.data
    },
  })

  const updatePreferences = (next: Preferences) => {
    setPreferences(next)
    try {
      window.localStorage.setItem(preferencesKey, JSON.stringify(next))
    } catch {
      // Private browsing can disable storage. The picker still works.
    }
  }
  const chooseSticker = (entry: Entry) => {
    const { stickerId, categoryId: selectedCategory, stickerType } = entry
    const sent = onSend({
      kind: "sticker",
      stickerId,
      categoryId: selectedCategory,
      stickerType,
    })
    setFailedSend(!sent)
    if (sent) {
      updatePreferences({
        ...preferences,
        recent: remember(preferences.recent, entry),
      })
      setOpen(false)
    }
  }
  const entries =
    tab === "recent" || tab === "favourite"
      ? preferences[tab]
      : (catalog.data ?? [])

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setFailedSend(false)
        }
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label={t("zaloAccount.sticker")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <SmileIcon aria-hidden />
          </Button>
        }
      />
      <PopoverContent className="max-w-[calc(100vw-2rem)]" side="top">
        <PopoverTitle className="sr-only">
          {t("zaloAccount.sticker")}
        </PopoverTitle>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(tabs) as Tab[]).map((item) => (
            <Button
              aria-pressed={item === tab}
              key={item}
              onClick={() => {
                if (item === "category" && tab === "search") {
                  const discovered = [
                    ...new Set(entries.map((entry) => entry.categoryId)),
                  ]
                  if (discovered.length) {
                    setCategories(discovered)
                    setCategoryId(discovered[0] ?? "")
                  }
                }
                setTab(item)
              }}
              size="sm"
              type="button"
              variant={item === tab ? "secondary" : "ghost"}
            >
              {t(tabs[item])}
            </Button>
          ))}
        </div>
        {tab === "search" && (
          <Input
            aria-label={t("actions.search")}
            autoComplete="off"
            maxLength={200}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
              }
            }}
            placeholder={t("actions.search")}
            type="search"
            value={search}
          />
        )}
        {tab === "category" && categories.length > 0 && (
          <select
            aria-label={t("fields.category.label")}
            className="max-w-full rounded-md border bg-background p-1.5"
            onChange={(event) => setCategoryId(event.currentTarget.value)}
            value={categoryId}
          >
            {categories.map((id) => (
              <option key={id} value={id}>
                {t("fields.category.label")} {id}
              </option>
            ))}
          </select>
        )}
        {catalog.isFetching && (
          <LoaderCircleIcon
            aria-label={t("actions.loading")}
            className="size-4 motion-safe:animate-spin"
            role="status"
          />
        )}
        {(catalog.isError || failedSend) && (
          <p className="text-destructive text-xs" role="alert">
            {t("zaloAccount.operationFailed")}
          </p>
        )}
        {entries.length > 0 && (
          <div className="grid max-h-64 grid-cols-3 gap-1 overflow-y-auto">
            {entries.map((entry) => {
              const favourite = preferences.favourite.some(
                (item) => item.stickerId === entry.stickerId,
              )
              const label = entry.title ?? t("zaloAccount.sticker")
              return (
                <div className="relative min-w-0" key={entry.stickerId}>
                  <Button
                    aria-label={label}
                    className="h-auto w-full p-1"
                    onClick={() => chooseSticker(entry)}
                    type="button"
                    variant="ghost"
                  >
                    <ZaloStickerArtwork
                      artwork={entry}
                      label={label}
                      size={60}
                    />
                  </Button>
                  <Button
                    aria-label={t(
                      favourite
                        ? "mediaLibrary.removeFromFavourites"
                        : "mediaLibrary.addToFavourites",
                    )}
                    aria-pressed={favourite}
                    className="absolute end-0 top-0 size-5 bg-popover p-0 [&_svg]:size-3"
                    onClick={() =>
                      updatePreferences({
                        ...preferences,
                        favourite: favourite
                          ? preferences.favourite.filter(
                              (item) => item.stickerId !== entry.stickerId,
                            )
                          : remember(preferences.favourite, entry),
                      })
                    }
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <StarIcon
                      aria-hidden
                      fill={favourite ? "currentColor" : "none"}
                    />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        {!(entries.length || catalog.isFetching || catalog.isError) && (
          <p className="text-muted-foreground text-xs">
            {t("messages.noResults")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
