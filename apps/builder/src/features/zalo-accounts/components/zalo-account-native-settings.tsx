"use client"

import { zaloAccountOwnSettingEditSchema } from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useTranslations } from "next-intl"
import { useId, useState } from "react"
import type { z } from "zod"
import {
  type NativeAccountResult,
  type NativeAccountTarget,
  type NativeAccountWriteControls,
  useNativeAccountTool,
} from "../lib/native-account-tools-ui"

type ReadKey = keyof NonNullable<NativeAccountResult["ownSettings"]>
type WriteKey = z.infer<typeof zaloAccountOwnSettingEditSchema>["key"]
const toggleValues = [0, 1] as const
const settings = [
  {
    key: "view_birthday",
    writeKey: "view_birthday",
    label: "birthdayVisibility",
    values: [0, 1, 2],
  },
  {
    key: "show_online_status",
    writeKey: "show_online_status",
    label: "onlineVisibility",
    values: toggleValues,
  },
  {
    key: "display_seen_status",
    writeKey: "display_seen_status",
    label: "seenVisibility",
    values: toggleValues,
  },
  {
    key: "receive_message",
    writeKey: "receive_message",
    label: "messages",
    values: [1, 2],
  },
  {
    key: "accept_stranger_call",
    writeKey: "accept_stranger_call",
    label: "calls",
    values: [2, 3, 4],
  },
  {
    key: "add_friend_via_phone",
    writeKey: "add_friend_via_phone",
    label: "phoneLookup",
    values: toggleValues,
  },
  {
    key: "add_friend_via_qr",
    writeKey: "add_friend_via_qr",
    label: "qrLookup",
    values: toggleValues,
  },
  {
    key: "add_friend_via_group",
    writeKey: "add_friend_via_group",
    label: "groupLookup",
    values: toggleValues,
  },
  {
    key: "add_friend_via_contact",
    writeKey: "add_friend_via_contact",
    label: "contactLookup",
    values: toggleValues,
  },
  {
    key: "display_on_recommend_friend",
    writeKey: "display_on_recommend_friend",
    label: "recommendations",
    values: toggleValues,
  },
  {
    key: "archived_chat_status",
    writeKey: "archivedChatStatus",
    label: "archiveStatus",
    values: toggleValues,
  },
  {
    key: "quick_message_status",
    writeKey: "quickMessageStatus",
    label: "quickMessageStatus",
    values: toggleValues,
  },
] as const satisfies readonly {
  key: ReadKey
  writeKey: WriteKey
  label: string
  values: readonly number[]
}[]

function AccountSettingRow({
  row,
  value,
  controls,
}: {
  row: (typeof settings)[number]
  value?: number
  controls: NativeAccountWriteControls
}) {
  const t = useTranslations()
  const labels = useTranslations("zaloAccount.nativeProfile.settings")
  const id = useId()
  const [draft, setDraft] = useState<number>()
  const label = labels(row.label)
  const getValueLabel = (selected: number) =>
    row.values === toggleValues
      ? t(selected === 1 ? "condition.yes" : "condition.no")
      : t("zaloAccount.nativeProfile.providerValue", { value: selected })

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2">
      <label
        className="font-medium"
        htmlFor={value !== undefined && controls.canWrite ? id : undefined}
      >
        {label}
      </label>
      {value === undefined && (
        <span className="text-muted-foreground">
          {t("condition.unknownValue")}
        </span>
      )}
      {value !== undefined && !controls.canWrite && (
        <span className="text-muted-foreground">{getValueLabel(value)}</span>
      )}
      {value !== undefined && controls.canWrite && (
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-background px-2"
            disabled={controls.busy}
            id={id}
            onChange={(event) => setDraft(Number(event.target.value))}
            value={draft ?? value}
          >
            {row.values.map((option) => (
              <option key={option} value={option}>
                {getValueLabel(option)}
              </option>
            ))}
          </select>
          <Button
            aria-label={t("zaloAccount.nativeProfile.applySetting", { label })}
            disabled={controls.busy || draft === undefined || draft === value}
            onClick={() => {
              const selected = zaloAccountOwnSettingEditSchema.safeParse({
                key: row.writeKey,
                value: draft,
              })
              if (selected.success) {
                controls.submit({
                  kind: "updateOwnSetting",
                  setting: selected.data,
                })
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

export function NativeAccountSettings({
  controls,
  target,
}: {
  controls: NativeAccountWriteControls
  target: NativeAccountTarget
}) {
  const t = useTranslations()
  const query = useNativeAccountTool(target, { kind: "readOwnSettings" })
  const data = query.data?.ownSettings
  return (
    <div className="space-y-3">
      {query.isPending && <p role="status">{t("actions.loading")}</p>}
      {!(query.isPending || data) && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">
            {t("zaloAccount.nativeProfile.settingsUnavailable")}
          </p>
          <Button
            onClick={() => query.refetch()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("actions.retry")}
          </Button>
        </div>
      )}
      {data && (
        <div className="divide-y rounded-md border px-3">
          {settings.map((row) => {
            const value = data[row.key]
            return (
              <AccountSettingRow
                controls={{
                  ...controls,
                  busy: controls.busy || query.isFetching || query.isError,
                  canWrite:
                    controls.canWrite && query.data?.writeEnabled !== false,
                }}
                key={`${row.key}:${value}`}
                row={row}
                value={value}
              />
            )
          })}
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        {t("zaloAccount.nativeProfile.languageAndActiveUnavailable")}
      </p>
    </div>
  )
}
