"use client"

import {
  createZaloAccountGroupManagementCommandId,
  type ZaloAccountNativeToolOperation,
  type ZaloAccountNativeToolResult,
} from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@chatbotx.io/ui/components/ui/sheet"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { type RefObject, useId, useRef, useState, useTransition } from "react"
import {
  getZaloNativeConversationSettingAttemptAction,
  getZaloNativeConversationSettingsAction,
  setZaloNativeConversationSettingAction,
} from "../actions/native-conversation-settings.action"

const muteOptions = [
  { value: 0, label: "muteNone" },
  { value: 3600, label: "muteHour" },
  { value: 14_400, label: "muteFourHours" },
  { value: -1, label: "muteForever" },
] as const
const autoDeleteOptions = [
  { value: 0, label: "autoDeleteNone" },
  { value: 86_400_000, label: "autoDeleteDay" },
  { value: 604_800_000, label: "autoDeleteWeek" },
  { value: 1_209_600_000, label: "autoDeleteFortnight" },
] as const

type SettingsResponse = NonNullable<
  NonNullable<
    Awaited<ReturnType<typeof getZaloNativeConversationSettingsAction>>
  >["data"]
>
type WriteOperation = Exclude<
  ZaloAccountNativeToolOperation,
  { kind: "readConversationSettings" }
>
type AttemptStatus =
  | "pending"
  | "dispatched"
  | ZaloAccountNativeToolResult["outcome"]
type Attempt = {
  commandId: string
  status: AttemptStatus
  result?: ZaloAccountNativeToolResult
}
type Target = {
  workspaceId: string
  accountId: string | null
  conversationId: string
  contactInboxId: string
}

const outcomeLabels = {
  confirmed: "confirmed",
  partial: "writePartial",
  rejected: "rejected",
  unknown: "unknownOutcome",
  unavailable: "unavailable",
  pending: "pending",
  dispatched: "pending",
} as const satisfies Record<AttemptStatus, string>

const switches = [
  { field: "pinned", kind: "setPinned", label: "pinned" },
  { field: "archived", kind: "setArchived", label: "archived" },
  { field: "unread", kind: "setUnread", label: "unread" },
  { field: "hidden", kind: "setHidden", label: "hidden" },
] as const

function params(target: Target) {
  return {
    conversationId: target.conversationId,
    contactInboxId: target.contactInboxId,
  }
}

function settingsKey(target: Target) {
  return [
    "zalo-native-conversation-settings",
    target.workspaceId,
    target.accountId,
    target.conversationId,
    target.contactInboxId,
  ] as const
}

function DurationField({
  label,
  applyLabel,
  busy,
  value,
  otherValue,
  options,
  onSave,
}: {
  label: string
  applyLabel: string
  busy: boolean
  value?: number
  otherValue?: string
  options: readonly { value: number; label: string }[]
  onSave: (value: number) => void
}) {
  const t = useTranslations()
  const id = useId()
  const [draft, setDraft] = useState<number>()
  const selected = draft ?? value
  const knownOption = options.some((option) => option.value === selected)

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-3">
      <label
        className="font-medium"
        htmlFor={value === undefined ? undefined : id}
      >
        {label}
      </label>
      {value === undefined ? (
        <span className="text-muted-foreground">
          {t("condition.unknownValue")}
        </span>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <select
            aria-label={label}
            className="h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
            disabled={busy}
            id={id}
            onChange={(event) => setDraft(Number(event.target.value))}
            value={selected}
          >
            {!knownOption && (
              <option value={value}>
                {otherValue ?? t("condition.unknownValue")}
              </option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            aria-label={applyLabel}
            disabled={busy || draft === undefined || draft === value}
            onClick={() => {
              if (draft !== undefined) {
                onSave(draft)
                setDraft(undefined)
              }
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("zaloAccount.nativeConversationSettings.apply")}
          </Button>
        </div>
      )}
    </div>
  )
}

export function ZaloNativeConversationSettings({
  open,
  onOpenChange,
  finalFocus,
  ...target
}: Target & {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus: RefObject<HTMLButtonElement | null>
}) {
  const t = useTranslations("zaloAccount.nativeConversationSettings")
  const common = useTranslations()
  const client = useQueryClient()
  const key = settingsKey(target)
  const [attempt, setAttempt] = useState<Attempt>()
  const [inspectionUnavailable, setInspectionUnavailable] = useState(false)
  const [pending, startTransition] = useTransition()
  const requestInFlight = useRef(false)
  const query = useQuery({
    queryKey: key,
    enabled: open,
    queryFn: async ({ signal }) => {
      const response = await getZaloNativeConversationSettingsAction(
        target.workspaceId,
        target.accountId,
        params(target),
      )
      signal.throwIfAborted()
      if (!response?.data) {
        throw new Error("Zalo conversation settings unavailable")
      }
      return response.data
    },
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const unresolved =
    attempt?.status === "unknown" ||
    attempt?.status === "pending" ||
    attempt?.status === "dispatched"
  const busy =
    pending ||
    query.isFetching ||
    query.isError ||
    unresolved ||
    !query.data?.writeEnabled
  const settings = query.data?.settings

  async function showAttempt(response: Attempt) {
    setAttempt(response)
    if (response.status === "confirmed" || response.status === "partial") {
      const readback = response.result?.conversation
      if (readback) {
        client.setQueryData<SettingsResponse>(key, (current) =>
          current
            ? {
                ...current,
                settings: { ...current.settings, ...readback },
              }
            : current,
        )
      }
      await client.invalidateQueries({ queryKey: key, exact: true })
    }
  }

  function write(operation: WriteOperation) {
    if (busy || requestInFlight.current) {
      return
    }
    const commandId = createZaloAccountGroupManagementCommandId()
    requestInFlight.current = true
    setInspectionUnavailable(false)
    setAttempt({ commandId, status: "pending" })
    startTransition(async () => {
      try {
        const response = await setZaloNativeConversationSettingAction(
          target.workspaceId,
          target.accountId,
          { ...params(target), commandId, operation },
        )
        await showAttempt(response?.data ?? { commandId, status: "unknown" })
      } catch {
        setAttempt({ commandId, status: "unknown" })
      } finally {
        requestInFlight.current = false
      }
    })
  }

  function inspect() {
    if (!attempt || requestInFlight.current) {
      return
    }
    const commandId = attempt.commandId
    requestInFlight.current = true
    setInspectionUnavailable(false)
    startTransition(async () => {
      try {
        const response = await getZaloNativeConversationSettingAttemptAction(
          target.workspaceId,
          target.accountId,
          { ...params(target), commandId },
        )
        if (response?.data) {
          await showAttempt(response.data)
        } else {
          setInspectionUnavailable(true)
        }
      } catch {
        setInspectionUnavailable(true)
      } finally {
        requestInFlight.current = false
      }
    })
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="w-full sm:max-w-lg rtl:data-ending-style:-translate-x-full rtl:data-starting-style:-translate-x-full"
        finalFocus={finalFocus}
      >
        <SheetHeader className="pe-12">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("scope")}</SheetDescription>
        </SheetHeader>
        {open && (
          <div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-4 text-sm">
            {query.isPending && (
              <p role="status">{common("actions.loading")}</p>
            )}
            {query.isError && (
              <div className="space-y-2">
                <p role="status">{t("unavailable")}</p>
                <Button
                  onClick={() => query.refetch()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {common("actions.retry")}
                </Button>
              </div>
            )}
            {query.data && !query.data.complete && (
              <p role="status">{t("readPartial")}</p>
            )}
            {query.data && !query.data.writeEnabled && <p>{t("readOnly")}</p>}
            {attempt && (
              <div className="space-y-2 rounded-md border p-3">
                <p role="status">
                  {t(outcomeLabels[attempt.result?.outcome ?? attempt.status])}
                </p>
                {unresolved && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <code className="wrap-break-word text-xs">
                      {attempt.commandId}
                    </code>
                    <Button
                      disabled={pending}
                      onClick={inspect}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {t("inspect")}
                    </Button>
                  </div>
                )}
                {inspectionUnavailable && (
                  <p role="status">{t("inspectUnavailable")}</p>
                )}
              </div>
            )}
            {settings && (
              <div className="divide-y rounded-md border px-3">
                {switches.map(({ field, kind, label }) => {
                  const value = settings[field]
                  const text = t(label)
                  return (
                    <div
                      className="flex items-center justify-between gap-3 py-3"
                      key={field}
                    >
                      <span className="font-medium">{text}</span>
                      {value === undefined ? (
                        <span className="text-muted-foreground">
                          {common("condition.unknownValue")}
                        </span>
                      ) : (
                        <Switch
                          aria-label={text}
                          checked={value}
                          disabled={busy}
                          onCheckedChange={(enabled) =>
                            write({ kind, enabled })
                          }
                        />
                      )}
                    </div>
                  )
                })}
                <DurationField
                  applyLabel={t("applyMute")}
                  busy={busy}
                  key={`mute-${settings.muteSeconds}`}
                  label={t("mute")}
                  onSave={(value) => {
                    const option = muteOptions.find(
                      (item) => item.value === value,
                    )
                    if (option) {
                      write({ kind: "setMute", durationSeconds: option.value })
                    }
                  }}
                  options={muteOptions.map((option) => ({
                    ...option,
                    label: t(option.label),
                  }))}
                  otherValue={
                    settings.muteSeconds === undefined
                      ? undefined
                      : t("muteOther", { seconds: settings.muteSeconds })
                  }
                  value={settings.muteSeconds}
                />
                <DurationField
                  applyLabel={t("applyAutoDelete")}
                  busy={busy}
                  key={`retention-${settings.autoDeleteMs}`}
                  label={t("autoDelete")}
                  onSave={(value) => {
                    const option = autoDeleteOptions.find(
                      (item) => item.value === value,
                    )
                    if (option) {
                      write({ kind: "setAutoDelete", ttlMs: option.value })
                    }
                  }}
                  options={autoDeleteOptions.map((option) => ({
                    ...option,
                    label: t(option.label),
                  }))}
                  value={settings.autoDeleteMs}
                />
              </div>
            )}
            <p className="text-muted-foreground text-xs">
              {t("pinUnavailable")}
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
