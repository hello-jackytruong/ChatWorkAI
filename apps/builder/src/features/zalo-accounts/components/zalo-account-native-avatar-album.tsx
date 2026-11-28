"use client"

import {
  type ZaloAccountNativeToolOperation,
  zaloAccountNativeToolOperationSchema,
} from "@chatbotx.io/sdk"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chatbotx.io/ui/components/ui/alert-dialog"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useInfiniteQuery } from "@tanstack/react-query"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { useRef, useState } from "react"
import { MediaLibraryTrigger } from "@/features/media-library/components/media-library-trigger"
import {
  type NativeAccountTarget,
  type NativeAccountWriteControls,
  nativeAccountToolKey,
  readNativeAccountTool,
} from "../lib/native-account-tools-ui"

type Avatar = Extract<
  ZaloAccountNativeToolOperation,
  { kind: "changeOwnAvatar" }
>["avatar"]
type AvatarTarget = { photoId: string; page: number; thumbnailUrl?: string }

export function NativeAccountAvatarAlbum({
  controls,
  target,
}: {
  controls: NativeAccountWriteControls
  target: NativeAccountTarget
}) {
  const t = useTranslations("zaloAccount.nativeProfile")
  const actions = useTranslations("actions")
  const [choice, setChoice] = useState<Avatar>()
  const [invalid, setInvalid] = useState(false)
  const [review, setReview] = useState<AvatarTarget>()
  const deleteTrigger = useRef<HTMLButtonElement>(null)
  const query = useInfiniteQuery({
    queryKey: nativeAccountToolKey(target, "listOwnAvatars"),
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      readNativeAccountTool(
        target,
        {
          kind: "listOwnAvatars",
          ...(pageParam === undefined ? {} : { page: pageParam }),
        },
        signal,
      ),
    getNextPageParam: (page) => page.avatarPage?.nextPage,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const photos = new Map<string, AvatarTarget>()
  for (const page of query.data?.pages ?? []) {
    for (const photo of page.avatarPage?.photos ?? []) {
      if (page.avatarPage) {
        photos.set(photo.photoId, { ...photo, page: page.avatarPage.page })
      }
    }
  }
  const last = query.data?.pages.at(-1)
  const canWrite = controls.canWrite && last?.writeEnabled !== false

  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="space-y-2">
          <MediaLibraryTrigger
            fileType="image"
            onSelect={(file) => {
              const parsed = zaloAccountNativeToolOperationSchema.safeParse({
                kind: "changeOwnAvatar",
                avatar: {
                  kind: "image",
                  url: file.url,
                  name: file.name,
                  mimeType: file.mimeType,
                  size: file.size,
                },
              })
              const operation = parsed.success ? parsed.data : undefined
              if (
                !(
                  operation?.kind === "changeOwnAvatar" &&
                  file.mimeType.startsWith("image/")
                )
              ) {
                setInvalid(true)
                setChoice(undefined)
                return
              }
              setInvalid(false)
              setChoice(operation.avatar)
            }}
            workspaceId={target.workspaceId}
          >
            <Button
              disabled={controls.busy}
              size="sm"
              type="button"
              variant="secondary"
            >
              {t("chooseAvatar")}
            </Button>
          </MediaLibraryTrigger>
          {choice && (
            <div className="flex flex-wrap items-center gap-2">
              <Image
                alt={t("avatarPreview")}
                className="size-20 rounded-md object-cover"
                height={80}
                referrerPolicy="no-referrer"
                src={choice.url}
                unoptimized
                width={80}
              />
              <Button
                disabled={controls.busy}
                onClick={() => {
                  controls.submit({ kind: "changeOwnAvatar", avatar: choice })
                  setChoice(undefined)
                }}
                size="sm"
                type="button"
              >
                {t("saveAvatar")}
              </Button>
              <Button
                disabled={controls.busy}
                onClick={() => setChoice(undefined)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {actions("cancel")}
              </Button>
            </div>
          )}
          {invalid && <p role="alert">{t("avatarInvalid")}</p>}
        </div>
      )}
      {query.isPending && <p role="status">{actions("loading")}</p>}
      {last?.avatarPage?.complete === false && (
        <p role="status">{t("avatarPartial")}</p>
      )}
      {last?.avatarPage?.complete && photos.size === 0 && (
        <p>{t("avatarEmpty")}</p>
      )}
      {(query.isError || (last && !last.avatarPage)) && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">{t("avatarUnavailable")}</p>
          <Button
            onClick={() => query.refetch()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {actions("retry")}
          </Button>
        </div>
      )}
      {photos.size > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from(photos.values(), (photo) => (
            <li
              className="min-w-0 space-y-2 rounded-md border p-2"
              key={photo.photoId}
            >
              {photo.thumbnailUrl && (
                <Image
                  alt=""
                  className="aspect-square w-full rounded-md object-cover"
                  height={144}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  src={photo.thumbnailUrl}
                  unoptimized
                  width={144}
                />
              )}
              <p className="wrap-break-word text-muted-foreground text-xs">
                {t("avatarName", { id: photo.photoId })}
              </p>
              {canWrite && (
                <div className="flex flex-wrap gap-1">
                  <Button
                    aria-label={t("reuseNamedAvatar", { id: photo.photoId })}
                    disabled={controls.busy}
                    onClick={() =>
                      controls.submit({
                        kind: "reuseOwnAvatar",
                        photoId: photo.photoId,
                        page: photo.page,
                      })
                    }
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {t("reuseAvatar")}
                  </Button>
                  <Button
                    aria-label={t("deleteNamedAvatar", { id: photo.photoId })}
                    disabled={controls.busy}
                    onClick={(event) => {
                      deleteTrigger.current = event.currentTarget
                      setReview(photo)
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {actions("delete")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(query.hasNextPage || (query.data?.pages.length ?? 0) > 1) && (
        <Button
          aria-disabled={query.isFetchingNextPage || !query.hasNextPage}
          onClick={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) {
              query
                .fetchNextPage({ cancelRefetch: false })
                .catch(() => undefined)
            }
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          {query.isFetchingNextPage ? actions("loading") : actions("loadMore")}
        </Button>
      )}
      {review && (
        <AlertDialog
          onOpenChange={(open) => {
            if (!open) {
              setReview(undefined)
            }
          }}
          open
        >
          <AlertDialogContent finalFocus={deleteTrigger}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("deleteAvatarTitle", { id: review.photoId })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("deleteAvatarDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {review.thumbnailUrl && (
              <Image
                alt=""
                className="size-24 rounded-md object-cover"
                height={96}
                referrerPolicy="no-referrer"
                src={review.thumbnailUrl}
                unoptimized
                width={96}
              />
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>{actions("cancel")}</AlertDialogCancel>
              <Button
                disabled={controls.busy}
                onClick={() => {
                  controls.submit(
                    {
                      kind: "deleteOwnAvatar",
                      photoId: review.photoId,
                      page: review.page,
                    },
                    true,
                  )
                  setReview(undefined)
                }}
                type="button"
                variant="destructive"
              >
                {t("confirmDeleteAvatar")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  )
}
