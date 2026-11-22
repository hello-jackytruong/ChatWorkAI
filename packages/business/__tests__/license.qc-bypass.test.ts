import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { LICENSE_FEATURES } from "../src/enterprise/license/schema"
import { mockLicenseRepository } from "./helpers/license"

describe("temporary Enterprise production QC license bypass", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("NEXT_PUBLIC_EDITION", "enterprise")
    vi.stubEnv("LICENSE_KEY", "")
    vi.stubEnv("LICENSE_REFRESH_ENABLED", "true")
    mockLicenseRepository()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock("@chatbotx.io/database/repositories")
  })

  test.each([
    "",
    "invalid-token",
  ])("starts and unlocks Enterprise without a verified license (%s)", async (token) => {
    vi.stubEnv("LICENSE_KEY", token)
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never)
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const { assertLicenseAtStartup } = await import(
      "../src/enterprise/license/startup"
    )
    const { hasEnterpriseFeatures, assertEnterpriseFeatures } = await import(
      "../src/user/entitlements"
    )
    const { getLicenseStatus, getLimit, hasFeature } = await import(
      "../src/enterprise/license/service"
    )
    const { refreshLicense } = await import("../src/enterprise/license/refresh")

    await expect(assertLicenseAtStartup()).resolves.toBeUndefined()
    expect(exitSpy).not.toHaveBeenCalled()
    await expect(hasEnterpriseFeatures()).resolves.toBe(true)
    await expect(assertEnterpriseFeatures()).resolves.toBeUndefined()
    for (const feature of LICENSE_FEATURES) {
      await expect(hasFeature(feature)).resolves.toBe(true)
    }
    for (const limit of ["maxWorkspaces", "maxSeats", "maxChannels"] as const) {
      await expect(getLimit(limit)).resolves.toBeNull()
    }
    await expect(refreshLicense()).resolves.toEqual({
      status: "skipped",
      reason: "disabled",
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    // QC access must never pretend a missing or invalid token was verified.
    await expect(getLicenseStatus()).resolves.toMatchObject({
      state: token ? "invalid" : "missing",
    })
  })

  test.each([
    "community",
    "cloud",
  ])("keeps the license gate for %s", async (edition) => {
    vi.stubEnv("NEXT_PUBLIC_EDITION", edition)
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never)
    const { assertLicenseAtStartup } = await import(
      "../src/enterprise/license/startup"
    )
    const { hasEnterpriseFeatures, assertEnterpriseFeatures } = await import(
      "../src/user/entitlements"
    )
    const { hasFeature } = await import("../src/enterprise/license/service")

    await assertLicenseAtStartup()
    if (edition === "cloud") {
      expect(exitSpy).toHaveBeenCalledWith(1)
    } else {
      expect(exitSpy).not.toHaveBeenCalled()
    }
    await expect(hasEnterpriseFeatures()).resolves.toBe(false)
    await expect(hasFeature("sso")).resolves.toBe(false)
    await expect(assertEnterpriseFeatures()).rejects.toMatchObject({
      code: "enterpriseFeatureRequired",
    })
  })
})
