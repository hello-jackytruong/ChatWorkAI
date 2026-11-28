"use client"

import { zaloAccountNativeToolOperationSchema } from "@chatbotx.io/sdk"
import { InputField } from "@chatbotx.io/ui/components/form/input-field"
import { TextareaField } from "@chatbotx.io/ui/components/form/textarea-field"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import Image from "next/image"
import { useTranslations } from "next-intl"
import { useId, useState } from "react"
import { useForm } from "react-hook-form"
import {
  type NativeAccountResult,
  type NativeAccountTarget,
  type NativeAccountWriteControls,
  useNativeAccountTool,
} from "../lib/native-account-tools-ui"

type Profile = NonNullable<NativeAccountResult["ownProfile"]>
const genderLabels = ["fields.gender.male", "fields.gender.female"] as const

function NativeAccountProfileQr({ target }: { target: NativeAccountTarget }) {
  const t = useTranslations()
  const qr = useNativeAccountTool(target, { kind: "readOwnQr" })
  const qrUrl = qr.data?.profileQr?.imageUrl

  return (
    <div className="space-y-2">
      {qr.isPending && <p role="status">{t("actions.loading")}</p>}
      {!(qr.isPending || qrUrl) && (
        <p role="status">{t("zaloAccount.nativeProfile.qrUnavailable")}</p>
      )}
      {qrUrl && (
        <Image
          alt={t("zaloAccount.nativeProfile.qrAlt")}
          className="rounded-md border bg-white"
          height={184}
          referrerPolicy="no-referrer"
          src={qrUrl}
          unoptimized
          width={184}
        />
      )}
      {!qr.isPending && (
        <Button
          disabled={qr.isFetching}
          onClick={() => qr.refetch()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("zaloAccount.nativeProfile.refreshQr")}
        </Button>
      )}
    </div>
  )
}

function ProfileEdit({
  bioOnly,
  profile,
  busy,
  onCancel,
  submit,
}: {
  bioOnly: boolean
  profile: Profile
  busy: boolean
  onCancel: () => void
  submit: NativeAccountWriteControls["submit"]
}) {
  const t = useTranslations()
  const id = useId()
  const form = useForm({
    defaultValues: {
      name: profile.name ?? "",
      gender: profile.gender === undefined ? "" : String(profile.gender),
      birthDate: profile.birthDate ?? "",
      bio: profile.bio ?? "",
    },
  })
  const [invalid, setInvalid] = useState(false)

  return (
    <Form {...form}>
      <form
        className="space-y-3"
        onSubmit={form.handleSubmit((values) => {
          const nextName = values.name.trim()
          const nextGender =
            values.gender === "" ? undefined : Number(values.gender)
          const patch = {
            ...(nextName && nextName !== profile.name
              ? { name: nextName }
              : {}),
            ...(values.birthDate && values.birthDate !== profile.birthDate
              ? { birthDate: values.birthDate }
              : {}),
            ...(nextGender !== undefined && nextGender !== profile.gender
              ? { gender: nextGender }
              : {}),
          }
          if (
            bioOnly
              ? values.bio === (profile.bio ?? "")
              : Object.keys(patch).length === 0
          ) {
            onCancel()
            return
          }
          const parsed = zaloAccountNativeToolOperationSchema.safeParse(
            bioOnly
              ? { kind: "updateOwnBio", bio: values.bio }
              : { kind: "updateOwnProfile", patch },
          )
          setInvalid(!parsed.success)
          if (
            parsed.success &&
            (parsed.data.kind === "updateOwnProfile" ||
              parsed.data.kind === "updateOwnBio")
          ) {
            submit(parsed.data)
            onCancel()
          }
        })}
      >
        {bioOnly ? (
          <TextareaField
            disabled={busy}
            label={t("zaloAccount.nativeProfile.bio")}
            maxLength={500}
            name="bio"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <InputField
              disabled={busy}
              label={t("fields.name.label")}
              maxLength={100}
              name="name"
            />
            <InputField
              disabled={busy}
              label={t("zaloAccount.profile.birthDate")}
              name="birthDate"
              type="date"
            />
            <div className="space-y-2">
              <label className="block font-medium" htmlFor={id}>
                {t("fields.gender.label")}
              </label>
              <select
                {...form.register("gender")}
                className="h-9 w-full rounded-md border border-input bg-background px-3"
                disabled={busy}
                id={id}
              >
                <option value="">{t("condition.unknownValue")}</option>
                <option value="0">{t(genderLabels[0])}</option>
                <option value="1">{t(genderLabels[1])}</option>
              </select>
            </div>
          </div>
        )}
        {invalid && (
          <p role="alert">{t("zaloAccount.nativeProfile.invalid")}</p>
        )}
        <div className="flex gap-2">
          <Button disabled={busy} size="sm" type="submit">
            {t("actions.save")}
          </Button>
          <Button
            disabled={busy}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("actions.cancel")}
          </Button>
        </div>
      </form>
    </Form>
  )
}

export function NativeAccountProfileDetails({
  controls,
  profile,
  target,
}: {
  controls: NativeAccountWriteControls
  profile: Profile
  target: NativeAccountTarget
}) {
  const t = useTranslations()
  const [editing, setEditing] = useState<"profile" | "bio">()
  const [qrOpen, setQrOpen] = useState(false)
  const [businessOpen, setBusinessOpen] = useState(false)
  const business = useNativeAccountTool(
    target,
    { kind: "readOwnBusiness" },
    businessOpen,
  )
  const company = business.data?.ownBusiness

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {profile.avatarUrl && (
            <Image
              alt=""
              className="size-14 rounded-full object-cover"
              height={56}
              referrerPolicy="no-referrer"
              src={profile.avatarUrl}
              unoptimized
              width={56}
            />
          )}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("fields.name.label")}</dt>
            <dd className="wrap-break-word font-medium">
              {profile.name ?? t("condition.unknownValue")}
            </dd>
            <dt className="text-muted-foreground">
              {t("zaloAccount.profile.birthDate")}
            </dt>
            <dd>{profile.birthDate ?? t("condition.unknownValue")}</dd>
            <dt className="text-muted-foreground">
              {t("fields.gender.label")}
            </dt>
            <dd>
              {profile.gender === undefined
                ? t("condition.unknownValue")
                : t(genderLabels[profile.gender])}
            </dd>
          </dl>
        </div>
        {controls.canWrite && editing !== "profile" && (
          <Button
            disabled={controls.busy}
            onClick={() => setEditing("profile")}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("zaloAccount.nativeProfile.editProfile")}
          </Button>
        )}
      </div>
      {controls.canWrite && editing === "profile" && (
        <ProfileEdit
          bioOnly={false}
          busy={controls.busy}
          key="profile"
          onCancel={() => setEditing(undefined)}
          profile={profile}
          submit={controls.submit}
        />
      )}
      <div className="flex flex-wrap items-start justify-between gap-3 border-t pt-3">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{t("zaloAccount.nativeProfile.bio")}</p>
          <p className="wrap-break-word whitespace-pre-wrap text-muted-foreground">
            {profile.bio || t("zaloAccount.nativeProfile.noBio")}
          </p>
        </div>
        {controls.canWrite && editing !== "bio" && (
          <Button
            disabled={controls.busy}
            onClick={() => setEditing("bio")}
            size="sm"
            type="button"
            variant="secondary"
          >
            {t("zaloAccount.nativeProfile.editBio")}
          </Button>
        )}
      </div>
      {controls.canWrite && editing === "bio" && (
        <ProfileEdit
          bioOnly
          busy={controls.busy}
          key="bio"
          onCancel={() => setEditing(undefined)}
          profile={profile}
          submit={controls.submit}
        />
      )}
      <div className="flex flex-wrap gap-2 border-t pt-3">
        <Button
          aria-expanded={qrOpen}
          onClick={() => setQrOpen(!qrOpen)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {qrOpen
            ? t("zaloAccount.nativeProfile.hideQr")
            : t("zaloAccount.nativeProfile.showQr")}
        </Button>
        <Button
          aria-expanded={businessOpen}
          onClick={() => setBusinessOpen(!businessOpen)}
          size="sm"
          type="button"
          variant="secondary"
        >
          {businessOpen
            ? t("zaloAccount.nativeProfile.hideBusiness")
            : t("zaloAccount.nativeProfile.showBusiness")}
        </Button>
      </div>
      {qrOpen && <NativeAccountProfileQr target={target} />}
      {businessOpen && (
        <div className="space-y-2">
          {business.isPending && <p role="status">{t("actions.loading")}</p>}
          {!(business.isPending || company) && (
            <p role="status">
              {t("zaloAccount.nativeProfile.businessUnavailable")}
            </p>
          )}
          {company && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">
                {t("zaloAccount.nativeProfile.businessPackage")}
              </dt>
              <dd>{company.packageId ?? t("condition.unknownValue")}</dd>
              <dt className="text-muted-foreground">
                {t("zaloAccount.nativeProfile.businessCategory")}
              </dt>
              <dd className="wrap-break-word">
                {company.category ?? t("condition.unknownValue")}
              </dd>
              {company.description && (
                <>
                  <dt className="text-muted-foreground">
                    {t("fields.description.label")}
                  </dt>
                  <dd className="wrap-break-word whitespace-pre-wrap">
                    {company.description}
                  </dd>
                </>
              )}
            </dl>
          )}
          {business.isError && (
            <Button
              onClick={() => business.refetch()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("actions.retry")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
