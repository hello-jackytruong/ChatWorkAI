"use client"

import type { ZaloAccountSendContent } from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { useQuery } from "@tanstack/react-query"
import {
  ContactRoundIcon,
  EllipsisIcon,
  LandmarkIcon,
  LinkIcon,
  MicIcon,
  PaperclipIcon,
  TypeIcon,
  VideoIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useId, useState } from "react"
import { MediaLibraryTrigger } from "@/features/media-library/components/media-library-trigger"
import type { ListFilesResponse } from "@/features/media-library/schema"
import { getZaloComposerCapabilityAction } from "../actions/zalo-composer-capability.action"
import {
  trimZaloMentionRanges,
  updateZaloMentionRanges,
  type ZaloMentionRange,
} from "../lib/zalo-mention-draft"
import {
  ZALO_COMPOSER_MAX_DEVICE_FILE_BYTES,
  ZALO_COMPOSER_MAX_DEVICE_FILES,
  type ZaloComposerContent,
} from "../schema/mutation"
import { ZaloStickerPicker } from "./zalo-sticker-picker"
import { ZaloVoiceRecorder } from "./zalo-voice-recorder"

const modes = {
  media: { icon: PaperclipIcon, key: "pipelines.item.attachments" },
  video: { icon: VideoIcon, key: "fields.lastUserInputTypes.video" },
  voice: { icon: MicIcon, key: "fields.lastUserInputTypes.audio" },
  link: { icon: LinkIcon, key: "fields.link.label" },
  contactCard: { icon: ContactRoundIcon, key: "fields.contact.label" },
  bankCard: { icon: LandmarkIcon, key: "zaloAccount.richMessage.bankDetails" },
  text: { icon: TypeIcon, key: "miniApps.components.RichText" },
} as const

type Mode = keyof typeof modes
type LibraryFile = ListFilesResponse["data"][number]
type Style = NonNullable<
  Extract<ZaloAccountSendContent, { kind: "text" }>["styles"]
>[number]["st"]
const styles = {
  b: "dynamicImages.editor.bold",
  i: "dynamicImages.editor.italic",
  u: "zaloAccount.composer.underline",
  s: "miniApps.properties.strikethrough",
} as const satisfies Partial<Record<Style, string>>

type Props = {
  workspaceId: string
  conversationId: string
  inboxId: string
  userId?: string
  mentionDraft?: { text: string; mentions: ZaloMentionRange[] }
  onSend: (content: ZaloComposerContent) => boolean
}

export function ZaloComposer(props: Props) {
  const t = useTranslations()
  const { workspaceId, conversationId, inboxId, onSend, userId } = props
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>("media")
  const id = useId()
  const capability = useQuery({
    queryKey: [
      "zalo-composer-capability",
      workspaceId,
      conversationId,
      inboxId,
    ],
    queryFn: async () => {
      const result = await getZaloComposerCapabilityAction(
        workspaceId,
        conversationId,
        { inboxId },
      )
      return result?.data?.enabled === true
    },
    refetchInterval: 30_000,
  })
  if (!capability.data) {
    return null
  }

  return (
    <div className="mx-2.5 mb-1 min-w-0 rounded-lg">
      <div className="flex flex-wrap items-center gap-1">
        {userId && (
          <ZaloStickerPicker
            conversationId={conversationId}
            inboxId={inboxId}
            key={userId}
            onSend={(zaloAccountContent) => onSend({ zaloAccountContent })}
            userId={userId}
            workspaceId={workspaceId}
          />
        )}
        <Button
          aria-controls={open ? id : undefined}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <EllipsisIcon aria-hidden />
          {t("zaloAccount.composer.moreMessageTypes")}
        </Button>
      </div>
      {open && (
        <div
          className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-2.5"
          id={id}
        >
          <div className="flex flex-wrap gap-1">
            {(Object.keys(modes) as Mode[]).map((option) => {
              const Icon = modes[option].icon
              return (
                <Button
                  aria-pressed={mode === option}
                  key={option}
                  onClick={() => setMode(option)}
                  size="sm"
                  type="button"
                  variant={mode === option ? "secondary" : "ghost"}
                >
                  <Icon aria-hidden />
                  {t(modes[option].key)}
                </Button>
              )
            })}
          </div>
          <ComposerFields
            key={mode}
            mentionDraft={props.mentionDraft}
            mode={mode}
            onCancel={() => setOpen(false)}
            onSend={(content) => {
              const queued = onSend(content)
              if (queued) {
                setOpen(false)
              }
              return queued
            }}
            workspaceId={workspaceId}
          />
        </div>
      )}
    </div>
  )
}

function ComposerFields({
  mode,
  mentionDraft,
  workspaceId,
  onCancel,
  onSend,
}: {
  mode: Mode
  workspaceId: string
  onCancel: () => void
  onSend: Props["onSend"]
  mentionDraft?: Props["mentionDraft"]
}) {
  const t = useTranslations()
  const [media, setMedia] = useState<LibraryFile[]>([])
  const [deviceFiles, setDeviceFiles] = useState<File[]>([])
  const [poster, setPoster] = useState<LibraryFile>()
  const [text, setText] = useState(() =>
    mode === "text" && mentionDraft?.mentions.length ? mentionDraft.text : "",
  )
  const [primary, setPrimary] = useState("")
  const [secondary, setSecondary] = useState("")
  const [accountName, setAccountName] = useState("")
  const [textStyles, setTextStyles] = useState<Style[]>([])
  const [urgency, setUrgency] = useState<0 | 1 | 2>(0)
  const [invalid, setInvalid] = useState(false)
  const selectMedia = (files: LibraryFile[]) => {
    const mimeType = files[0]?.mimeType
    const valid =
      mode === "media"
        ? files.length > 0 && files.length <= 9
        : files.length === 1 && !!mimeType && isNativeMediaMime(mode, mimeType)
    setInvalid(!valid)
    if (valid) {
      setDeviceFiles([])
      setMedia(files)
    }
  }

  const submit = () => {
    const caption = text.trim() || undefined
    const firstMediaId = media[0]?.id
    switch (mode) {
      case "media":
        return onSend({
          zaloAccountUpload: {
            type: "media",
            ...(caption && { caption }),
            ...(media.length
              ? { mediaFileIds: media.map(({ id }) => id) }
              : { files: deviceFiles }),
          },
        })
      case "video":
        return Boolean(
          firstMediaId &&
            poster &&
            onSend({
              zaloAccountUpload: {
                type: "video",
                mediaFileId: firstMediaId,
                posterMediaFileId: poster.id,
                ...(caption && { caption }),
              },
            }),
        )
      case "voice":
        return Boolean(
          firstMediaId &&
            onSend({
              zaloAccountUpload: { type: "voice", mediaFileId: firstMediaId },
            }),
        )
      case "link":
        return onSend({
          zaloAccountContent: {
            kind: "link",
            url: primary.trim(),
            ...(caption && { text: caption }),
          },
        })
      case "contactCard":
        return onSend({
          zaloAccountContent: {
            kind: "contactCard",
            userId: primary.trim(),
            ...(secondary.trim() && { phoneNumber: secondary.trim() }),
          },
        })
      case "bankCard":
        return onSend({
          zaloAccountContent: {
            kind: "bankCard",
            bankBin: primary.trim(),
            accountNumber: secondary.trim(),
            ...(accountName.trim() && { accountName: accountName.trim() }),
          },
        })
      case "text": {
        const mentions = mentionDraft
          ? trimZaloMentionRanges(
              text,
              updateZaloMentionRanges(
                mentionDraft.text,
                text,
                mentionDraft.mentions,
              ),
            )
          : []
        return Boolean(
          caption &&
            onSend({
              zaloAccountContent: {
                kind: "text",
                text: caption,
                urgency,
                ...(mentions.length > 0 && { mentions }),
                styles: textStyles.map((st) => ({
                  st,
                  start: 0,
                  len: caption.length,
                })),
              },
            }),
        )
      }
      default:
        return false
    }
  }

  const mediaMode = mode === "media" || mode === "video" || mode === "voice"
  const hasCaption = mode === "media" || mode === "video" || mode === "link"

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {mediaMode && (
        <div className="flex flex-wrap items-center gap-2">
          <MediaLibraryTrigger
            multiple={mode === "media"}
            onSelect={(file) => selectMedia([file])}
            onSelectMultiple={selectMedia}
            workspaceId={workspaceId}
          >
            <Button size="sm" type="button" variant="outline">
              {mode === "media"
                ? t("mediaLibrary.openMediaLibrary")
                : t(modes[mode].key)}
            </Button>
          </MediaLibraryTrigger>
          {mode === "video" && (
            <MediaLibraryTrigger
              fileType="image"
              onSelect={(file) => {
                const acceptable = [
                  "image/jpeg",
                  "image/png",
                  "image/webp",
                ].includes(file.mimeType)
                setInvalid(!acceptable)
                if (acceptable) {
                  setPoster(file)
                }
              }}
              workspaceId={workspaceId}
            >
              <Button size="sm" type="button" variant="outline">
                {t("zaloAccount.composer.videoPoster")}
              </Button>
            </MediaLibraryTrigger>
          )}
          {mode === "media" && (
            <Label className="flex items-center gap-1.5">
              {t("actions.selectFile")}
              <input
                className="w-37 text-xs"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? [])
                  const valid =
                    files.length <= ZALO_COMPOSER_MAX_DEVICE_FILES &&
                    files.every(
                      (file) =>
                        file.size > 0 &&
                        file.size <= ZALO_COMPOSER_MAX_DEVICE_FILE_BYTES,
                    )
                  setInvalid(!valid)
                  if (valid && files.length) {
                    setMedia([])
                    setDeviceFiles(files)
                  }
                  event.currentTarget.value = ""
                }}
                type="file"
              />
            </Label>
          )}
        </div>
      )}
      {mediaMode && (media.length > 0 || deviceFiles.length > 0 || poster) && (
        <ol className="list-decimal ps-5 text-muted-foreground text-xs">
          {media.map((file) => (
            <li className="wrap-anywhere" key={file.id}>
              {file.name}
            </li>
          ))}
          {deviceFiles.map((file) => (
            <li
              className="wrap-anywhere"
              key={`${file.name}:${file.lastModified}:${file.size}`}
            >
              {file.name}
            </li>
          ))}
          {poster && <li className="wrap-anywhere">{poster.name}</li>}
        </ol>
      )}
      {mode === "voice" && media.length === 0 && (
        <ZaloVoiceRecorder
          onSend={(file) =>
            onSend({
              zaloAccountUpload: { type: "voice", file },
            })
          }
        />
      )}
      {mode === "link" && (
        <ComposerInput
          label={t("fields.link.label")}
          onChange={setPrimary}
          type="url"
          value={primary}
        />
      )}
      {mode === "contactCard" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <ComposerInput
            label={t("fields.userId.label")}
            onChange={setPrimary}
            value={primary}
          />
          <ComposerInput
            label={t("fields.phoneNumber.label")}
            onChange={setSecondary}
            type="tel"
            value={secondary}
          />
        </div>
      )}
      {mode === "bankCard" && (
        <div className="grid gap-2 sm:grid-cols-3">
          <ComposerInput
            label={t("zaloAccount.composer.bankBin")}
            onChange={setPrimary}
            value={primary}
          />
          <ComposerInput
            label={t("zaloAccount.composer.accountNumber")}
            onChange={setSecondary}
            value={secondary}
          />
          <ComposerInput
            label={t("fields.name.label")}
            onChange={setAccountName}
            value={accountName}
          />
        </div>
      )}
      {(hasCaption || mode === "text") && (
        <ComposerInput
          label={t(
            hasCaption
              ? "miniApps.components.TextCaption"
              : "fields.text.label",
          )}
          onChange={setText}
          value={text}
        />
      )}
      {mode === "text" && (
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(styles) as (keyof typeof styles)[]).map((style) => (
            <Button
              aria-pressed={textStyles.includes(style)}
              key={style}
              onClick={() =>
                setTextStyles((active) =>
                  active.includes(style)
                    ? active.filter((item) => item !== style)
                    : [...active, style],
                )
              }
              size="sm"
              type="button"
              variant={textStyles.includes(style) ? "secondary" : "ghost"}
            >
              {t(styles[style])}
            </Button>
          ))}
          <Label className="flex items-center gap-1.5">
            {t("pipelines.item.priority")}
            <select
              className="rounded border bg-background px-1.5 py-1 text-sm"
              onChange={(event) => {
                const value = Number(event.currentTarget.value)
                if (value === 0 || value === 1 || value === 2) {
                  setUrgency(value)
                }
              }}
              value={urgency}
            >
              <option value={0}>
                {t("miniApps.options.fontWeight.normal")}
              </option>
              <option value={1}>{t("pipelines.priority.high")}</option>
              <option value={2}>{t("zaloAccount.composer.urgent")}</option>
            </select>
          </Label>
        </div>
      )}
      {invalid && (
        <p className="text-destructive text-xs" role="alert">
          {t("validation.form.invalid")}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-1.5">
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          {t("actions.cancel")}
        </Button>
        {(mode !== "voice" || media.length > 0) && (
          <Button onClick={() => setInvalid(!submit())} size="sm" type="button">
            {t("actions.send")}
          </Button>
        )}
      </div>
    </div>
  )
}

function isNativeMediaMime(mode: Mode, mime: string) {
  if (mode === "video") {
    return mime === "video/mp4"
  }
  return ["audio/mp4", "audio/x-m4a"].includes(mime)
}

function ComposerInput({
  label,
  onChange,
  value,
  type = "text",
}: {
  label: string
  onChange: (value: string) => void
  value: string
  type?: "text" | "url" | "tel"
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
          }
        }}
        type={type}
        value={value}
      />
    </div>
  )
}
