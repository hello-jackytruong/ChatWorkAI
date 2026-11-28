"use client"

import {
  type ZaloAccountGroupManagementOperation as Operation,
  type ZaloAccountGroupManagementResult as Result,
  zaloAccountGroupManagementOperationSchema,
} from "@chatbotx.io/sdk"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useRef, useState, useTransition } from "react"
import { readZaloGroupManagementAction } from "../actions/group-management.action"
import {
  type GroupManagementTarget,
  memberOutcomeLabels,
  outcomeLabels,
  reasonLabels,
  type SubmitGroupOperation as Submit,
  scopeInput,
  scopeKey,
} from "../lib/group-management-ui"

type Entry = NonNullable<Result["entries"]>[number]
type ListKind =
  | "getGroupBlockedMember"
  | "getPendingGroupMembers"
  | "getGroupInviteBoxList"

async function readOperation(
  scope: GroupManagementTarget,
  operation: Operation,
) {
  const response = await readZaloGroupManagementAction(
    scope.workspaceId,
    scope.accountId,
    {
      ...scopeInput(scope),
      operation,
    },
  )
  if (!response?.data) {
    throw new Error("Unable to read Zalo group operation")
  }
  return response.data
}

export function ResultMessage({
  result,
  providerPending = false,
}: {
  result: Result
  providerPending?: boolean
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const outcomeLabel = result.reason
    ? reasonLabels[result.reason]
    : outcomeLabels[result.outcome]
  return (
    <div className="space-y-2">
      <p role="status">
        {t(providerPending ? "outcome.providerPending" : outcomeLabel)}
      </p>
      {result.memberOutcomes && result.memberOutcomes.length > 0 && (
        <ul className="divide-y">
          {result.memberOutcomes.map((member) => (
            <li
              className="flex flex-wrap justify-between gap-2 py-2"
              key={member.uid}
            >
              <span>{member.uid}</span>
              <span>{t(memberOutcomeLabels[member.outcome])}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function LinkPreview({
  scope,
  canWrite,
  submit,
}: {
  scope: GroupManagementTarget
  canWrite: boolean
  submit: Submit
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const [link, setLink] = useState("")
  const [result, setResult] = useState<Result>()
  const [invalid, setInvalid] = useState(false)
  const [pending, startTransition] = useTransition()
  const running = useRef(false)

  function preview() {
    const parsed = zaloAccountGroupManagementOperationSchema.safeParse({
      kind: "getGroupLinkInfo",
      link: link.trim(),
    })
    setInvalid(!parsed.success)
    if (!parsed.success || running.current) {
      return
    }
    running.current = true
    setResult(undefined)
    startTransition(async () => {
      try {
        setResult(await readOperation(scope, parsed.data))
      } catch {
        setResult({ kind: "getGroupLinkInfo", outcome: "unavailable" })
      } finally {
        running.current = false
      }
    })
  }
  const entry = result?.group
  const name = entry?.name ?? entry?.providerGroupId

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        preview()
      }}
    >
      <Input
        aria-label={t("link")}
        disabled={pending}
        maxLength={512}
        onChange={(event) => {
          setLink(event.target.value)
          setResult(undefined)
          setInvalid(false)
        }}
        type="url"
        value={link}
      />
      {invalid && <p role="alert">{t("invalid")}</p>}
      <Button disabled={!link || pending} size="sm" type="submit">
        {t("preview")}
      </Button>
      {result && <ResultMessage result={result} />}
      {name && <p className="font-medium">{name}</p>}
      {name && canWrite && result?.outcome === "confirmed" && (
        <Button
          onClick={() =>
            submit({ kind: "joinGroupLink", link: link.trim() }, name)
          }
          size="sm"
          type="button"
        >
          {t("join")}
        </Button>
      )}
    </form>
  )
}

export function GroupLinkSettings({
  scope,
  canWrite,
  submit,
}: {
  scope: GroupManagementTarget
  canWrite: boolean
  submit: Submit
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const actions = useTranslations("actions")
  const query = useQuery({
    queryKey: [...scopeKey(scope), "read", "getGroupLinkDetail"],
    queryFn: ({ signal }) =>
      readOperation(scope, { kind: "getGroupLinkDetail" }).then((result) => {
        signal.throwIfAborted()
        return result
      }),
    gcTime: 0,
    retry: false,
  })
  if (query.isPending) {
    return <p role="status">{actions("loading")}</p>
  }
  if (query.isError) {
    return (
      <Button
        onClick={() => query.refetch()}
        size="sm"
        type="button"
        variant="secondary"
      >
        {actions("retry")}
      </Button>
    )
  }
  const data = query.data
  return (
    <div className="space-y-2">
      <ResultMessage result={data} />
      {data.link && (
        <Input aria-label={t("link")} readOnly type="url" value={data.link} />
      )}
      {canWrite &&
        data.outcome === "confirmed" &&
        data.linkEnabled !== undefined && (
          <Button
            onClick={() =>
              submit({
                kind: data.linkEnabled ? "disableGroupLink" : "enableGroupLink",
              })
            }
            size="sm"
            type="button"
          >
            {t(data.linkEnabled ? "disableLink" : "enableLink")}
          </Button>
        )}
    </div>
  )
}

function InvitationDetails({
  entry,
  scope,
  canWrite,
  submit,
}: {
  entry: Entry
  scope: GroupManagementTarget
  canWrite: boolean
  submit: Submit
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const actions = useTranslations("actions")
  const query = useQuery({
    queryKey: [...scopeKey(scope), "read", "getGroupInviteBoxInfo", entry.id],
    queryFn: ({ signal }) =>
      readOperation(scope, {
        kind: "getGroupInviteBoxInfo",
        invitedGroupId: entry.id,
      }).then((result) => {
        signal.throwIfAborted()
        return result
      }),
    gcTime: 0,
    retry: false,
  })
  if (query.isPending) {
    return <p role="status">{actions("loading")}</p>
  }
  if (query.isError) {
    return (
      <Button
        onClick={() => query.refetch()}
        size="sm"
        type="button"
        variant="secondary"
      >
        {actions("retry")}
      </Button>
    )
  }
  const data = query.data
  const name = data.group?.name ?? entry.name ?? entry.id
  const expiresAt = data.expiresAt ?? entry.expiresAt
  const expired = expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()
  return (
    <div className="space-y-2">
      <p className="font-medium">{name}</p>
      <ResultMessage
        result={
          expired ? { ...data, outcome: "rejected", reason: "expired" } : data
        }
      />
      {canWrite && data.outcome === "confirmed" && !expired && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              submit(
                { kind: "joinGroupInviteBox", invitedGroupId: entry.id },
                name,
              )
            }
            size="sm"
            type="button"
          >
            {t("join")}
          </Button>
          <Button
            onClick={() =>
              submit({ kind: "deleteGroupInviteBox", invitedGroupId: entry.id })
            }
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("dismissInvitation")}
          </Button>
        </div>
      )}
    </div>
  )
}

const emptyListLabels = {
  getGroupBlockedMember: "empty.blocked",
  getPendingGroupMembers: "empty.pending",
  getGroupInviteBoxList: "empty.invites",
} as const satisfies Record<ListKind, string>

export function ManagementList({
  kind,
  scope,
  canWrite,
  submit,
}: {
  kind: ListKind
  scope: GroupManagementTarget
  canWrite: boolean
  submit: Submit
}) {
  const t = useTranslations("zaloAccount.groupManagement")
  const actions = useTranslations("actions")
  const [selectedId, setSelectedId] = useState<string>()
  const query = useInfiniteQuery({
    queryKey: [...scopeKey(scope), "read", kind],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => {
      const operation =
        kind === "getPendingGroupMembers"
          ? { kind, ...(pageParam === undefined ? {} : { offset: pageParam }) }
          : { kind, ...(pageParam === undefined ? {} : { page: pageParam }) }
      return readOperation(scope, operation).then((result) => {
        signal.throwIfAborted()
        return result
      })
    },
    getNextPageParam: (page) =>
      kind === "getPendingGroupMembers" ? page.nextOffset : page.nextPage,
    gcTime: 0,
    retry: false,
  })
  if (query.isPending) {
    return <p role="status">{actions("loading")}</p>
  }
  if (query.isError) {
    return (
      <div className="space-y-2">
        <p role="status">{t("outcome.unavailable")}</p>
        <Button
          onClick={() => query.refetch()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {actions("retry")}
        </Button>
      </div>
    )
  }
  const pages = query.data.pages
  const current = pages.at(-1)
  const entries = new Map<string, Entry>()
  for (const page of pages) {
    for (const entry of page.entries ?? []) {
      entries.set(entry.id, entry)
    }
  }
  if (
    current &&
    current.outcome !== "confirmed" &&
    current.outcome !== "partial"
  ) {
    return <ResultMessage result={current} />
  }
  return (
    <div className="space-y-2">
      {(current?.outcome === "partial" ||
        (current?.complete === false && !query.hasNextPage)) && (
        <p role="status">{t("partialList")}</p>
      )}
      {entries.size === 0 && current?.complete && (
        <p>{t(emptyListLabels[kind])}</p>
      )}
      {entries.size > 0 && (
        <ul className="divide-y">
          {Array.from(entries.values(), (entry) => (
            <li className="space-y-1 py-2" key={entry.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="wrap-break-word">
                  {entry.name ?? entry.uid ?? entry.id}
                </span>
                {kind === "getGroupInviteBoxList" && (
                  <Button
                    aria-expanded={selectedId === entry.id}
                    onClick={() =>
                      setSelectedId(
                        selectedId === entry.id ? undefined : entry.id,
                      )
                    }
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {actions("view")}
                  </Button>
                )}
                {canWrite && kind === "getGroupBlockedMember" && entry.uid && (
                  <Button
                    onClick={() => {
                      if (entry.uid) {
                        submit({
                          kind: "removeGroupBlockedMember",
                          memberUids: [entry.uid],
                        })
                      }
                    }}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    {t("unblock")}
                  </Button>
                )}
                {canWrite && kind === "getPendingGroupMembers" && entry.uid && (
                  <div className="flex flex-wrap gap-1">
                    {[true, false].map((approve) => (
                      <Button
                        key={String(approve)}
                        onClick={() => {
                          if (entry.uid) {
                            submit({
                              kind: "reviewPendingMemberRequest",
                              memberUids: [entry.uid],
                              approve,
                            })
                          }
                        }}
                        size="sm"
                        type="button"
                        variant="secondary"
                      >
                        {t(approve ? "approve" : "reject")}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              {kind === "getGroupInviteBoxList" && selectedId === entry.id && (
                <InvitationDetails
                  canWrite={canWrite}
                  entry={entry}
                  scope={scope}
                  submit={submit}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <Button
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage({ cancelRefetch: false })}
          size="sm"
          type="button"
          variant="secondary"
        >
          {actions("loadMore")}
        </Button>
      )}
    </div>
  )
}
