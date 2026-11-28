"use client"

import type { ZaloAccountGroupAdministrationResult } from "@chatbotx.io/sdk"
import { Avatar, AvatarImage } from "@chatbotx.io/ui/components/ui/avatar"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@chatbotx.io/ui/components/ui/sheet"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@chatbotx.io/ui/components/ui/tabs"
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useFormatter, useTranslations } from "next-intl"
import { type ReactNode, useState } from "react"
import {
  getZaloGroupAdministrationAction,
  listZaloGroupAdministrationMembersAction,
  listZaloGroupRelatedGroupsAction,
} from "../actions/group-administration.action"
import {
  type GroupManagementMember,
  groupRoleAllows,
  memberOperations,
} from "../lib/group-management-ui"
import { useInvalidateZaloAccountOperations } from "../queries/use-account-operations"
import { ZaloGroupManagementControls } from "./zalo-group-management-controls"

type GroupTarget = {
  workspaceId: string
  accountId: string
  groupId: string
}
type GroupOverview = Extract<
  ZaloAccountGroupAdministrationResult,
  { kind: "overview" }
>["overview"]
type GroupSettings = NonNullable<GroupOverview["settings"]>

const roleLabels = {
  owner: "home.owner",
  deputy: "zaloAccount.groupAdministration.deputy",
  member: "fields.member.label",
  unknown: "condition.unknownValue",
} as const satisfies Record<GroupOverview["role"], string>

const settingLabels = {
  blockName: "zaloAccount.groupAdministration.settings.blockName",
  signAdminMsg: "zaloAccount.groupAdministration.settings.signAdminMsg",
  addMemberOnly: "zaloAccount.groupAdministration.settings.addMemberOnly",
  setTopicOnly: "zaloAccount.groupAdministration.settings.setTopicOnly",
  enableMsgHistory: "zaloAccount.groupAdministration.settings.enableMsgHistory",
  joinAppr: "zaloAccount.groupAdministration.settings.joinAppr",
  lockCreatePost: "zaloAccount.groupAdministration.settings.lockCreatePost",
  lockCreatePoll: "zaloAccount.groupAdministration.settings.lockCreatePoll",
  lockSendMsg: "zaloAccount.groupAdministration.settings.lockSendMsg",
  lockViewMember: "zaloAccount.groupAdministration.settings.lockViewMember",
} as const satisfies Record<keyof GroupSettings, string>
const settingKeys = Object.keys(settingLabels) as (keyof typeof settingLabels)[]

function GroupField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-line break-words text-end">
        {children}
      </dd>
    </div>
  )
}

function GroupOverviewFields({ group }: { group: GroupOverview }) {
  const t = useTranslations()
  const format = useFormatter()
  const unknown = t("condition.unknownValue")
  const booleanLabel = (value?: boolean) => {
    if (value === undefined) {
      return unknown
    }
    return value ? t("condition.yes") : t("condition.no")
  }
  const typeLabels = {
    group: t("zaloAccount.groupBadge"),
    community: t("zaloAccount.groupAdministration.community"),
  }

  return (
    <div className="space-y-4 text-sm">
      {!group.accessible && (
        <p role="status">{t("zaloAccount.inaccessible")}</p>
      )}
      <dl className="space-y-2">
        <GroupField label={t("fields.type.label")}>
          {group.type ? typeLabels[group.type] : unknown}
        </GroupField>
        <GroupField label={t("zaloAccount.groupAdministration.accountRole")}>
          {t(roleLabels[group.role])}
        </GroupField>
        <GroupField label={t("fields.description.label")}>
          {group.description === ""
            ? t("zaloAccount.groupAdministration.noDescription")
            : (group.description ?? unknown)}
        </GroupField>
        {group.observedAt && (
          <GroupField label={t("zaloAccount.groupAdministration.observedAt")}>
            <time dateTime={group.observedAt}>
              {format.dateTime(new Date(group.observedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
          </GroupField>
        )}
      </dl>
      <section className="space-y-2 border-t pt-3">
        <h4 className="font-medium">{t("fields.permissions.label")}</h4>
        <dl className="space-y-2">
          <GroupField label={t("zaloAccount.groupAdministration.viewMembers")}>
            {booleanLabel(group.capabilities?.viewMembers)}
          </GroupField>
          <GroupField label={t("zaloAccount.groupAdministration.sendMessages")}>
            {booleanLabel(group.capabilities?.sendMessages)}
          </GroupField>
        </dl>
      </section>
      <section className="space-y-2 border-t pt-3">
        <h4 className="font-medium">
          {t("zaloAccount.groupAdministration.settings.title")}
        </h4>
        <dl className="space-y-2">
          {settingKeys.map((setting) => (
            <GroupField key={setting} label={t(settingLabels[setting])}>
              {booleanLabel(group.settings?.[setting])}
            </GroupField>
          ))}
        </dl>
      </section>
    </div>
  )
}

function GroupRelatedGroups({
  accountId,
  groupId,
  uid,
  workspaceId,
}: GroupTarget & { uid: string }) {
  const t = useTranslations()
  const query = useQuery({
    queryKey: [
      "zalo-group-administration",
      workspaceId,
      accountId,
      groupId,
      "related",
      uid,
    ],
    gcTime: 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      const result = await listZaloGroupRelatedGroupsAction(
        workspaceId,
        accountId,
        { groupId, uid },
      )
      signal.throwIfAborted()
      if (!result?.data) {
        throw new Error("Could not read shared Zalo groups")
      }
      return result.data
    },
  })
  if (query.isPending) {
    return <p role="status">{t("actions.loading")}</p>
  }
  if (query.isError) {
    return (
      <div className="space-y-2">
        <p role="status">
          {t("zaloAccount.groupAdministration.related.error")}
        </p>
        <Button
          onClick={() => query.refetch()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {t("actions.retry")}
        </Button>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {!query.data.complete && (
        <p role="status">
          {t("zaloAccount.groupAdministration.related.partial")}
        </p>
      )}
      {query.data.complete && query.data.groups.length === 0 && (
        <p>{t("zaloAccount.groupAdministration.related.empty")}</p>
      )}
      {query.data.groups.length > 0 && (
        <ul className="list-inside list-disc">
          {query.data.groups.map((group) => (
            <li key={group.groupId}>{group.name}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function GroupMemberRoster({
  accountId,
  enabled,
  groupId,
  onManageMember,
  role,
  workspaceId,
}: GroupTarget & {
  enabled: boolean
  onManageMember: (member: GroupManagementMember) => void
  role: GroupOverview["role"]
}) {
  const t = useTranslations()
  const client = useQueryClient()
  const [relatedUid, setRelatedUid] = useState<string>()
  const queryKey = [
    "zalo-group-administration",
    workspaceId,
    accountId,
    groupId,
    "members",
  ] as const
  const query = useInfiniteQuery({
    queryKey,
    enabled,
    gcTime: 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const result = await listZaloGroupAdministrationMembersAction(
        workspaceId,
        accountId,
        { groupId, ...(pageParam ? { cursor: pageParam } : {}) },
      )
      signal.throwIfAborted()
      if (!result?.data) {
        throw new Error("Could not read Zalo group members")
      }
      return result.data
    },
    getNextPageParam: (page) => page.nextCursor,
  })
  const pages = query.data?.pages ?? []
  const current = pages.at(-1)
  const members = pages
    .filter((page) => page.visibility === "visible")
    .flatMap((page) => page.members)

  if (query.isPending) {
    return <p role="status">{t("actions.loading")}</p>
  }
  if (query.isError) {
    return (
      <div className="space-y-2">
        <p role="status">{t("zaloAccount.groupAdministration.membersError")}</p>
        <Button
          onClick={() => client.resetQueries({ exact: true, queryKey })}
          size="sm"
          type="button"
          variant="secondary"
        >
          {t("actions.retry")}
        </Button>
      </div>
    )
  }
  if (current?.visibility === "restricted") {
    return (
      <p role="status">
        {t("zaloAccount.groupAdministration.membersRestricted")}
      </p>
    )
  }
  if (current?.visibility === "unknown") {
    return (
      <p role="status">{t("zaloAccount.groupAdministration.membersUnknown")}</p>
    )
  }

  return (
    <div className="space-y-3">
      {pages.some((page) => !page.complete) && (
        <p role="status">
          {t("zaloAccount.groupAdministration.membersPartial")}
        </p>
      )}
      {current?.complete && members.length === 0 && (
        <p>{t("zaloAccount.groupAdministration.membersEmpty")}</p>
      )}
      {members.length > 0 && (
        <ul className="divide-y">
          {members.map((member) => {
            const target = {
              uid: member.uid,
              name: member.name ?? member.uid,
              role: member.role,
            }
            return (
              <li className="space-y-2 py-2" key={member.uid}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    {member.avatarUrl && (
                      <Avatar className="size-8">
                        <AvatarImage alt="" src={member.avatarUrl} />
                      </Avatar>
                    )}
                    <span className="wrap-break-word">
                      {member.name ?? member.uid}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    {t(roleLabels[member.role])}
                  </span>
                  {!member.isSelf && (
                    <Button
                      aria-expanded={relatedUid === member.uid}
                      aria-label={t(
                        "zaloAccount.groupAdministration.related.trigger",
                        { name: member.name ?? member.uid },
                      )}
                      onClick={() =>
                        setRelatedUid(
                          relatedUid === member.uid ? undefined : member.uid,
                        )
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("zaloAccount.groupAdministration.related.label")}
                    </Button>
                  )}
                  {!member.isSelf &&
                    memberOperations(target).some((kind) =>
                      groupRoleAllows(role, kind),
                    ) && (
                      <Button
                        aria-label={t(
                          "zaloAccount.groupManagement.manageMember",
                          { name: target.name },
                        )}
                        onClick={() => onManageMember(target)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("actions.manage")}
                      </Button>
                    )}
                </div>
                {!member.isSelf && relatedUid === member.uid && (
                  <GroupRelatedGroups
                    accountId={accountId}
                    groupId={groupId}
                    uid={member.uid}
                    workspaceId={workspaceId}
                  />
                )}
              </li>
            )
          })}
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
          {query.isFetchingNextPage
            ? t("actions.loading")
            : t("actions.loadMore")}
        </Button>
      )}
    </div>
  )
}

function GroupAdministrationPanel(target: GroupTarget) {
  const { workspaceId, accountId, groupId } = target
  const t = useTranslations()
  const [tab, setTab] = useState<"details" | "members" | "manage">("details")
  const [managementOpened, setManagementOpened] = useState(false)
  const [member, setMember] = useState<GroupManagementMember>()
  const client = useQueryClient()
  const invalidateOperations = useInvalidateZaloAccountOperations(
    workspaceId,
    accountId,
  )
  const queryKey = [
    "zalo-group-administration",
    workspaceId,
    accountId,
    groupId,
  ] as const
  const query = useQuery({
    queryKey: [...queryKey, "overview"],
    gcTime: 0,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }): Promise<GroupOverview> => {
      const result = await getZaloGroupAdministrationAction(
        workspaceId,
        accountId,
        { groupId },
      )
      signal.throwIfAborted()
      if (!result?.data) {
        throw new Error("Could not read Zalo group details")
      }
      return result.data
    },
  })

  if (query.isPending) {
    return (
      <p className="px-4" role="status">
        {t("actions.loading")}
      </p>
    )
  }
  if (query.isError) {
    return (
      <div className="space-y-2 px-4 text-sm">
        <p role="status">{t("zaloAccount.groupAdministration.detailsError")}</p>
        <Button
          onClick={() => query.refetch()}
          size="sm"
          type="button"
          variant="secondary"
        >
          {t("actions.retry")}
        </Button>
      </div>
    )
  }

  return (
    <Tabs
      className="min-h-0 flex-1 px-4"
      onValueChange={(value) => {
        if (value === "details" || value === "members" || value === "manage") {
          setTab(value)
        }
        if (value === "manage") {
          setManagementOpened(true)
        }
      }}
      value={tab}
    >
      <TabsList
        aria-label={t("zaloAccount.groupAdministration.details")}
        className="max-w-full overflow-x-auto px-4"
      >
        <TabsTrigger className="py-2" value="details">
          {t("zaloAccount.groupAdministration.details")}
        </TabsTrigger>
        <TabsTrigger
          className="py-2"
          disabled={!query.data.accessible}
          value="members"
        >
          {t("zaloAccount.groupAdministration.members")}
        </TabsTrigger>
        {(managementOpened ||
          (query.data.accessible && query.data.role !== "unknown")) && (
          <TabsTrigger className="py-2" value="manage">
            {t("actions.manage")}
          </TabsTrigger>
        )}
      </TabsList>
      <TabsContent className="overflow-y-auto pb-4" value="details">
        <GroupOverviewFields group={query.data} />
      </TabsContent>
      <TabsContent
        className="overflow-y-auto pb-4 text-sm"
        keepMounted
        value="members"
      >
        {query.data.capabilities?.viewMembers === false ? (
          <p role="status">
            {t("zaloAccount.groupAdministration.membersRestricted")}
          </p>
        ) : (
          <GroupMemberRoster
            {...target}
            enabled={tab === "members" && query.data.accessible}
            onManageMember={(selected) => {
              setMember(selected)
              setManagementOpened(true)
              setTab("manage")
            }}
            role={query.data.role}
          />
        )}
      </TabsContent>
      <TabsContent className="overflow-y-auto pb-4" keepMounted value="manage">
        {managementOpened && (
          <ZaloGroupManagementControls
            accountId={accountId}
            group={{
              id: groupId,
              name: query.data.name,
              role: query.data.role,
            }}
            key={member?.uid ?? "group"}
            member={member}
            onChanged={async () => {
              await client.invalidateQueries({ queryKey })
              await invalidateOperations()
            }}
            onClearMember={() => {
              setMember(undefined)
              setTab("members")
            }}
            workspaceId={workspaceId}
          />
        )}
      </TabsContent>
    </Tabs>
  )
}

export function ZaloGroupAdministrationSheet({
  name,
  ...target
}: GroupTarget & { name: string }) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)

  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger
        render={
          <Button
            aria-label={t("zaloAccount.groupAdministration.trigger", { name })}
            className="h-auto min-w-0 whitespace-normal p-0 text-start"
            type="button"
            variant="link"
          >
            {name}
          </Button>
        }
      />
      <SheetContent className="w-full sm:max-w-lg rtl:data-ending-style:-translate-x-full rtl:data-starting-style:-translate-x-full">
        <SheetHeader className="pe-12">
          <SheetTitle>{name}</SheetTitle>
        </SheetHeader>
        {open && <GroupAdministrationPanel {...target} />}
      </SheetContent>
    </Sheet>
  )
}
