"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@chatbotx.io/ui/components/ui/table"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { sendZaloAccountGroupMessageAction } from "../actions/send-group-message.action"
import { syncZaloAccountGroupsAction } from "../actions/sync-groups.action"
import { syncZaloAccountLabelsAction } from "../actions/sync-labels.action"
import { updateZaloAccountGroupPolicyAction } from "../actions/update-group-policy.action"
import type { ZaloAccountGroupResource } from "../schema/resource"

const showActionError = (error: { serverError?: string }) => {
  if (error.serverError) {
    toast.error(error.serverError)
  }
}

function GroupRow({
  accountId,
  group,
  workspaceId,
}: {
  accountId: string
  group: ZaloAccountGroupResource
  workspaceId: string
}) {
  const t = useTranslations()
  const router = useRouter()
  const [text, setText] = useState("")
  const policy = useAction(
    updateZaloAccountGroupPolicyAction.bind(null, workspaceId, accountId),
    {
      onSuccess: () => router.refresh(),
      onError: ({ error }) => showActionError(error),
    },
  )
  const send = useAction(
    sendZaloAccountGroupMessageAction.bind(null, workspaceId, accountId),
    {
      onSuccess: () => setText(""),
      onError: ({ error }) => showActionError(error),
    },
  )

  return (
    <TableRow>
      <TableCell>
        <div>{group.name}</div>
        <div className="text-muted-foreground text-xs">{group.memberCount}</div>
      </TableCell>
      <TableCell>
        <Switch
          aria-label={t("actions.toggle")}
          checked={group.accessible && group.sendEnabled}
          disabled={!group.accessible || policy.isPending}
          onCheckedChange={(sendEnabled) =>
            policy.execute({ groupId: group.id, sendEnabled })
          }
        />
      </TableCell>
      <TableCell>
        <div className="flex min-w-72 gap-2">
          <Input
            aria-label={t("fields.message.label")}
            disabled={
              !(group.accessible && group.sendEnabled) || send.isPending
            }
            onChange={(event) => setText(event.target.value)}
            value={text}
          />
          <Button
            disabled={
              !(group.accessible && group.sendEnabled) ||
              send.isPending ||
              text.trim().length === 0
            }
            onClick={() => send.execute({ groupId: group.id, text })}
            size="sm"
            type="button"
          >
            {t("actions.send")}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

export function ZaloAccountGroups({
  accountId,
  accountName,
  groups,
  workspaceId,
}: {
  accountId: string
  accountName: string
  groups: ZaloAccountGroupResource[]
  workspaceId: string
}) {
  const t = useTranslations()
  const router = useRouter()
  const sync = useAction(
    syncZaloAccountGroupsAction.bind(null, workspaceId, accountId),
    {
      onSuccess: () => router.refresh(),
      onError: ({ error }) => showActionError(error),
    },
  )
  const syncLabels = useAction(
    syncZaloAccountLabelsAction.bind(null, workspaceId, accountId),
    {
      onSuccess: () => router.refresh(),
      onError: ({ error }) => showActionError(error),
    },
  )

  return (
    <section className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{accountName}</h3>
        <div className="flex gap-2">
          <Button
            disabled={syncLabels.isPending}
            onClick={() => syncLabels.execute()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("actions.synchronize")} · {t("fields.tags.label")}
          </Button>
          <Button
            disabled={sync.isPending}
            onClick={() => sync.execute()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("actions.synchronize")}
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.name.label")}</TableHead>
              <TableHead>{t("fields.status.label")}</TableHead>
              <TableHead>{t("fields.message.label")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <GroupRow
                accountId={accountId}
                group={group}
                key={group.id}
                workspaceId={workspaceId}
              />
            ))}
            {groups.length === 0 && (
              <TableRow>
                <TableCell colSpan={3}>{t("messages.noData")}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
