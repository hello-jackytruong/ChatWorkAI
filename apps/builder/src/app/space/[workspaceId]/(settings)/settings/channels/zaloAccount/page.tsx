import { connectionStateService } from "@chatbotx.io/business"
import {
  zaloAccountGroupService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"
import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { toConnectionResource } from "@/features/connections/lib/resolve-provider"
import { ZaloAccountManage } from "@/features/zalo-accounts/components/zalo-account-manage"
import {
  toZaloAccountResources,
  withZaloGroupResources,
} from "@/features/zalo-accounts/lib/to-resource"
import { requireVisibleChannel } from "@/lib/workspace/require-visible-channel"
import { resolveChannelCreatable } from "@/lib/workspace/resolve-channel-creatable"

export default async function SettingChannelZaloAccountPage(props: {
  params: Promise<{ workspaceId: string }>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireVisibleChannel(workspaceId, "zaloAccount")
  const accountRows = await zaloAccountService.listByWorkspace({ workspaceId })
  const connectionRows = await connectionStateService.list({
    workspaceId,
    provider: "zaloAccount",
    page: 1,
    perPage: 100,
  })
  const connectionByInbox = new Map(
    connectionRows.data.flatMap((connection) =>
      connection.inboxId ? [[connection.inboxId, connection] as const] : [],
    ),
  )
  const projectedAccounts = await toZaloAccountResources(accountRows)
  const accounts: Parameters<typeof ZaloAccountManage>[0]["accounts"] = []
  for (const account of accountRows) {
    const connection = connectionByInbox.get(account.inboxId)
    if (!connection) {
      continue
    }
    const groups = await zaloAccountGroupService.list({
      workspaceId,
      accountId: account.id,
    })
    accounts.push({
      ...(projectedAccounts[
        accountRows.indexOf(account)
      ] as (typeof projectedAccounts)[number]),
      connection: toConnectionResource(connection),
      groups: await withZaloGroupResources(workspaceId, groups),
    })
  }
  const canCreate = await resolveChannelCreatable(workspaceId, "zaloAccount")
  return (
    <ZaloAccountManage
      accounts={accounts}
      canCreate={canCreate}
      workspaceId={workspaceId}
    />
  )
}
