"use client"

import {
  createZaloAccountGroupManagementCommandId,
  nativeAccountToolRequiresConfirmation,
  type ZaloAccountNativeToolResult,
} from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@chatbotx.io/ui/components/ui/tabs"
import { useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useId, useRef, useState, useTransition } from "react"
import {
  getZaloNativeAccountToolAttemptAction,
  mutateZaloNativeAccountToolAction,
} from "../actions/native-account-tools.action"
import {
  type NativeAccountRead,
  type NativeAccountTarget,
  type NativeAccountWrite,
  type NativeAccountWriteControls,
  nativeAccountToolKey,
  useNativeAccountTool,
} from "../lib/native-account-tools-ui"
import { NativeAccountAvatarAlbum } from "./zalo-account-native-avatar-album"
import { NativeAccountProfileDetails } from "./zalo-account-native-profile-details"
import { NativeAccountSettings } from "./zalo-account-native-settings"

type AttemptStatus =
  | "pending"
  | "dispatched"
  | ZaloAccountNativeToolResult["outcome"]
type Attempt = {
  commandId: string
  operation: NativeAccountWrite["kind"]
  status: AttemptStatus
  result?: ZaloAccountNativeToolResult
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

const refreshAfterWrite = {
  updateOwnProfile: ["readOwnProfile"],
  updateOwnBio: ["readOwnProfile"],
  changeOwnAvatar: ["readOwnProfile", "listOwnAvatars"],
  deleteOwnAvatar: ["readOwnProfile", "listOwnAvatars"],
  reuseOwnAvatar: ["readOwnProfile", "listOwnAvatars"],
  updateOwnSetting: ["readOwnSettings"],
} as const satisfies Record<
  NativeAccountWrite["kind"],
  readonly NativeAccountRead["kind"][]
>

function NativeProfilePanel(target: NativeAccountTarget) {
  const t = useTranslations("zaloAccount.nativeProfile")
  const outcome = useTranslations("zaloAccount.nativeConversationSettings")
  const actions = useTranslations("actions")
  const client = useQueryClient()
  const query = useNativeAccountTool(target, { kind: "readOwnProfile" })
  const [attempt, setAttempt] = useState<Attempt>()
  const [inspectionUnavailable, setInspectionUnavailable] = useState(false)
  const [pending, startTransition] = useTransition()
  const inFlight = useRef(false)
  const canWrite = query.data?.writeEnabled === true
  const unresolved =
    attempt?.status === "pending" ||
    attempt?.status === "dispatched" ||
    attempt?.status === "unknown"
  const busy = pending || unresolved || query.isFetching || query.isError

  async function showAttempt(
    response: Omit<Attempt, "operation">,
    operation: Attempt["operation"],
  ) {
    setAttempt({ ...response, operation })
    if (response.status === "confirmed" || response.status === "partial") {
      await Promise.all(
        refreshAfterWrite[operation].map((name) =>
          client.invalidateQueries({
            queryKey: nativeAccountToolKey(target, name),
            exact: true,
          }),
        ),
      )
    }
  }

  const controls: NativeAccountWriteControls = {
    canWrite,
    busy,
    submit(operation, confirmed) {
      if (
        !canWrite ||
        busy ||
        inFlight.current ||
        (nativeAccountToolRequiresConfirmation(operation) && !confirmed)
      ) {
        return
      }
      const commandId = createZaloAccountGroupManagementCommandId()
      inFlight.current = true
      setInspectionUnavailable(false)
      setAttempt({ commandId, operation: operation.kind, status: "pending" })
      startTransition(async () => {
        try {
          const response = await mutateZaloNativeAccountToolAction(
            target.workspaceId,
            target.accountId,
            { operation, commandId, ...(confirmed ? { confirmed } : {}) },
          )
          await showAttempt(
            response?.data ?? { commandId, status: "unknown" },
            operation.kind,
          )
        } catch {
          setAttempt({
            commandId,
            operation: operation.kind,
            status: "unknown",
          })
        } finally {
          inFlight.current = false
        }
      })
    },
  }

  function inspect() {
    if (!attempt || inFlight.current) {
      return
    }
    inFlight.current = true
    setInspectionUnavailable(false)
    startTransition(async () => {
      try {
        const response = await getZaloNativeAccountToolAttemptAction(
          target.workspaceId,
          target.accountId,
          {
            family: "accountProfile",
            commandId: attempt.commandId,
          },
        )
        if (response?.data) {
          await showAttempt(response.data, attempt.operation)
        } else {
          setInspectionUnavailable(true)
        }
      } catch {
        setInspectionUnavailable(true)
      } finally {
        inFlight.current = false
      }
    })
  }

  return (
    <div className="space-y-3 text-sm">
      {query.data && !canWrite && <p role="status">{t("readOnly")}</p>}
      {attempt && (
        <div className="space-y-2 rounded-md border p-3">
          <p role="status">
            {outcome(outcomeLabels[attempt.result?.outcome ?? attempt.status])}
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
                {outcome("inspect")}
              </Button>
            </div>
          )}
          {inspectionUnavailable && (
            <p role="status">{outcome("inspectUnavailable")}</p>
          )}
        </div>
      )}
      <Tabs defaultValue="profile">
        <TabsList
          aria-label={t("title")}
          className="max-w-full overflow-x-auto px-3"
        >
          <TabsTrigger className="py-2" value="profile">
            {t("profileTab")}
          </TabsTrigger>
          <TabsTrigger className="py-2" value="avatars">
            {t("avatarHistory")}
          </TabsTrigger>
          <TabsTrigger className="py-2" value="settings">
            {t("settingsTab")}
          </TabsTrigger>
        </TabsList>
        <TabsContent className="pt-2" value="profile">
          {query.isPending && <p role="status">{actions("loading")}</p>}
          {!(query.isPending || query.data?.ownProfile) && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status">{t("profileUnavailable")}</p>
              <Button
                onClick={() => query.refetch()}
                size="sm"
                type="button"
                variant="secondary"
              >
                {actions("retry")}
              </Button>
            </div>
          )}
          {query.data?.ownProfile && (
            <NativeAccountProfileDetails
              controls={controls}
              profile={query.data.ownProfile}
              target={target}
            />
          )}
        </TabsContent>
        <TabsContent className="pt-2" value="avatars">
          <NativeAccountAvatarAlbum controls={controls} target={target} />
        </TabsContent>
        <TabsContent className="pt-2" value="settings">
          <NativeAccountSettings controls={controls} target={target} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export function ZaloAccountNativeProfile(target: NativeAccountTarget) {
  const t = useTranslations("zaloAccount.nativeProfile")
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <section className="space-y-2 rounded-md border p-3">
      <Button
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        size="sm"
        type="button"
        variant="secondary"
      >
        {t("title")}
      </Button>
      <div hidden={!open} id={id}>
        {open && (
          <NativeProfilePanel
            {...target}
            key={`${target.workspaceId}:${target.accountId}`}
          />
        )}
      </div>
    </section>
  )
}
