import { describe, expect, it, vi } from "vitest"
import { runProviderAccountProfile } from "../src/runtime/account-profile"

type Provider = Parameters<typeof runProviderAccountProfile>[0]
const uid = "900000000000000018"
const differentUid = "900000000000000019"
const firstAvatar = "https://avatar.zdn.vn/current.jpg"
const selectedAvatar = "https://avatar.zdn.vn/album.jpg"
const ownQr = "https://qr.zalo.me/own-profile.png"

const attachment = {
  data: Buffer.from("image"),
  filename: "avatar.jpg" as const,
  metadata: { totalSize: 5 },
}
const download = vi.hoisted(() => vi.fn())
vi.mock("../src/runtime/outbound-attachment", () => ({
  downloadOutboundAttachment: download,
}))

function provider() {
  const own = {
    userId: uid,
    displayName: "Owner Name",
    avatar: firstAvatar,
    status: "Bio before",
    sdob: "1999-02-28",
    gender: 0,
    phoneNumber: "private-phone",
    userKey: "never-serialize",
    bizPkg: { pkgId: 2 },
  }
  const avatarPage = {
    albumId: "10",
    nextPhotoId: "900",
    hasMore: 1,
    photos: [
      {
        photoId: "101",
        thumbnail: selectedAvatar,
        url: selectedAvatar,
        bkUrl: "https://avatar.zdn.vn/raw.jpg?token=secret",
      },
      {
        photoId: "102",
        thumbnail: "https://example.com/untrusted.jpg",
        url: "https://example.com/full.jpg",
        bkUrl: "",
      },
    ],
  }
  const profile = vi.fn(async () => ({ profile: own }))
  const userInfo = vi.fn(
    async (): Promise<{
      changed_profiles: Record<string, typeof own>
    }> => ({
      changed_profiles: {
        [differentUid]: {
          ...own,
          userId: differentUid,
          displayName: "Wrong account",
        },
        [`${uid}_0`]: own,
      },
    }),
  )
  const qr = vi.fn(async () => ({
    [uid]: ownQr,
    [differentUid]: "https://qr.zalo.me/another.png",
  }))
  const business = vi.fn(async () => ({
    pkgId: 2,
    biz: {
      cate: 4,
      desc: "Business profile",
      addr: "address",
      email: "private-email",
      website: "https://example.com",
    },
  }))
  const avatars = vi.fn(async () => avatarPage)
  const settings = vi.fn(async () => ({
    view_birthday: 1,
    show_online_status: true,
    display_seen_status: 0,
    receive_message: 2,
    accept_stranger_call: 8,
    archived_chat_status: 1,
    quick_message_status: 0,
    setting_2FA_status: 1,
    extraSecret: "opaque",
  }))
  const update = vi.fn(async () => "")
  const bio = vi.fn(async () => "")
  const change = vi.fn(async () => "")
  const del = vi.fn(async () => ({ delPhotoIds: ["101"], errMap: {} }))
  const reuse = vi.fn(async () => null)
  const settingWrite = vi.fn(async () => "")
  const lang = vi.fn(async () => "")
  const active = vi.fn(async () => ({ status: true }))
  const authorize = vi.fn(async () => undefined)
  const api = {
    getOwnId: () => uid,
    fetchAccountInfo: profile,
    getUserInfo: userInfo,
    getQR: qr,
    getBizAccount: business,
    getAvatarList: avatars,
    getSettings: settings,
    updateProfile: update,
    updateProfileBio: bio,
    changeAccountAvatar: change,
    deleteAvatar: del,
    reuseAvatar: reuse,
    updateSettings: settingWrite,
    updateLang: lang,
    updateActiveStatus: active,
  }
  return {
    api: api as unknown as Provider,
    own,
    avatarPage,
    profile,
    userInfo,
    qr,
    business,
    avatars,
    settings,
    update,
    bio,
    change,
    del,
    reuse,
    settingWrite,
    lang,
    active,
    authorize,
  }
}

describe("native Zalo Account profile adapter", () => {
  it("falls back to only the verified own UID and projects only the safe profile fields", async () => {
    const mock = provider()
    mock.profile.mockResolvedValueOnce({
      profile: {
        ...mock.own,
        userId: differentUid,
        displayName: "Wrong account",
      },
    })
    const result = await runProviderAccountProfile(
      mock.api,
      { kind: "readOwnProfile" },
      mock.authorize,
    )
    expect(result).toMatchObject({
      kind: "readOwnProfile",
      outcome: "confirmed",
      ownProfile: {
        uid,
        name: "Owner Name",
        avatarUrl: firstAvatar,
        bio: "Bio before",
        gender: 0,
        birthDate: "1999-02-28",
      },
    })
    expect(mock.userInfo).toHaveBeenCalledExactlyOnceWith(uid)
    expect(mock.authorize).not.toHaveBeenCalled()
    expect(mock.business).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain("private-phone")
    expect(JSON.stringify(result)).not.toContain("Wrong account")
    expect(JSON.stringify(result)).not.toContain("never-serialize")
  })

  it("reads only the own profile QR and safe business fields", async () => {
    const mock = provider()
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "readOwnQr" },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "readOwnQr",
      outcome: "confirmed",
      profileQr: { imageUrl: ownQr },
    })
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "readOwnBusiness" },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "readOwnBusiness",
      outcome: "confirmed",
      ownBusiness: {
        packageId: 2,
        category: 4,
        description: "Business profile",
      },
    })
    expect(mock.qr).toHaveBeenCalledExactlyOnceWith(uid)
    expect(mock.business).toHaveBeenCalledExactlyOnceWith(uid)
    expect(mock.profile).not.toHaveBeenCalled()
    expect(mock.authorize).not.toHaveBeenCalled()
  })

  it("does not return profile QR URLs outside the vetted Zalo image origin", async () => {
    const mock = provider()
    mock.qr.mockResolvedValueOnce({
      [uid]: "https://qr.zalo.me.example.com/evil.png",
      [differentUid]: ownQr,
    })
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "readOwnQr" },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "readOwnQr",
      outcome: "unavailable",
    })
  })

  it("uses just the requested native avatar page and only exposes safe thumbnails", async () => {
    const mock = provider()
    const result = await runProviderAccountProfile(
      mock.api,
      { kind: "listOwnAvatars", page: 2, limit: 5 },
      mock.authorize,
    )
    expect(result).toMatchObject({
      kind: "listOwnAvatars",
      avatarPage: {
        page: 2,
        nextPage: 3,
        complete: false,
        photos: [
          { photoId: "101", thumbnailUrl: selectedAvatar },
          { photoId: "102" },
        ],
      },
    })
    expect(mock.avatars).toHaveBeenCalledExactlyOnceWith(5, 2)
    expect(JSON.stringify(result)).not.toContain("untrusted")
    expect(JSON.stringify(result)).not.toContain("raw.jpg")
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(mock.authorize).not.toHaveBeenCalled()
  })

  it("fills a partial profile edit only with verified unchanged fields and the business category", async () => {
    const mock = provider()
    mock.profile
      .mockResolvedValueOnce({ profile: mock.own })
      .mockResolvedValueOnce({
        profile: { ...mock.own, displayName: "Updated name" },
      })
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "updateOwnProfile", patch: { name: "Updated name" } },
        mock.authorize,
      ),
    ).resolves.toMatchObject({
      kind: "updateOwnProfile",
      outcome: "confirmed",
      ownProfile: {
        uid,
        name: "Updated name",
        gender: 0,
        birthDate: "1999-02-28",
      },
    })
    expect(mock.update).toHaveBeenCalledExactlyOnceWith({
      profile: { name: "Updated name", dob: "1999-02-28", gender: 0 },
      biz: { cate: 4 },
    })
    expect(mock.business).toHaveBeenCalledExactlyOnceWith(uid)
    expect(mock.profile).toHaveBeenCalledTimes(2)
    expect(mock.authorize).toHaveBeenCalledBefore(mock.update)
  })

  it("refuses to write a profile when the birthday or business category cannot be preserved", async () => {
    const missingBirthday = provider()
    missingBirthday.profile.mockResolvedValue({
      profile: { ...missingBirthday.own, sdob: "missing" },
    })
    missingBirthday.userInfo.mockResolvedValue({
      changed_profiles: {
        [`${uid}_0`]: { ...missingBirthday.own, sdob: "missing" },
      },
    })
    await expect(
      runProviderAccountProfile(
        missingBirthday.api,
        { kind: "updateOwnProfile", patch: { name: "After" } },
        missingBirthday.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    expect(missingBirthday.authorize).not.toHaveBeenCalled()
    expect(missingBirthday.update).not.toHaveBeenCalled()
    const missingCategory = provider()
    missingCategory.business.mockRejectedValueOnce(
      new Error("no business data"),
    )
    await expect(
      runProviderAccountProfile(
        missingCategory.api,
        { kind: "updateOwnProfile", patch: { name: "After" } },
        missingCategory.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    expect(missingCategory.authorize).not.toHaveBeenCalled()
    expect(missingCategory.update).not.toHaveBeenCalled()
  })

  it("confirms reuse only for a photo on the requested own page and never writes for an unknown photo", async () => {
    const mock = provider()
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "reuseOwnAvatar", photoId: "wrong", page: 2, limit: 5 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "unavailable" })
    expect(mock.reuse).not.toHaveBeenCalled()
    expect(mock.authorize).not.toHaveBeenCalled()
    mock.profile.mockResolvedValueOnce({
      profile: { ...mock.own, avatar: selectedAvatar },
    })
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "reuseOwnAvatar", photoId: "101", page: 2, limit: 5 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      ownProfile: { avatarUrl: selectedAvatar },
    })
    expect(mock.avatars).toHaveBeenNthCalledWith(2, 5, 2)
    expect(mock.reuse).toHaveBeenCalledExactlyOnceWith("101")
  })

  it("writes an avatar exactly once through the bounded image path and leaves the old image unconfirmed on readback", async () => {
    const mock = provider()
    download.mockResolvedValueOnce(attachment)
    await expect(
      runProviderAccountProfile(
        mock.api,
        {
          kind: "changeOwnAvatar",
          avatar: { kind: "image", url: "https://media.zalo.me/approved.jpg" },
        },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ kind: "changeOwnAvatar", outcome: "unknown" })
    expect(mock.change).toHaveBeenCalledExactlyOnceWith(attachment)
    expect(mock.authorize).toHaveBeenCalledBefore(mock.change)
    expect(mock.profile).toHaveBeenCalledTimes(2)
  })

  it("confirms only an exactly acknowledged avatar deletion on the same account album page", async () => {
    const mock = provider()
    mock.avatars.mockResolvedValueOnce(mock.avatarPage).mockResolvedValueOnce({
      ...mock.avatarPage,
      photos: mock.avatarPage.photos.slice(1),
    })
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "deleteOwnAvatar", photoId: "101", page: 2, limit: 5 },
        mock.authorize,
      ),
    ).resolves.toMatchObject({
      outcome: "confirmed",
      avatarPage: { page: 2, photos: [{ photoId: "102" }] },
    })
    expect(mock.avatars.mock.calls).toEqual([
      [5, 2],
      [5, 2],
    ])
    expect(mock.del).toHaveBeenCalledExactlyOnceWith("101")
    expect(mock.authorize).toHaveBeenCalledOnce()
  })

  it("verifies a bio can be cleared without a separate whole-profile write", async () => {
    const mock = provider()
    mock.profile.mockResolvedValueOnce({ profile: { ...mock.own, status: "" } })
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "updateOwnBio", bio: "" },
        mock.authorize,
      ),
    ).resolves.toMatchObject({ outcome: "confirmed", ownProfile: { bio: "" } })
    expect(mock.bio).toHaveBeenCalledExactlyOnceWith("")
    expect(mock.profile).toHaveBeenCalledOnce()
    expect(mock.update).not.toHaveBeenCalled()
  })

  it("writes one allowlisted settings key, maps the readback name, and omits unknown settings", async () => {
    const mock = provider()
    await expect(
      runProviderAccountProfile(
        mock.api,
        {
          kind: "updateOwnSetting",
          setting: { key: "archivedChatStatus", value: 1 },
        },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "updateOwnSetting",
      outcome: "confirmed",
      ownSettings: { archived_chat_status: 1 },
    })
    expect(mock.settingWrite).toHaveBeenCalledExactlyOnceWith(
      "archivedChatStatus",
      1,
    )
    expect(mock.settings).toHaveBeenCalledOnce()
    const result = await runProviderAccountProfile(
      mock.api,
      { kind: "readOwnSettings" },
      mock.authorize,
    )
    expect(result.ownSettings).toMatchObject({
      show_online_status: 1,
      display_seen_status: 0,
      receive_message: 2,
      archived_chat_status: 1,
    })
    expect(result.ownSettings).not.toHaveProperty("setting_2FA_status")
    expect(result.ownSettings).not.toHaveProperty("accept_stranger_call")
    expect(result.ownSettings).not.toHaveProperty("extraSecret")
  })

  it("keeps unverified language and active-status operations unavailable without dispatch", async () => {
    const mock = provider()
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "updateOwnLanguage", language: "VI" },
        mock.authorize,
      ),
    ).resolves.toEqual({ kind: "updateOwnLanguage", outcome: "unavailable" })
    await expect(
      runProviderAccountProfile(
        mock.api,
        { kind: "updateOwnActiveStatus", active: true },
        mock.authorize,
      ),
    ).resolves.toEqual({
      kind: "updateOwnActiveStatus",
      outcome: "unavailable",
    })
    expect(mock.lang).not.toHaveBeenCalled()
    expect(mock.active).not.toHaveBeenCalled()
    expect(mock.authorize).not.toHaveBeenCalled()
  })
})
