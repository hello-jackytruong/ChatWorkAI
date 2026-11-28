"use client"

import {
  type ZaloAccountNativeToolOperation,
  type ZaloAccountQuickMessages,
  zaloAccountNativeToolOperationSchema,
} from "@chatbotx.io/sdk"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { MediaLibraryTrigger } from "@/features/media-library/components/media-library-trigger"

type Item = ZaloAccountQuickMessages["items"][number]
type Write = Extract<
  ZaloAccountNativeToolOperation,
  { kind: "addQuickMessage" | "updateQuickMessage" | "deleteQuickMessage" }
>
type Media = NonNullable<Extract<Write, { kind: "addQuickMessage" }>["media"]>
type Submit = (operation: Write, confirmationTitle?: string) => void
type Editor = { version: string; item?: Item }
const maximumImageBytes = 10_485_760
const imageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"])

function QuickImage({ url }: { url?: string }) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const [failed, setFailed] = useState(false)
  return url && !failed ? (
    <Image
      alt={t("imageAlt")}
      className="size-20 rounded-md object-contain"
      height={80}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={url}
      unoptimized
      width={80}
    />
  ) : (
    <p className="text-muted-foreground text-xs">{t("imageUnavailable")}</p>
  )
}

function QuickMessageEditor({
  editor,
  workspaceId,
  busy,
  submit,
  onCancel,
}: {
  editor: Editor
  workspaceId: string
  busy: boolean
  submit: Submit
  onCancel: () => void
}) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const actions = useTranslations("actions")
  const item = editor.item
  const form = useForm({
    defaultValues: { keyword: item?.keyword ?? "", title: item?.title ?? "" },
  })
  const [media, setMedia] = useState<Media>()
  const [invalid, setInvalid] = useState(false)
  return (
    <Form {...form}>
      <form
        className="space-y-3 rounded-md border p-3"
        onSubmit={form.handleSubmit((values) => {
          const keyword = values.keyword.trim()
          const title = values.title.trim()
          if (
            item &&
            keyword === item.keyword &&
            title === item.title &&
            !media
          ) {
            onCancel()
            return
          }
          const body = {
            expectedVersion: editor.version,
            keyword,
            title,
            ...(media ? { media } : {}),
          }
          const parsed = zaloAccountNativeToolOperationSchema.safeParse(
            item
              ? {
                  kind: "updateQuickMessage",
                  ...body,
                  id: item.id,
                  ...(media ? { mediaMode: "replace" } : {}),
                }
              : { kind: "addQuickMessage", ...body },
          )
          setInvalid(!parsed.success)
          if (
            parsed.success &&
            (parsed.data.kind === "addQuickMessage" ||
              parsed.data.kind === "updateQuickMessage")
          ) {
            submit(parsed.data)
            onCancel()
          }
        })}
      >
        <InputField
          aria-label={t("keyword")}
          disabled={busy}
          label={t("keyword")}
          maxLength={100}
          name="keyword"
          required
        />
        <TextareaField
          aria-label={t("text")}
          disabled={busy}
          label={t("text")}
          maxLength={2000}
          name="title"
          required
        />
        <div className="flex flex-wrap items-center gap-2">
          <MediaLibraryTrigger
            fileType="image"
            onSelect={(file) => {
              if (
                !imageMimeTypes.has(file.mimeType) ||
                file.size <= 0 ||
                file.size > maximumImageBytes
              ) {
                setInvalid(true)
                return
              }
              setInvalid(false)
              setMedia({
                url: file.url,
                name: file.name,
                mimeType: file.mimeType,
                size: file.size,
              })
            }}
            workspaceId={workspaceId}
          >
            <Button disabled={busy} size="sm" type="button" variant="secondary">
              {item?.hasMedia ? t("replaceImage") : t("chooseImage")}
            </Button>
          </MediaLibraryTrigger>
          {media && (
            <>
              <QuickImage key={media.url} url={media.url} />
              <Button
                disabled={busy}
                onClick={() => setMedia(undefined)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {actions("clear")}
              </Button>
            </>
          )}
        </div>
        {invalid && <p role="alert">{t("invalidQuick")}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} size="sm" type="submit">
            {actions("save")}
          </Button>
          <Button
            disabled={busy}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            {actions("cancel")}
          </Button>
        </div>
      </form>
    </Form>
  )
}

export function NativeQuickMessages({
  busy,
  canWrite,
  items,
  submit,
  version,
  workspaceId,
}: {
  busy: boolean
  canWrite: boolean
  items: Item[]
  submit: Submit
  version: string
  workspaceId: string
}) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const actions = useTranslations("actions")
  const [editing, setEditing] = useState<Editor>()

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground">{t("quickDescription")}</p>
      {canWrite && !editing && (
        <Button
          disabled={busy}
          onClick={() => setEditing({ version })}
          size="sm"
          type="button"
          variant="secondary"
        >
          {t("addQuick")}
        </Button>
      )}
      {canWrite && editing && (
        <QuickMessageEditor
          busy={busy}
          editor={editing}
          key={editing.item?.id ?? "new"}
          onCancel={() => setEditing(undefined)}
          submit={submit}
          workspaceId={workspaceId}
        />
      )}
      {items.length === 0 && <p>{t("quickEmpty")}</p>}
      {items.length > 0 && (
        <ul className="divide-y rounded-md border px-3">
          {items.map((item) => {
            const keyword = item.keyword || String(item.id)
            return (
              <li
                className="flex flex-wrap justify-between gap-3 py-3"
                key={item.id}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="wrap-break-word font-medium">{keyword}</p>
                  <p className="wrap-break-word whitespace-pre-wrap text-muted-foreground">
                    {item.title || t("noText")}
                  </p>
                  {item.hasMedia && (
                    <QuickImage key={item.media?.url} url={item.media?.url} />
                  )}
                </div>
                {canWrite && (
                  <div className="flex flex-wrap items-start gap-1">
                    <Button
                      aria-label={t("editNamedQuick", { keyword })}
                      disabled={busy}
                      onClick={() => setEditing({ version, item })}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {actions("edit")}
                    </Button>
                    {item.hasMedia && (
                      <Button
                        aria-label={t("removeNamedImage", { keyword })}
                        disabled={busy || !item.keyword || !item.title}
                        onClick={() =>
                          submit(
                            {
                              kind: "updateQuickMessage",
                              expectedVersion: version,
                              id: item.id,
                              keyword: item.keyword,
                              title: item.title,
                              mediaMode: "remove",
                            },
                            t("removeImageTitle", { keyword }),
                          )
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("removeImage")}
                      </Button>
                    )}
                    <Button
                      aria-label={t("deleteNamedQuick", { keyword })}
                      disabled={busy}
                      onClick={() =>
                        submit(
                          {
                            kind: "deleteQuickMessage",
                            expectedVersion: version,
                            id: item.id,
                          },
                          t("deleteQuickTitle", { keyword }),
                        )
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {actions("delete")}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
