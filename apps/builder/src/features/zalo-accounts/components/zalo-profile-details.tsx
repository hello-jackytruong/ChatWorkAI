"use client"

import { toZaloAccountWebUrl } from "@chatbotx.io/sdk"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@chatbotx.io/ui/components/ui/avatar"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import Image from "next/image"
import { useFormatter, useTranslations } from "next-intl"
import { getZaloProfileAction } from "../actions/profile.action"

export type ZaloProfileTarget = {
  workspaceId: string
  accountId: string | null
  conversationId: string
  contactInboxId: string
  memberUid?: string
}

const CACHE_MS = 60_000
const birthYear = /^\d{4}$/
const birthDay = /^\d{4}-\d{2}-\d{2}$/
const genderKeys = ["gender.male", "gender.female"] as const
const relationshipKeys = {
  friend: "friend",
  notFriend: "notFriend",
  pending: "pending",
} as const

function textOf(value: string | number | boolean | undefined) {
  return typeof value === "string" ? value : undefined
}

function profileImage(value: string | undefined) {
  if (value?.startsWith("/assets/")) {
    return value
  }
  const url = value && toZaloAccountWebUrl(value)
  return url && url.protocol === "https:" ? url.href : undefined
}

export function ZaloProfileDetails({
  target,
  crmName,
}: {
  target: ZaloProfileTarget
  crmName?: string | null
}) {
  const t = useTranslations("zaloAccount.profile")
  const fieldsT = useTranslations("fields")
  const format = useFormatter()
  const queryClient = useQueryClient()
  const { workspaceId, accountId, ...scopedTarget } = target
  const queryKey = [
    "zalo-profile",
    workspaceId,
    accountId,
    target.conversationId,
    target.contactInboxId,
    target.memberUid,
  ] as const
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await getZaloProfileAction(workspaceId, accountId, {
        ...scopedTarget,
        refresh: false,
      })
      if (!result?.data) {
        throw new Error("Could not load the Zalo profile")
      }
      if (result.data.staleness !== "fresh") {
        const refreshed = await getZaloProfileAction(workspaceId, accountId, {
          ...scopedTarget,
          refresh: true,
        }).catch(() => null)
        return refreshed?.data ?? result.data
      }
      return result.data
    },
    staleTime: CACHE_MS,
    gcTime: CACHE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const refresh = useMutation({
    mutationFn: async () => {
      const result = await getZaloProfileAction(workspaceId, accountId, {
        ...scopedTarget,
        refresh: true,
        largeAvatar: true,
      })
      if (!result?.data) {
        throw new Error("Could not refresh the Zalo profile")
      }
      return result.data
    },
    onSuccess: async (data) => {
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, data)
    },
  })
  const fields = query.data?.profile?.fields
  const zaloName = textOf(fields?.zaloName)
  const displayName = textOf(fields?.displayName)
  const name = displayName || zaloName
  const date = textOf(fields?.birthDate)
  const parsedBirthDay =
    date && birthDay.test(date) ? new Date(`${date}T00:00:00Z`) : null
  const birthday =
    date &&
    (birthYear.test(date)
      ? date
      : parsedBirthDay &&
        Number.isFinite(parsedBirthDay.getTime()) &&
        parsedBirthDay.toISOString().startsWith(date) &&
        format.dateTime(parsedBirthDay, {
          dateStyle: "medium",
          timeZone: "UTC",
        }))
  const genderCode = fields?.gender
  const gender =
    genderCode === 0 || genderCode === 1
      ? fieldsT(genderKeys[genderCode])
      : null
  const relationship = textOf(fields?.relationship)
  const relationLabel =
    relationship && Object.hasOwn(relationshipKeys, relationship)
      ? t(relationshipKeys[relationship as keyof typeof relationshipKeys])
      : null
  const avatarUrl = profileImage(textOf(fields?.avatarUrl))
  const coverUrl = profileImage(textOf(fields?.coverUrl))
  const bio = textOf(fields?.bio)
  const rows = [
    [t("zaloName"), zaloName],
    [t("accountName"), displayName],
    [t("crmName"), crmName],
    [fieldsT("username.label"), textOf(fields?.username)],
    [fieldsT("gender.label"), gender],
    [t("birthDate"), birthday],
    [t("publicPhone"), textOf(fields?.publicPhone)],
    [t("business"), textOf(fields?.business)],
    [t("relationship"), relationLabel],
    [fieldsT("status.label"), fields?.blocked === true ? t("blocked") : null],
  ] as const
  const observedAt = query.data?.observedAt
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      {coverUrl && (
        <div className="relative h-20 overflow-hidden rounded bg-muted">
          <Image
            alt=""
            className="object-cover"
            fill
            referrerPolicy="no-referrer"
            sizes="300px"
            src={coverUrl}
            unoptimized
          />
        </div>
      )}
      {fields && (name || avatarUrl) && (
        <Avatar aria-hidden="true" className="size-9">
          <AvatarImage alt="" referrerPolicy="no-referrer" src={avatarUrl} />
          <AvatarFallback>{name?.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      )}
      {query.isPending && <p role="status">{t("loading")}</p>}
      {(query.isError || query.data?.staleness === "unavailable") && (
        <p role="status">{t("unavailable")}</p>
      )}
      {query.data?.staleness === "stale" && (
        <p className="text-muted-foreground text-xs" role="status">
          {t("stale")}
        </p>
      )}
      <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) =>
          value ? (
            <div className="contents" key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="wrap-anywhere min-w-0">{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {bio && <p className="wrap-anywhere whitespace-pre-wrap">{bio}</p>}
      {observedAt != null && (
        <p className="text-muted-foreground text-xs">
          {t("observedAt", {
            date: format.dateTime(new Date(observedAt), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </p>
      )}
      {refresh.isError && (
        <p className="text-destructive text-xs" role="alert">
          {t("refreshFailed")}
        </p>
      )}
      <Button
        className="self-start"
        disabled={query.isFetching || refresh.isPending}
        onClick={() => refresh.mutate()}
        size="sm"
        type="button"
        variant="secondary"
      >
        {t("refresh")}
      </Button>
    </div>
  )
}
