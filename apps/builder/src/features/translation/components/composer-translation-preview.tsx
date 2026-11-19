"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { Loader2Icon } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import type { TranslationPreview } from "../hooks/use-translation-preview"
import { languageLabel } from "../lib/language-label"

/**
 * The review panel between the text box and the toolbar: what the customer will
 * receive, editable. Enter sends the panel's text (see the composer), so an
 * agent can fix a translation before it goes out.
 */
export function ComposerTranslationPreview(props: {
  preview: TranslationPreview
  language: string
  onEdit: (translated: string) => void
  onTranslate: () => void
}) {
  const { preview, language, onEdit, onTranslate } = props
  const t = useTranslations("inboxTranslation.composer.preview")
  const locale = useLocale()
  if (preview.status === "idle") {
    return null
  }

  const isStale = preview.status === "stale"
  return (
    <div className="mx-2.5 mb-1 rounded-md border bg-muted/40 text-sm">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1 text-muted-foreground text-xs">
        <span>{t("title", { language: languageLabel(language, locale) })}</span>
        <span className="flex items-center gap-1">
          {preview.status === "loading" && (
            <>
              <Loader2Icon aria-hidden className="size-3 animate-spin" />
              {t("translating")}
            </>
          )}
          {isStale && <span>{t("needsRetranslate")}</span>}
          {(isStale || preview.status === "failed") && (
            <Button
              className="h-5 px-1.5 text-xs"
              onClick={onTranslate}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("retranslate")}
            </Button>
          )}
        </span>
      </div>
      {preview.status === "failed" && (
        <p className="px-2 py-1.5 text-muted-foreground text-xs">
          {t("failed")}
        </p>
      )}
      {(preview.status === "ready" || isStale) && (
        <Textarea
          aria-label={t("title", { language: languageLabel(language, locale) })}
          className="h-14 resize-none border-0 px-2 py-1 shadow-none focus-visible:ring-0"
          dir="auto"
          onChange={(event) => onEdit(event.target.value)}
          value={preview.translated}
        />
      )}
    </div>
  )
}
