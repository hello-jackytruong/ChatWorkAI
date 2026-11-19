"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { LanguagesIcon, Loader2Icon } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { languageLabel } from "../lib/language-label"
import type { MessageTranslationView } from "../lib/message-translation-view"

type MessageTranslationProps = {
  view: Exclude<MessageTranslationView, { kind: "none" }>
  /** "Retry" on a failed translation. */
  onRetry: () => void
  /** "Request again" on one that never answered. */
  onRequestAgain: () => void
  /** A translated message shows its original only while this is true. */
  expanded: boolean
}

type TranslatedView = Extract<MessageTranslationView, { kind: "translated" }>

/**
 * The small icon after a translated message's last word. Collapsed, a bubble is
 * as tall as an untranslated one; the icon opens the original (or, for an
 * agent's own message, what the customer received).
 */
export function TranslationToggle(props: {
  view: TranslatedView
  expanded: boolean
  onToggle: () => void
}) {
  const { view, expanded, onToggle } = props
  const t = useTranslations("inboxTranslation.message")
  const locale = useLocale()
  const language = view.languageCode
    ? languageLabel(view.languageCode, locale)
    : null
  const isInbound = view.direction === "inbound"

  let label: string
  if (expanded) {
    label = isInbound ? t("hideOriginal") : t("hideSent")
  } else if (isInbound) {
    label = language
      ? t("translatedFrom", { language })
      : t("translatedFromNoLanguage")
  } else {
    label = language ? t("sentIn", { language }) : t("sentInNoLanguage")
  }

  return (
    <button
      aria-expanded={expanded}
      aria-label={label}
      className="ms-1 inline-flex size-4 translate-y-0.5 items-center justify-center rounded align-baseline opacity-60 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-current/40"
      onClick={onToggle}
      title={label}
      type="button"
    >
      <LanguagesIcon aria-hidden className="size-3.5" />
    </button>
  )
}

/**
 * The block under a bubble's main text: the original (or what was sent) while a
 * translated message is expanded, otherwise the state of the request. A neutral
 * "still waiting" is never an error; only a stored failure offers "Retry".
 */
export function MessageTranslation({
  view,
  onRetry,
  onRequestAgain,
  expanded,
}: MessageTranslationProps) {
  const t = useTranslations("inboxTranslation.message")
  const locale = useLocale()

  if (view.kind === "translated") {
    if (!expanded) {
      return null
    }
    const language = view.languageCode
      ? languageLabel(view.languageCode, locale)
      : null
    let label: string
    if (view.direction === "inbound") {
      label = language ? t("original", { language }) : t("originalNoLanguage")
    } else {
      label = language ? t("sent", { language }) : t("sentNoLanguage")
    }
    return (
      <div className="mt-1 border-current/20 border-t pt-1 text-xs opacity-80">
        <p className="font-medium opacity-80">{label}</p>
        <pre
          className="wrap-break-word whitespace-pre-line font-sans"
          dir="auto"
        >
          {view.secondaryText}
        </pre>
      </div>
    )
  }

  if (view.kind === "pending") {
    return (
      <p className="mt-1 flex items-center gap-1 text-xs opacity-70">
        <Loader2Icon aria-hidden className="size-3 animate-spin" />
        {t("translating")}
      </p>
    )
  }

  const isFailed = view.kind === "failed"
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1 text-xs opacity-80">
      <span>{isFailed ? t("failed") : t("stillWaiting")}</span>
      <Button
        className="h-5 px-1 text-xs"
        onClick={isFailed ? onRetry : onRequestAgain}
        size="sm"
        type="button"
        variant="ghost"
      >
        {isFailed ? t("retry") : t("requestAgain")}
      </Button>
    </p>
  )
}
