import {
  toZaloAccountWebUrl,
  type ZaloAccountRichContent,
} from "@chatbotx.io/sdk"
import { cn } from "@chatbotx.io/ui/lib/utils"
import {
  ContactRoundIcon,
  ExternalLinkIcon,
  LandmarkIcon,
  LinkIcon,
  MapPinIcon,
  PhoneIncomingIcon,
  PhoneMissedIcon,
  PhoneOutgoingIcon,
  QrCodeIcon,
  VideoIcon,
} from "lucide-react"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { type ReactNode, useState } from "react"
import { formatCallDurationSeconds } from "../lib/format-call-duration"

type RichCard = Exclude<
  ZaloAccountRichContent,
  { kind: "styledText" | "sticker" }
>

const cardClass =
  "flex w-fit max-w-full flex-col overflow-hidden rounded-xl border bg-secondary text-secondary-foreground text-sm"

export function ZaloRichCard({
  content,
  image,
}: {
  content: RichCard
  image?: string
}) {
  const t = useTranslations("zaloAccount.richMessage")
  const fields = useTranslations("fields")

  switch (content.kind) {
    case "link": {
      const url = toZaloAccountWebUrl(content.url)
      if (!url) {
        return null
      }
      return (
        <a
          className={cn(
            cardClass,
            "w-80 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          )}
          href={url.href}
          rel="noopener noreferrer"
          target="_blank"
        >
          <CardImage image={image} layout="cover" />
          <CardDetails
            detail={content.description}
            icon={<LinkIcon aria-hidden className="size-4" />}
            title={content.title || url.hostname}
          >
            <span className="flex items-center gap-1 text-muted-foreground text-xs">
              <span className="truncate">{url.hostname}</span>
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
            </span>
          </CardDetails>
        </a>
      )
    }
    case "contact":
      return (
        <div className={cardClass}>
          <CardDetails
            detail={content.phone}
            icon={
              <>
                <ContactRoundIcon aria-hidden className="size-5" />
                <CardImage image={image} layout="avatar" />
              </>
            }
            title={content.name || fields("contact.label")}
          >
            {!content.phone && content.userId && (
              <span className="text-muted-foreground text-xs">
                {content.userId}
              </span>
            )}
          </CardDetails>
        </div>
      )
    case "location": {
      const coordinates =
        content.latitude != null &&
        Math.abs(content.latitude) <= 90 &&
        content.longitude != null &&
        Math.abs(content.longitude) <= 180
          ? `${content.latitude},${content.longitude}`
          : undefined
      const href =
        toZaloAccountWebUrl(content.url)?.href ??
        (coordinates
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`
          : undefined)
      const title = content.title || fields("lastUserInputTypes.location")
      const detail = content.address || coordinates
      return (
        <div className={cardClass}>
          <CardDetails
            detail={detail}
            icon={<MapPinIcon aria-hidden className="size-5" />}
            title={title}
          >
            {href && (
              <a
                className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
                href={href}
                rel="noopener noreferrer"
                target="_blank"
              >
                {t("openMap")}
                <ExternalLinkIcon aria-hidden className="size-3" />
              </a>
            )}
          </CardDetails>
        </div>
      )
    }
    case "bank":
      return (
        <div className={cardClass}>
          <CardDetails
            detail={content.accountName}
            icon={<LandmarkIcon aria-hidden className="size-5" />}
            title={content.bankName || t("bankDetails")}
          >
            {content.accountNumber && (
              <p className="font-mono text-muted-foreground text-xs">
                {content.accountNumber}
              </p>
            )}
            {content.amount != null && (
              <p className="font-medium">{content.amount}</p>
            )}
            {content.description && (
              <p className="text-muted-foreground text-xs">
                {content.description}
              </p>
            )}
          </CardDetails>
          <CardImage alt={fields("qrCode.label")} image={image} layout="qr" />
        </div>
      )
    case "qr":
      return (
        <div className={cardClass}>
          <CardDetails
            detail={content.description}
            icon={<QrCodeIcon aria-hidden className="size-5" />}
            title={content.title || fields("qrCode.label")}
          />
          <CardImage alt={fields("qrCode.label")} image={image} layout="qr" />
        </div>
      )
    case "call": {
      const incoming = content.direction === "incoming"
      const missed = content.status === "missed"
      const DirectionIcon = incoming ? PhoneIncomingIcon : PhoneOutgoingIcon
      const Icon = missed ? PhoneMissedIcon : DirectionIcon
      return (
        <div className={cardClass}>
          <CardDetails
            icon={
              <Icon
                aria-hidden
                className={cn("size-5", missed && "text-destructive")}
              />
            }
            title={
              missed
                ? t(incoming ? "missedCall" : "unansweredCall")
                : t(incoming ? "incomingCall" : "outgoingCall")
            }
          >
            <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
              {content.medium === "video" && (
                <VideoIcon aria-hidden className="size-3.5" />
              )}
              {content.medium &&
                t(content.medium === "video" ? "videoCall" : "voiceCall")}
              {content.medium && content.durationMs != null && (
                <span aria-hidden>·</span>
              )}
              {content.durationMs != null && (
                <span className="tabular-nums">
                  {formatCallDurationSeconds(content.durationMs / 1000)}
                </span>
              )}
            </span>
          </CardDetails>
        </div>
      )
    }
    default:
      return null
  }
}

function CardDetails({
  title,
  detail,
  icon,
  children,
}: {
  title: string
  detail?: string
  icon: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-2.5 px-3 py-2.5">
      <span className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background/70 text-muted-foreground">
        {icon}
      </span>
      <div className="wrap-anywhere flex min-w-0 flex-col gap-1">
        <p className="font-medium leading-tight">{title}</p>
        {detail && (
          <p className="line-clamp-3 whitespace-pre-line text-muted-foreground text-xs">
            {detail}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

const imageLayout = {
  cover: {
    className: "relative block aspect-[2/1] bg-muted",
    sizes: "320px",
  },
  qr: {
    className:
      "relative mx-3 mb-3 block size-28 max-w-[calc(100%-1.5rem)] rounded-md bg-white p-1",
    sizes: "112px",
  },
  avatar: {
    className: "absolute inset-0",
    sizes: "32px",
  },
} as const

function CardImage({
  alt = "",
  image,
  layout,
}: {
  alt?: string
  image?: string
  layout: keyof typeof imageLayout
}) {
  const [failed, setFailed] = useState<string>()
  if (!image || failed === image) {
    return null
  }
  return (
    <span className={imageLayout[layout].className}>
      <Image
        alt={alt}
        className={layout === "qr" ? "object-contain" : "object-cover"}
        fill
        loading="lazy"
        onError={() => setFailed(image)}
        sizes={imageLayout[layout].sizes}
        src={image}
        unoptimized
      />
    </span>
  )
}
