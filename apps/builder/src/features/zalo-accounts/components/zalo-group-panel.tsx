"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { useTags } from "@/features/tags/provider/tag-hook"
import { updateZaloGroupTagAction } from "../actions/group-inbox.action"
import type { ZaloGroupConversation } from "../lib/group-content"
import {
  useInvalidateZaloGroupInbox,
  useZaloGroupInbox,
} from "../queries/use-group-inbox"
import { ZaloTagOrigin } from "./zalo-tag-origin"

export function ZaloGroupPanel({
  workspaceId,
  audience,
}: {
  workspaceId: string
  audience: ZaloGroupConversation
}) {
  const t = useTranslations()
  const query = useZaloGroupInbox(workspaceId, audience)
  const tags = useTags(workspaceId)
  const nativeTagIds = query.data?.nativeTagIds
    ? new Set(query.data.nativeTagIds)
    : null
  const [selected, setSelected] = useState<string | null>(null)
  const invalidate = useInvalidateZaloGroupInbox(workspaceId, audience)
  const action = useAction(
    updateZaloGroupTagAction.bind(null, workspaceId, audience.accountId),
    {
      onSuccess: async () => {
        await invalidate()
        setSelected(null)
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )
  return (
    <section className="flex flex-col gap-3 p-4">
      <h3 className="font-medium">
        {query.data?.group.name ?? t("zaloAccount.groupBadge")}
      </h3>
      <p className="text-muted-foreground text-sm">
        {t("zaloAccount.groupBadge")} ·{" "}
        {query.data?.group.memberCount ?? audience.memberCount ?? 0}
      </p>
      {query.isError && (
        <p role="status">{t("zaloAccount.statusUnavailable")}</p>
      )}
      <h4 className="text-sm">{t("zaloAccount.groupTags")}</h4>
      <div className="flex flex-wrap gap-1">
        {query.data?.tags.map((tag) => (
          <Button
            aria-label={`${t("actions.remove")}: ${tag.name}`}
            disabled={action.isPending}
            key={tag.id}
            onClick={() =>
              action.execute({
                groupId: audience.groupId,
                tagId: tag.id,
                assigned: false,
                commandId: crypto.randomUUID(),
              })
            }
            size="sm"
            variant="secondary"
          >
            {tag.name}
            {nativeTagIds && (
              <ZaloTagOrigin native={nativeTagIds.has(tag.id)} />
            )}
            <span aria-hidden>×</span>
          </Button>
        ))}
      </div>
      <Select
        disabled={action.isPending}
        items={(tags.data ?? []).map((tag) => ({
          value: tag.id,
          label: tag.name,
        }))}
        onValueChange={(value) =>
          setSelected(typeof value === "string" ? value : null)
        }
        value={selected}
      >
        <SelectTrigger aria-label={t("fields.tags.label")}>
          <SelectValue placeholder={t("fields.tags.label")} />
        </SelectTrigger>
        <SelectContent>
          {(tags.data ?? [])
            .filter(
              (tag) =>
                !query.data?.tags.some((assigned) => assigned.id === tag.id),
            )
            .map((tag) => (
              <SelectItem key={tag.id} value={tag.id}>
                {tag.name}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Button
        disabled={!selected || action.isPending}
        onClick={() => {
          if (selected) {
            action.execute({
              groupId: audience.groupId,
              tagId: selected,
              assigned: true,
              commandId: crypto.randomUUID(),
            })
          }
        }}
        size="sm"
        variant="secondary"
      >
        {t("actions.add")}
      </Button>
    </section>
  )
}
