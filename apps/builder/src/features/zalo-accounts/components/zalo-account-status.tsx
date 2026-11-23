"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { useLocale, useTranslations } from "next-intl"
import { Fragment } from "react"
import type { ZaloAccountStatusResource } from "../schema/resource"

export function ZaloAccountStatus({
  status,
  gatewayAvailable,
  socketOpen,
  unavailable = false,
}: {
  status?: string
  gatewayAvailable?: boolean
  socketOpen?: boolean | null
  unavailable?: boolean
}) {
  const t = useTranslations()
  let label = t("zaloAccount.statusUnavailable")
  let variant: "secondary" | "destructive" | "outline" = "outline"
  if (!unavailable) {
    if (status === "disconnected") {
      label = t("zaloAccount.disconnected")
    } else if (status === "needs_reauth") {
      label = t("zaloAccount.reconnectRequired")
      variant = "destructive"
    } else if (status === "paused") {
      label = t("zaloAccount.paused")
    } else if (
      status === "connected" &&
      gatewayAvailable &&
      socketOpen === true
    ) {
      label = t("zaloAccount.active")
      variant = "secondary"
    } else if (
      status === "connected" &&
      gatewayAvailable &&
      socketOpen == null
    ) {
      label = t("zaloAccount.socketUnknown")
    } else if (status === "degraded" || status === "connected") {
      label = t("zaloAccount.degraded")
      variant = "destructive"
    }
  }
  return (
    <Badge aria-live="polite" variant={variant}>
      {label}
    </Badge>
  )
}

const phaseKeys = {
  connecting: "zaloAccount.runtimePhases.connecting",
  connected: "zaloAccount.runtimePhases.connected",
  backoff: "zaloAccount.runtimePhases.backoff",
  held: "zaloAccount.runtimePhases.held",
  stopped: "zaloAccount.runtimePhases.stopped",
  reauth_required: "zaloAccount.runtimePhases.reauth_required",
} as const
const errorKeys = {
  network: "zaloAccount.runtimeErrors.network",
  timeout: "zaloAccount.runtimeErrors.timeout",
  unknown: "zaloAccount.runtimeErrors.unknown",
  duplicate_connection: "zaloAccount.runtimeErrors.duplicate_connection",
  kicked: "zaloAccount.runtimeErrors.kicked",
  authorization_rejected: "zaloAccount.runtimeErrors.authorization_rejected",
  identity_mismatch: "zaloAccount.runtimeErrors.identity_mismatch",
  qr_expired: "zaloAccount.runtimeErrors.qr_expired",
  qr_declined: "zaloAccount.runtimeErrors.qr_declined",
  lease_lost: "zaloAccount.runtimeErrors.lease_lost",
} as const
const dates = [
  ["connectedAt", "zaloAccount.runtimeLabels.connectedAt"],
  ["disconnectedAt", "zaloAccount.runtimeLabels.disconnectedAt"],
  ["lastLifecycleAt", "zaloAccount.runtimeLabels.lastLifecycleAt"],
  ["lastEventAt", "zaloAccount.runtimeLabels.lastEventAt"],
  ["sampledAt", "zaloAccount.runtimeLabels.sampledAt"],
  ["nextAttemptAt", "zaloAccount.runtimeLabels.nextAttemptAt"],
] as const

export function ZaloAccountRuntimeDetails({
  status,
}: {
  status?: ZaloAccountStatusResource
}) {
  const t = useTranslations()
  const locale = useLocale()
  const runtime = status?.runtime
  const unknown = t("zaloAccount.runtimeLabels.unknown")
  let connection = unknown
  if (status?.status === "connected") {
    connection = t("zaloAccount.connected")
  } else if (status?.status === "degraded") {
    connection = t("zaloAccount.degraded")
  } else if (status?.status === "paused") {
    connection = t("zaloAccount.paused")
  } else if (status?.status === "needs_reauth") {
    connection = t("zaloAccount.reconnectRequired")
  } else if (status?.status === "disconnected") {
    connection = t("zaloAccount.disconnected")
  }
  let socket = unknown
  if (runtime?.socketOpen === true) {
    socket = t("zaloAccount.connected")
  } else if (runtime?.socketOpen === false) {
    socket = t("zaloAccount.runtimeLabels.notOpen")
  }
  let freshness = unknown
  if (runtime?.freshness === "fresh") {
    freshness = t("zaloAccount.runtimeLabels.fresh")
  } else if (runtime?.freshness === "stale") {
    freshness = t("zaloAccount.runtimeLabels.stale")
  }
  return (
    <div className="space-y-2 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">
          {t("zaloAccount.connectionStatus")}
        </dt>
        <dd>{connection}</dd>
        <dt className="text-muted-foreground">
          {t("zaloAccount.runtimeLabels.gateway")}
        </dt>
        <dd>
          {status?.gatewayAvailable
            ? t("zaloAccount.connected")
            : t("zaloAccount.statusUnavailable")}
        </dd>
        <dt className="text-muted-foreground">
          {t("zaloAccount.runtimeLabels.socket")}
        </dt>
        <dd>{socket}</dd>
        {runtime && (
          <>
            <dt className="text-muted-foreground">
              {t("zaloAccount.runtimeLabels.phase")}
            </dt>
            <dd>{t(phaseKeys[runtime.phase])}</dd>
            <dt className="text-muted-foreground">
              {t("zaloAccount.runtimeLabels.freshness")}
            </dt>
            <dd>{freshness}</dd>
            {dates.map(([field, key]) => (
              <Fragment key={field}>
                <dt className="text-muted-foreground">{t(key)}</dt>
                <dd>
                  {runtime[field] ? (
                    <time dateTime={runtime[field]}>
                      {new Date(runtime[field]).toLocaleString(locale)}
                    </time>
                  ) : (
                    unknown
                  )}
                </dd>
              </Fragment>
            ))}
            <dt className="text-muted-foreground">
              {t("zaloAccount.runtimeLabels.retryCount")}
            </dt>
            <dd>{runtime.reconnectCount}</dd>
            <dt className="text-muted-foreground">
              {t("zaloAccount.runtimeLabels.closeCode")}
            </dt>
            <dd>{runtime.closeCode ?? unknown}</dd>
            <dt className="text-muted-foreground">
              {t("zaloAccount.runtimeLabels.issue")}
            </dt>
            <dd>
              {runtime.errorCategory
                ? t(errorKeys[runtime.errorCategory])
                : unknown}
            </dd>
          </>
        )}
      </dl>
      {!runtime && (
        <p className="text-muted-foreground">
          {t("zaloAccount.runtimeLabels.noData")}
        </p>
      )}
      {runtime?.requiresAction && (
        <p role="alert">{t("zaloAccount.runtimeLabels.requiresAction")}</p>
      )}
    </div>
  )
}
