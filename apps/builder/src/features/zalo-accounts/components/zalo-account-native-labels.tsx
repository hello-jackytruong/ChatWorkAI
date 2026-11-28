"use client"

import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { useFormatter, useTranslations } from "next-intl"
import { useId, useRef, useState, useTransition } from "react"
import { useForm } from "react-hook-form"
import type { z } from "zod"
import {
  queueZaloNativeLabelSyncAction,
  updateZaloNativeLabelAction,
} from "../actions/native-labels.action"
import { useInvalidateZaloAccountOperations } from "../queries/use-account-operations"
import { useZaloNativeLabels } from "../queries/use-native-labels"
import {
  nativeLabelEdit,
  type nativeLabelEditResult,
  type nativeLabelResource,
} from "../schema/native-labels"

type Label = z.infer<typeof nativeLabelResource>
type Outcome = z.infer<typeof nativeLabelEditResult>["outcome"]
type Edit = z.infer<typeof nativeLabelEdit>["patch"]
type Account = { workspaceId: string; accountId: string }
type SyncState = "queued" | "running" | "idle"
const colorPattern = /^#[a-f0-9]{6}$/i
const outcomeLabels = {
  confirmed: "zaloAccount.nativeLabels.saved",
  conflict: "zaloAccount.labelConflict",
  unknown: "zaloAccount.labelUnknown",
  unavailable: "zaloAccount.nativeLabels.writeUnavailable",
} as const satisfies Record<Outcome, string>

function normalizedColor(value?: string) {
  return value && colorPattern.test(value) ? value.toLowerCase() : ""
}

function EditLabel({
  busy,
  label,
  onCancel,
  onSave,
}: {
  busy: boolean
  label: Label
  onCancel: () => void
  onSave: (patch: Edit) => void
}) {
  const t = useTranslations()
  const form = useForm({
    defaultValues: {
      text: label.text,
      color: normalizedColor(label.color),
      emoji: label.emoji,
    },
  })
  const [invalid, setInvalid] = useState(false)
  const titleId = useId()
  return (
    <Form {...form}>
      <form
        aria-labelledby={titleId}
        className="space-y-2 pt-2"
        onSubmit={form.handleSubmit((fields) => {
          const text = fields.text.trim()
          const color = fields.color.trim().toLowerCase()
          const patch = {
            ...(text === label.text ? {} : { text }),
            ...(color === normalizedColor(label.color) ? {} : { color }),
            ...(fields.emoji === label.emoji ? {} : { emoji: fields.emoji }),
          }
          if (!Object.keys(patch).length) {
            setInvalid(false)
            onCancel()
            return
          }
          const parsed = nativeLabelEdit.shape.patch.safeParse(patch)
          setInvalid(!parsed.success)
          if (parsed.success) {
            onSave(parsed.data)
          }
        })}
      >
        <span className="sr-only" id={titleId}>
          {t("zaloAccount.nativeLabels.edit", { name: label.text })}
        </span>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <InputField
            aria-label={t("zaloAccount.nativeLabels.name")}
            disabled={busy}
            label={t("zaloAccount.nativeLabels.name")}
            maxLength={200}
            name="text"
            required
          />
          <InputField
            aria-label={t("zaloAccount.nativeLabels.color")}
            disabled={busy}
            label={t("zaloAccount.nativeLabels.color")}
            maxLength={7}
            name="color"
          />
          <InputField
            aria-label={t("zaloAccount.nativeLabels.emoji")}
            disabled={busy}
            label={t("zaloAccount.nativeLabels.emoji")}
            maxLength={50}
            name="emoji"
          />
        </div>
        {invalid && (
          <p className="text-destructive" role="alert">
            {t("zaloAccount.nativeLabels.invalid")}
          </p>
        )}
        <div className="flex gap-2">
          <Button disabled={busy} size="sm" type="submit">
            {t("actions.save")}
          </Button>
          <Button
            disabled={busy}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("actions.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  )
}

function NativeLabelPanel({ accountId, workspaceId }: Account) {
  const t = useTranslations()
  const format = useFormatter()
  const query = useZaloNativeLabels(workspaceId, accountId)
  const invalidateOperations = useInvalidateZaloAccountOperations(
    workspaceId,
    accountId,
  )
  const [editingId, setEditingId] = useState<number>()
  const [outcome, setOutcome] = useState<Outcome>()
  const [syncFailed, setSyncFailed] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>()
  const [lastSuccessBeforeReconcile, setLastSuccessBeforeReconcile] =
    useState<string>()
  const [busy, startTransition] = useTransition()
  const inFlight = useRef(false)
  const doc = query.data
  const waitingForSync = (syncState ?? doc?.syncState ?? "idle") !== "idle"
  const isUnknown = outcome === "unknown" || doc?.reason === "outcomeUnknown"
  const isConflict = outcome === "conflict" || doc?.reason === "versionConflict"
  const mappingConflict = doc?.reason === "mappingConflict"
  const reconciling =
    isUnknown || isConflict || doc?.reason === "mutationPending"
  const editEnabled =
    doc?.available &&
    doc.editEnabled &&
    doc.complete &&
    !reconciling &&
    !waitingForSync
  const labels = [...(doc?.labels ?? [])].sort((a, b) => a.offset - b.offset)

  function save(labelId: number, patch: Edit) {
    if (!editEnabled || inFlight.current) {
      return
    }
    inFlight.current = true
    const commandId = crypto.randomUUID()
    setOutcome(undefined)
    startTransition(async () => {
      try {
        const response = await updateZaloNativeLabelAction(
          workspaceId,
          accountId,
          { labelId, commandId, patch },
        )
        const result = response?.data?.outcome ?? "unknown"
        setOutcome(result)
        setEditingId(undefined)
        if (result === "confirmed") {
          await query.refetch()
          await invalidateOperations()
        }
      } catch {
        setOutcome("unknown")
        setEditingId(undefined)
      } finally {
        inFlight.current = false
      }
    })
  }

  function sync() {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setSyncFailed(false)
    startTransition(async () => {
      try {
        let before = lastSuccessBeforeReconcile
        if (!waitingForSync) {
          before = doc?.lastSuccessAt
          setLastSuccessBeforeReconcile(before)
          const response = await queueZaloNativeLabelSyncAction(
            workspaceId,
            accountId,
          )
          if (!response?.data) {
            setSyncFailed(true)
            return
          }
          setSyncState(response.data.state)
          if (response.data.state !== "idle") {
            return
          }
        }
        const readback = await query.refetch()
        if (!readback.isSuccess) {
          setSyncFailed(true)
          return
        }
        const next = readback.data
        setSyncState(next.syncState ?? "idle")
        if (
          (next.syncState ?? "idle") === "idle" &&
          next.available &&
          next.complete &&
          !next.reason &&
          next.lastSuccessAt &&
          next.lastSuccessAt !== before
        ) {
          setOutcome(undefined)
        }
        await invalidateOperations()
      } catch {
        setSyncFailed(true)
      } finally {
        inFlight.current = false
      }
    })
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1 text-muted-foreground">
          {query.isPending && <p role="status">{t("actions.loading")}</p>}
          {query.isError && (
            <p role="status">{t("zaloAccount.nativeLabels.unavailable")}</p>
          )}
          {doc && (
            <p role="status">
              {doc.available
                ? t(
                    doc.complete
                      ? "zaloAccount.complete"
                      : "zaloAccount.nativeLabels.partial",
                  )
                : t("zaloAccount.nativeLabels.unavailable")}
            </p>
          )}
          {doc?.lastSuccessAt && (
            <p>
              {t("zaloAccount.nativeLabels.lastSuccess")}{" "}
              <time dateTime={doc.lastSuccessAt}>
                {format.dateTime(new Date(doc.lastSuccessAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </p>
          )}
        </div>
        <Button
          disabled={busy || query.isFetching}
          onClick={sync}
          size="sm"
          type="button"
          variant="secondary"
        >
          {waitingForSync
            ? t("zaloAccount.nativeLabels.refresh")
            : t(
                reconciling
                  ? "zaloAccount.nativeLabels.reconcile"
                  : "zaloAccount.nativeLabels.sync",
              )}
        </Button>
      </div>
      {waitingForSync && (
        <p role="status">
          {t(
            (syncState ?? doc?.syncState) === "running"
              ? "zaloAccount.nativeLabels.running"
              : "zaloAccount.nativeLabels.queued",
          )}
        </p>
      )}
      {outcome && <p role="status">{t(outcomeLabels[outcome])}</p>}
      {!outcome && isUnknown && (
        <p role="status">{t("zaloAccount.labelUnknown")}</p>
      )}
      {!outcome && isConflict && (
        <p role="status">{t("zaloAccount.labelConflict")}</p>
      )}
      {mappingConflict && (
        <p role="status">{t("zaloAccount.nativeLabels.mappingConflict")}</p>
      )}
      {doc?.reason === "mutationPending" && (
        <p role="status">{t("zaloAccount.nativeLabels.pending")}</p>
      )}
      {syncFailed && (
        <p role="status">{t("zaloAccount.nativeLabels.syncFailed")}</p>
      )}
      {doc?.available && doc.complete && labels.length === 0 && (
        <p>{t("zaloAccount.nativeLabels.empty")}</p>
      )}
      {doc && !doc.editEnabled && !reconciling && (
        <p>{t("zaloAccount.nativeLabels.readOnly")}</p>
      )}
      {labels.length > 0 && (
        <ol className="divide-y rounded-md border px-3">
          {labels.map((label) => {
            const color = normalizedColor(label.color)
            return (
              <li className="space-y-1 py-2" key={label.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      <span
                        aria-hidden="true"
                        className="size-3 shrink-0 rounded-full border bg-muted"
                        style={color ? { backgroundColor: color } : undefined}
                      />
                      <span className="wrap-break-word">
                        {label.emoji && `${label.emoji} `}
                        {label.text}
                      </span>
                    </div>
                    <p className="wrap-break-word text-muted-foreground text-xs">
                      {label.tagName
                        ? t("zaloAccount.nativeLabels.mapping", {
                            name: label.tagName,
                          })
                        : t("zaloAccount.nativeLabels.unmapped")}
                    </p>
                  </div>
                  {editEnabled && editingId !== label.id && (
                    <Button
                      aria-label={t("zaloAccount.nativeLabels.edit", {
                        name: label.text,
                      })}
                      disabled={busy}
                      onClick={() => setEditingId(label.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("actions.edit")}
                    </Button>
                  )}
                </div>
                {editEnabled && editingId === label.id && (
                  <EditLabel
                    busy={busy}
                    label={label}
                    onCancel={() => setEditingId(undefined)}
                    onSave={(patch) => save(label.id, patch)}
                  />
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

export function ZaloAccountNativeLabels(account: Account) {
  const t = useTranslations("zaloAccount.nativeLabels")
  const [open, setOpen] = useState(false)
  const panelId = useId()

  return (
    <section className="space-y-2 rounded-md border p-3">
      <Button
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        size="sm"
        type="button"
        variant="secondary"
      >
        {t("title")}
      </Button>
      <div hidden={!open} id={panelId}>
        {open && (
          <NativeLabelPanel
            {...account}
            key={`${account.workspaceId}:${account.accountId}`}
          />
        )}
      </div>
    </section>
  )
}
