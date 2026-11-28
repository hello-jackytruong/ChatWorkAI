"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@chatbotx.io/ui/components/ui/table"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { PlusCircleIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { DisconnectIntegrationDialog } from "@/features/common/components/disconnect-integration-dialog"
import type { ConnectionResource } from "@/features/connections/schema/resource"
import { AddChannelButton } from "@/features/inboxes/components/add-channel-button"
import { InboxMarkReadOnOutboundSwitch } from "@/features/inboxes/components/inbox-mark-read-on-outbound-switch"
import { useInvalidateInboxes } from "@/features/inboxes/provider/inbox-hook"
import { orpc } from "@/lib/orpc/query"
import {
  useInvalidateZaloAccountOperations,
  type useZaloAccountOperations,
  zaloAccountOperationsKey,
} from "../queries/use-account-operations"
import {
  useZaloAccountStatus,
  useZaloAccountStatusUpdates,
  zaloAccountStatusKey,
} from "../queries/use-account-status"
import type {
  ZaloAccountGroupResource,
  ZaloAccountResource,
  ZaloAccountStatusResource,
} from "../schema/resource"
import { ZaloAccountConnect } from "./zalo-account-connect"
import { ZaloAccountContacts } from "./zalo-account-contacts"
import { ZaloAccountGroups } from "./zalo-account-groups"
import {
  ZaloAccountRuntimeDetails,
  ZaloAccountStatus,
} from "./zalo-account-status"
import { ZaloHistorySyncControls } from "./zalo-history-sync-controls"

type ManagedAccount = ZaloAccountResource & {
  connection: ConnectionResource
  groups: ZaloAccountGroupResource[]
}

function ZaloAccountDisconnect({
  connection,
  accountId,
  workspaceId,
}: {
  connection: ConnectionResource
  accountId: string
  workspaceId: string
}) {
  const t = useTranslations()
  const router = useRouter()
  const invalidateInboxes = useInvalidateInboxes()
  const invalidateOperations = useInvalidateZaloAccountOperations(
    workspaceId,
    accountId,
  )
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const disconnect = useMutation(
    orpc.connectionsAPI.disconnectConnectionAPI.mutationOptions({
      onSuccess: async (connection) => {
        const queryKey = zaloAccountOperationsKey(workspaceId, accountId)
        const statusKey = zaloAccountStatusKey(workspaceId, accountId)
        await Promise.all([
          queryClient.cancelQueries({ queryKey }),
          queryClient.cancelQueries({ queryKey: statusKey }),
        ])
        const disconnected = (
          status: ZaloAccountStatusResource,
        ): ZaloAccountStatusResource => ({
          ...status,
          status: connection.status,
          reason: connection.statusReason ?? null,
          gatewayAvailable: false,
          runtime: status.runtime
            ? {
                ...status.runtime,
                phase: "stopped",
                socketOpen: false,
                freshness: "unknown",
                requiresAction: false,
              }
            : null,
        })
        queryClient.setQueryData<ZaloAccountStatusResource>(
          statusKey,
          (data) => (data ? disconnected(data) : data),
        )
        queryClient.setQueryData<
          ReturnType<typeof useZaloAccountOperations>["data"]
        >(queryKey, (data) =>
          data
            ? {
                ...data,
                status: disconnected(data.status),
              }
            : data,
        )
        setOpen(false)
        await Promise.all([invalidateInboxes(), invalidateOperations()])
        router.refresh()
      },
      onError: (error) => toast.error(error.message),
    }),
  )
  return (
    <DisconnectIntegrationDialog
      featureLabel={t("fields.zaloAccount.label")}
      isPending={disconnect.isPending}
      onConfirm={() =>
        disconnect.mutateAsync({ workspaceId, id: connection.id })
      }
      onOpenChange={setOpen}
      open={open}
    />
  )
}

export function ZaloAccountManage({
  accounts,
  canCreate,
  workspaceId,
}: {
  accounts: ManagedAccount[]
  canCreate: boolean
  workspaceId: string
}) {
  const t = useTranslations()
  useZaloAccountStatusUpdates(workspaceId)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end gap-2">
        <AddChannelButton
          canCreate={canCreate}
          label={t("fields.zaloAccount.label")}
          render={
            <ZaloAccountConnect workspaceId={workspaceId}>
              <Button size="sm" variant="secondary">
                <PlusCircleIcon className="size-4" />
                {t("actions.addFeature", {
                  feature: t("fields.zaloAccount.label"),
                })}
              </Button>
            </ZaloAccountConnect>
          }
        />
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.name.label")}</TableHead>
              <TableHead>{t("zaloAccount.connectionStatus")}</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <ZaloAccountRow
                account={account}
                key={account.id}
                workspaceId={workspaceId}
              />
            ))}
            {accounts.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>{t("messages.noData")}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function ZaloAccountRow({
  account,
  workspaceId,
}: {
  account: ManagedAccount
  workspaceId: string
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)
  const query = useZaloAccountStatus(workspaceId, account.id)
  const status = query.data
  const connectionStatus = status?.status ?? account.connection.status
  return (
    <TableRow>
      <TableCell>{account.name}</TableCell>
      <TableCell>
        <ZaloAccountStatus
          gatewayAvailable={status?.gatewayAvailable}
          socketOpen={status?.runtime?.socketOpen}
          status={connectionStatus}
          unavailable={
            query.isError || (!status && connectionStatus === "connected")
          }
        />
      </TableCell>
      <TableCell className="text-end">
        <Dialog onOpenChange={setOpen} open={open}>
          <DialogTrigger
            render={
              <Button size="sm" variant="secondary">
                {t("zaloAccount.configure")}
              </Button>
            }
          />
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-6xl">
            <DialogHeader>
              <DialogTitle>{account.name}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <ZaloAccountStatus
                gatewayAvailable={status?.gatewayAvailable}
                socketOpen={status?.runtime?.socketOpen}
                status={connectionStatus}
                unavailable={
                  query.isError || (!status && connectionStatus === "connected")
                }
              />
              <div className="flex gap-2">
                <ZaloAccountConnect
                  connectionId={account.connection.id}
                  workspaceId={workspaceId}
                >
                  <Button size="sm" variant="secondary">
                    {t("channels.tokenRefreshErrorDialog.cta")}
                  </Button>
                </ZaloAccountConnect>
                {connectionStatus !== "disconnected" && (
                  <ZaloAccountDisconnect
                    accountId={account.id}
                    connection={account.connection}
                    workspaceId={workspaceId}
                  />
                )}
              </div>
            </div>
            <ZaloAccountRuntimeDetails status={status} />
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span>{t("inboxes.markReadOnOutbound.label")}</span>
              <InboxMarkReadOnOutboundSwitch
                inboxId={account.inboxId}
                workspaceId={workspaceId}
              />
            </div>
            {open && (
              <>
                <ZaloHistorySyncControls
                  accountId={account.id}
                  workspaceId={workspaceId}
                />
                <ZaloAccountContacts
                  accountId={account.id}
                  workspaceId={workspaceId}
                />
                <ZaloAccountGroups
                  accountId={account.id}
                  accountName={account.name}
                  groupMessagingEnabled={account.groupMessagingEnabled}
                  groups={account.groups}
                  workspaceId={workspaceId}
                />
              </>
            )}
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  )
}
