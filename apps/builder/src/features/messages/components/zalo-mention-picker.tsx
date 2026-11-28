"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useQuery } from "@tanstack/react-query"
import { XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { listZaloGroupMembersAction } from "@/features/zalo-accounts/actions/list-zalo-group-members.action"
import type { ZaloMentionMember } from "../lib/zalo-mention-draft"

export function ZaloMentionPicker({
  query,
  workspaceId,
  conversationId,
  accountId,
  groupId,
  recent,
  onChoose,
  onDismiss,
}: {
  query: string
  workspaceId: string
  conversationId: string
  accountId: string
  groupId: string
  recent: readonly ZaloMentionMember[]
  onChoose: (member: ZaloMentionMember) => void
  onDismiss: () => void
}) {
  const t = useTranslations()
  const [term, setTerm] = useState(query)
  useEffect(() => {
    const timeout = window.setTimeout(() => setTerm(query), 200)
    return () => window.clearTimeout(timeout)
  }, [query])
  const roster = useQuery({
    queryKey: [
      "zalo-mention-members",
      workspaceId,
      conversationId,
      accountId,
      groupId,
      term,
    ],
    enabled: query === term,
    gcTime: 60_000,
    staleTime: 15_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await listZaloGroupMembersAction(workspaceId, {
        conversationId,
        accountId,
        groupId,
        query: term || undefined,
        limit: 20,
      })
      signal.throwIfAborted()
      if (!result?.data) {
        throw new Error(result?.serverError ?? "Cannot get Zalo group members")
      }
      return result.data
    },
  })
  const needle = query.toLocaleLowerCase()
  const matches = new Map(
    recent
      .filter(
        ({ uid, name }) =>
          name?.toLocaleLowerCase().includes(needle) || uid.includes(needle),
      )
      .map((member) => [member.uid, member]),
  )
  if (query === term) {
    for (const member of roster.data?.members ?? []) {
      matches.set(member.uid, member)
    }
  }
  return (
    <div className="mx-2.5 mb-1 max-h-40 overflow-y-auto rounded-md border bg-popover px-1.5 py-1">
      <div className="flex justify-end">
        <Button
          aria-label={t("actions.cancel")}
          className="size-6"
          onClick={onDismiss}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
      {!roster.data?.complete && (
        <p className="px-1.5 py-1 text-muted-foreground text-xs" role="status">
          {t(
            roster.isFetching
              ? "actions.loading"
              : "zaloAccount.mention.partial",
          )}
        </p>
      )}
      {matches.size ? (
        <ul>
          {[...matches.values()].slice(0, 20).map((member) => (
            <li key={member.uid}>
              <Button
                className="h-auto w-full justify-start py-1"
                onClick={() => onChoose(member)}
                type="button"
                variant="ghost"
              >
                <span className="truncate">{member.name || member.uid}</span>
                {member.name && (
                  <span className="truncate text-muted-foreground text-xs">
                    {member.uid}
                  </span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        !roster.isFetching && (
          <p className="px-1.5 py-1 text-muted-foreground text-xs">
            {t("messages.noResults")}
          </p>
        )
      )}
    </div>
  )
}
