"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Checkbox } from "@chatbotx.io/ui/components/ui/checkbox"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { LanguagesIcon } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useId, useMemo } from "react"
import { toast } from "sonner"
import { useChatStore } from "@/features/chat/store/chat-store-provider"
import { useWorkspaceId } from "@/hooks/routing"
import { updateConversationTranslationStateAction } from "../actions/update-conversation-state.action"
import { useInvalidateTranslation } from "../hooks/use-invalidate-translation"
import type { ComposerTranslationState } from "../lib/composer-translation"
import {
  readConversationTranslation,
  withConversationTranslation,
} from "../lib/conversation-translation"
import {
  COMMON_LANGUAGE_CODES,
  languageBadge,
  languageLabel,
} from "../lib/language-label"

/**
 * The chip next to the channel icon: which language the next message is
 * translated into (or why it is not translated). Its popover changes the
 * customer's language by hand, switches the review preview on and off, and turns
 * translation off for this conversation.
 */
export function ComposerTargetLanguage(props: {
  conversation: { id: string; additionalAttributes?: unknown }
  state: ComposerTranslationState
  previewEnabled: boolean
  onPreviewEnabledChange: (enabled: boolean) => void
}) {
  const { conversation, state, previewEnabled, onPreviewEnabledChange } = props
  const t = useTranslations("inboxTranslation.composer")
  const locale = useLocale()
  const workspaceId = useWorkspaceId()
  const updateConversation = useChatStore((state) => state.updateConversation)
  const invalidate = useInvalidateTranslation()
  const previewId = useId()

  const { execute } = useAction(
    updateConversationTranslationStateAction.bind(
      null,
      workspaceId,
      conversation.id,
    ),
    {
      onSuccess: ({ input }) => {
        const current = readConversationTranslation(conversation)
        updateConversation(conversation.id, {
          additionalAttributes: withConversationTranslation(
            conversation.additionalAttributes,
            {
              language: input.language ?? current.language ?? undefined,
              languageSource: input.language
                ? "manual"
                : (current.languageSource ?? undefined),
              ...(input.enabledOverride === false
                ? { enabledOverride: false }
                : {}),
            },
          ),
        })
        invalidate()
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  const options = useMemo(
    () =>
      COMMON_LANGUAGE_CODES.map((code) => ({
        value: code,
        label: languageLabel(code, locale),
      })),
    [locale],
  )

  if (state.kind === "hidden") {
    return null
  }

  const language = "language" in state ? state.language : null
  const label = chipLabel(state, t, languageBadge)
  const isTranslating = state.kind === "active"

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("chip.aria")}
            className={
              isTranslating ? "gap-1 px-2" : "gap-1 px-2 text-muted-foreground"
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            <LanguagesIcon aria-hidden className="size-4" />
            <span className="text-xs">{label}</span>
          </Button>
        }
      />
      <PopoverContent className="w-72 space-y-3" side="top">
        <div className="space-y-1">
          <p className="font-medium text-sm">{t("popover.customerLanguage")}</p>
          <Select
            items={options}
            onValueChange={(value) => execute({ language: String(value) })}
            value={language ?? undefined}
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue placeholder={t("popover.chooseLanguage")} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={previewEnabled}
            id={previewId}
            onCheckedChange={(checked) =>
              onPreviewEnabledChange(checked === true)
            }
          />
          <label htmlFor={previewId}>{t("popover.preview")}</label>
        </div>
        <Button
          className="h-auto p-0 text-sm"
          onClick={() =>
            execute({
              enabledOverride: state.kind === "off" ? null : false,
            })
          }
          type="button"
          variant="link"
        >
          {state.kind === "off" ? t("popover.turnOn") : t("popover.turnOff")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function chipLabel(
  state: ComposerTranslationState,
  t: ReturnType<typeof useTranslations>,
  badge: (code: string) => string,
): string {
  switch (state.kind) {
    case "active":
      return t("chip.target", { language: badge(state.language) })
    case "sameLanguage":
      return t("chip.sameLanguage")
    case "unknownLanguage":
      return t("chip.unknown")
    case "hasFiles":
      return t("chip.hasFiles")
    case "off":
      return t("chip.off")
    default:
      return ""
  }
}
