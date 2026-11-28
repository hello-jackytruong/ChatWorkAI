import { cn } from "@chatbotx.io/ui/lib/utils"
import {
  DownloadIcon,
  ImageIcon,
  LoaderCircleIcon,
  VideoIcon,
  Volume2Icon,
} from "lucide-react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { useAttachmentSource } from "@/features/attachments/utils"
import { formatCallDurationSeconds } from "../lib/format-call-duration"
import {
  type ZaloRichClip as Clip,
  getZaloMediaUrl,
} from "../lib/zalo-rich-message"

const clipIcon = {
  gif: ImageIcon,
  video: VideoIcon,
  audio: Volume2Icon,
} as const

export function ZaloRichClip({ clip }: { clip: Clip }) {
  const { attachment, kind, media, poster, providerGif } = clip
  const t = useTranslations("zaloAccount.richMessage")
  const fields = useTranslations("fields.lastUserInputTypes")
  const actions = useTranslations("actions")
  const label = fields(kind)
  const Icon = clipIcon[kind]
  const primaryUrl = getZaloMediaUrl(attachment?.url)
  const fallback = getZaloMediaUrl(attachment?.fallbackUrl)
  const source = useAttachmentSource(
    attachment
      ? { ...attachment, url: primaryUrl ?? null, fallbackUrl: fallback }
      : undefined,
  )
  const [failed, setFailed] = useState<string>()
  const [failedProvider, setFailedProvider] = useState<string>()
  const pending = media?.state === "pending" || media?.state === "downloading"
  const standaloneUrl =
    media?.state === "stored" ||
    (kind === "gif" && (pending || media?.state === "failed"))
      ? getZaloMediaUrl(media?.url)
      : undefined
  const fallbackUrl = attachment ? source.url : standaloneUrl
  const url =
    providerGif && providerGif.url !== failedProvider
      ? providerGif.url
      : fallbackUrl
  const activeUrl = url === failed ? undefined : url
  const mime = providerGif?.mimeType ?? media?.mimeType ?? attachment?.mimeType
  const sourceType = mime === "application/octet-stream" ? undefined : mime
  const width = providerGif?.width ?? attachment?.width ?? media?.width
  const height = providerGif?.height ?? attachment?.height ?? media?.height
  const aspectRatio = width && height ? `${width} / ${height}` : "4 / 3"
  const duration = media?.durationMs
  const handleError = () => {
    if (providerGif && url === providerGif.url) {
      setFailedProvider(url)
      return
    }
    if (!source.retryUrl || source.retryUrl === url) {
      setFailed(url)
      return
    }
    source.onError()
  }
  const downloadUrl = source.fallbackUrl ?? (attachment ? primaryUrl : url)
  const animation = kind === "gif" && mime?.startsWith("video/")

  return (
    <div
      className={cn(
        "flex max-w-full flex-col overflow-hidden rounded-xl border bg-secondary text-secondary-foreground text-sm",
        kind === "audio" ? "w-72" : "w-80",
      )}
    >
      {activeUrl && kind === "audio" && (
        <audio
          aria-label={label}
          className="w-full"
          controls
          key={activeUrl}
          onError={handleError}
          preload="none"
        >
          <track default kind="captions" />
          <source onError={handleError} src={activeUrl} type={sourceType} />
        </audio>
      )}
      {activeUrl && kind !== "audio" && (
        <div
          className="relative max-h-80 w-full bg-muted"
          style={{ aspectRatio }}
        >
          {kind === "video" || animation ? (
            <video
              aria-label={label}
              autoPlay={animation || source.isRecovering}
              className="absolute inset-0 size-full object-contain"
              controls={!animation}
              key={activeUrl}
              loop={animation}
              muted={animation}
              onError={handleError}
              playsInline
              poster={poster}
              preload={animation || source.isRecovering ? "auto" : "none"}
            >
              <track default kind="captions" />
              <source onError={handleError} src={activeUrl} type={sourceType} />
            </video>
          ) : (
            <Image
              alt={label}
              className="object-contain"
              fill
              loading="lazy"
              onError={handleError}
              referrerPolicy="no-referrer"
              sizes="320px"
              src={activeUrl}
              unoptimized
            />
          )}
        </div>
      )}
      {!activeUrl && (
        <div
          className="flex items-center gap-2 px-3 py-2.5 text-muted-foreground"
          role="status"
        >
          {pending ? (
            <LoaderCircleIcon
              aria-hidden
              className="size-4 shrink-0 motion-safe:animate-spin"
            />
          ) : (
            <Icon aria-hidden className="size-4 shrink-0" />
          )}
          {t(pending ? "processingMedia" : "mediaUnavailable")}
        </div>
      )}
      {(downloadUrl || duration != null) && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-muted-foreground text-xs">
          {duration != null && (
            <span className="tabular-nums">
              {formatCallDurationSeconds(duration / 1000)}
            </span>
          )}
          {downloadUrl && (
            <a
              className="ms-auto inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
              download={attachment?.name ?? true}
              href={downloadUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <DownloadIcon aria-hidden className="size-3.5" />
              {actions("download")}
            </a>
          )}
        </div>
      )}
    </div>
  )
}
