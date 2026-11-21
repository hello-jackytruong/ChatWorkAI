"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@chatbotx.io/ui/components/ui/table"
import { useMutation } from "@tanstack/react-query"
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
import type {
  ZaloAccountGroupResource,
  ZaloAccountResource,
} from "../schema/resource"
import { ZaloAccountConnect } from "./zalo-account-connect"
import { ZaloAccountGroups } from "./zalo-account-groups"

type ManagedAccount = ZaloAccountResource & {
  connection: ConnectionResource
  groups: ZaloAccountGroupResource[]
}

function ZaloAccountDisconnect({
  connection,
  workspaceId,
}: {
  connection: ConnectionResource
  workspaceId: string
}) {
  const t = useTranslations()
  const router = useRouter()
  const invalidateInboxes = useInvalidateInboxes()
  const [open, setOpen] = useState(false)
  const disconnect = useMutation(
    orpc.connectionsAPI.disconnectConnectionAPI.mutationOptions({
      onSuccess: async () => {
        await invalidateInboxes()
        setOpen(false)
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
              <TableHead>{t("inboxes.markReadOnOutbound.label")}</TableHead>
              <TableHead className="w-56" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((account) => (
              <TableRow key={account.id}>
                <TableCell>{account.name}</TableCell>
                <TableCell>
                  <InboxMarkReadOnOutboundSwitch
                    inboxId={account.inboxId}
                    workspaceId={workspaceId}
                  />
                </TableCell>
                <TableCell className="flex w-56 justify-end gap-2">
                  <ZaloAccountConnect
                    connectionId={account.connection.id}
                    workspaceId={workspaceId}
                  >
                    <Button size="sm" variant="secondary">
                      {t("channels.tokenRefreshErrorDialog.cta")}
                    </Button>
                  </ZaloAccountConnect>
                  <ZaloAccountDisconnect
                    connection={account.connection}
                    workspaceId={workspaceId}
                  />
                </TableCell>
              </TableRow>
            ))}
            {accounts.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>{t("messages.noData")}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {accounts.map((account) => (
        <ZaloAccountGroups
          accountId={account.id}
          accountName={account.name}
          groupMessagingEnabled={account.groupMessagingEnabled}
          groups={account.groups}
          key={account.id}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  )
}
