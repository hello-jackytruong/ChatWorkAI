"use client"

import { Avatar, AvatarImage } from "@chatbotx.io/ui/components/ui/avatar"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@chatbotx.io/ui/components/ui/table"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import {
  setZaloAccountGroupMessagingAction,
  syncZaloAccountFriendsAction,
} from "../actions/account-operations.action"
import { sendZaloAccountGroupMessageAction } from "../actions/send-group-message.action"
import { syncZaloAccountGroupsAction } from "../actions/sync-groups.action"
import { syncZaloAccountLabelsAction } from "../actions/sync-labels.action"
import { updateZaloAccountGroupPolicyAction } from "../actions/update-group-policy.action"
import {
  useInvalidateZaloAccountOperations,
  useZaloAccountOperations,
} from "../queries/use-account-operations"
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
  enabled,
  sendReady,
}: {
  accountId: string
  group: ZaloAccountGroupResource
  workspaceId: string
  enabled: boolean
  sendReady: boolean
}) {
  const t = useTranslations()
  const invalidate = useInvalidateZaloAccountOperations(workspaceId, accountId)
  const [text, setText] = useState("")
  const [commandId, setCommandId] = useState(() => crypto.randomUUID())
  const policy = useAction(
    updateZaloAccountGroupPolicyAction.bind(null, workspaceId, accountId),
    {
      onSuccess: invalidate,
      onError: ({ error }) => showActionError(error),
    },
  )
  const send = useAction(
    sendZaloAccountGroupMessageAction.bind(null, workspaceId, accountId),
    {
      onSuccess: () => {
        setText("")
        setCommandId(crypto.randomUUID())
      },
      onError: ({ error }) => showActionError(error),
    },
  )

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          {group.avatarUrl && (
            <Avatar className="size-8">
              <AvatarImage alt="" src={group.avatarUrl} />
            </Avatar>
          )}
          <div>
            <div>{group.name}</div>
            <div className="text-muted-foreground text-xs">
              {group.memberCount}
            </div>
            {!group.accessible && (
              <div className="text-destructive text-xs">
                {t("zaloAccount.inaccessible")}
              </div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Switch
          aria-label={t("zaloAccount.receive")}
          checked={group.receiveEnabled}
          disabled={!(enabled && group.accessible) || policy.isPending}
          onCheckedChange={(receiveEnabled) =>
            policy.execute({ groupId: group.id, receiveEnabled })
          }
        />
      </TableCell>
      <TableCell>
        <Switch
          aria-label={t("zaloAccount.send")}
          checked={group.accessible && group.sendEnabled}
          disabled={!(enabled && group.accessible) || policy.isPending}
          onCheckedChange={(sendEnabled) =>
            policy.execute({ groupId: group.id, sendEnabled })
          }
        />
      </TableCell>
      <TableCell>
        <Select
          disabled={
            !(enabled && group.accessible && group.receiveEnabled) ||
            policy.isPending
          }
          onValueChange={(value) => {
            if (
              value === "disabled" ||
              value === "mentionOnly" ||
              value === "all"
            ) {
              policy.execute({ groupId: group.id, automationMode: value })
            }
          }}
          value={group.automationMode}
        >
          <SelectTrigger
            aria-label={t("zaloAccount.automation")}
            className="w-40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="disabled">
              {t("zaloAccount.automationDisabled")}
            </SelectItem>
            <SelectItem value="mentionOnly">
              {t("zaloAccount.mentionOnly")}
            </SelectItem>
            <SelectItem value="all">{t("zaloAccount.allMessages")}</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <div className="flex min-w-72 gap-2">
          <Input
            aria-label={t("fields.message.label")}
            disabled={
              !(sendReady && group.accessible && group.sendEnabled) ||
              send.isPending
            }
            onChange={(event) => {
              setText(event.target.value)
              setCommandId(crypto.randomUUID())
            }}
            value={text}
          />
          <Button
            disabled={
              !(sendReady && group.accessible && group.sendEnabled) ||
              send.isPending ||
              text.trim().length === 0
            }
            onClick={() => send.execute({ groupId: group.id, text, commandId })}
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
  groupMessagingEnabled,
  workspaceId,
}: {
  accountId: string
  accountName: string
  groups: ZaloAccountGroupResource[]
  groupMessagingEnabled: boolean
  workspaceId: string
}) {
  const t = useTranslations()
  const query = useZaloAccountOperations(workspaceId, accountId)
  const invalidate = useInvalidateZaloAccountOperations(workspaceId, accountId)
  const status = query.data?.status
  let connectionLabel = t("zaloAccount.degraded")
  if (status?.status === "needs_reauth") {
    connectionLabel = t("zaloAccount.reconnectRequired")
  } else if (status?.status === "connected" && status.gatewayAvailable) {
    connectionLabel = t("zaloAccount.connected")
  }
  let labelStatus = status?.labels.complete
    ? t("zaloAccount.complete")
    : t("zaloAccount.partial")
  if (status?.labels.paused) {
    labelStatus = t("zaloAccount.reconcileRequired")
    if (status.labels.reason === "versionConflict") {
      labelStatus = t("zaloAccount.labelConflict")
    } else if (status.labels.reason === "outcomeUnknown") {
      labelStatus = t("zaloAccount.labelUnknown")
    }
  }
  const enabled = status?.groupMessagingEnabled ?? groupMessagingEnabled
  const sendReady =
    enabled && status?.status === "connected" && status.gatewayAvailable
  const setMessaging = useAction(
    setZaloAccountGroupMessagingAction.bind(null, workspaceId, accountId),
    { onSuccess: invalidate, onError: ({ error }) => showActionError(error) },
  )
  const syncFriends = useAction(
    syncZaloAccountFriendsAction.bind(null, workspaceId, accountId),
    { onSuccess: invalidate, onError: ({ error }) => showActionError(error) },
  )
  const sync = useAction(
    syncZaloAccountGroupsAction.bind(null, workspaceId, accountId),
    {
      onSuccess: invalidate,
      onError: ({ error }) => showActionError(error),
    },
  )
  const syncLabels = useAction(
    syncZaloAccountLabelsAction.bind(null, workspaceId, accountId),
    {
      onSuccess: invalidate,
      onError: ({ error }) => showActionError(error),
    },
  )

  return (
    <section className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{accountName}</h3>
        <div className="flex gap-2">
          <Button
            disabled={syncFriends.isPending}
            onClick={() =>
              syncFriends.execute({
                commandId: crypto.randomUUID(),
                ...(status?.friends.nextCursor
                  ? { cursor: status.friends.nextCursor }
                  : {}),
              })
            }
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("actions.synchronize")} · {t("zaloAccount.friends")}
          </Button>
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
      <p className="text-muted-foreground text-xs">
        {t("zaloAccount.unofficialWarning")}
      </p>
      <label
        className="flex items-center gap-2 text-sm"
        htmlFor={`zalo-group-messaging-${accountId}`}
      >
        <Switch
          checked={enabled}
          disabled={setMessaging.isPending}
          id={`zalo-group-messaging-${accountId}`}
          onCheckedChange={(enabled) => setMessaging.execute({ enabled })}
        />
        {t("zaloAccount.groupMessaging")}
      </label>
      <div
        aria-live="polite"
        className="flex flex-wrap gap-3 text-muted-foreground text-xs"
      >
        {query.isError && <span>{t("zaloAccount.statusUnavailable")}</span>}
        {status && (
          <>
            <span>{connectionLabel}</span>
            <span>
              {t("zaloAccount.friends")}: {status.friends.count} ·{" "}
              {status.friends.complete
                ? t("zaloAccount.complete")
                : t("zaloAccount.partial")}{" "}
              {status.friends.completedAt && (
                <time dateTime={status.friends.completedAt}>
                  {new Date(status.friends.completedAt).toLocaleString()}
                </time>
              )}
            </span>
            <span>
              {t("zaloAccount.groups")}: {status.groups.count} ·{" "}
              {status.groups.complete
                ? t("zaloAccount.complete")
                : t("zaloAccount.partial")}{" "}
              {status.groups.completedAt && (
                <time dateTime={status.groups.completedAt}>
                  {new Date(status.groups.completedAt).toLocaleString()}
                </time>
              )}
            </span>
            <span>
              {t("fields.tags.label")}: {labelStatus}{" "}
              {status.labels.completedAt && (
                <time dateTime={status.labels.completedAt}>
                  {new Date(status.labels.completedAt).toLocaleString()}
                </time>
              )}
            </span>
          </>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("fields.name.label")}</TableHead>
              <TableHead>{t("zaloAccount.receive")}</TableHead>
              <TableHead>{t("zaloAccount.send")}</TableHead>
              <TableHead>{t("zaloAccount.automation")}</TableHead>
              <TableHead>{t("fields.message.label")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(query.data?.groups ?? groups).map((group) => (
              <GroupRow
                accountId={accountId}
                enabled={enabled}
                group={group}
                key={group.id}
                sendReady={sendReady}
                workspaceId={workspaceId}
              />
            ))}
            {(query.data?.groups ?? groups).length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>{t("messages.noData")}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
