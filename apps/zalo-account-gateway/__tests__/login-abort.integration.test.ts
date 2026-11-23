import { expect, it, vi } from "vitest"
import { ZcaClient } from "../src/runtime/zca-client"

it("aborts the pinned SDK request before the first QR callback and settles login", async () => {
  let signal: AbortSignal | null | undefined
  const fetcher = vi.fn((_input, init) => {
    signal = init?.signal
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      )
    })
  }) as unknown as typeof fetch
  const client = new ZcaClient(fetcher)
  const callback = vi.fn()
  const login = client.loginQr(callback)
  const rejected = expect(login).rejects.toBeDefined()
  await vi.waitFor(() => expect(signal).toBeDefined())
  await client.cancel()
  await rejected
  expect(signal?.aborted).toBe(true)
  expect(callback).not.toHaveBeenCalled()
})

it.each([
  "logininfo",
  "verify-client",
  "generate",
  "scan",
  "confirm",
])("aborts and settles the pinned SDK during %s", async (stage) => {
  let signal: AbortSignal | null | undefined
  const fetcher = vi.fn((input, init) => {
    const url = String(input)
    if (url.includes(stage)) {
      signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )
      })
    }
    if (url.includes("/account?")) {
      return Promise.resolve(
        new Response("https://stc-zlogin.zdn.vn/main-1.2.js"),
      )
    }
    if (url.endsWith("/generate")) {
      return Promise.resolve(
        Response.json({ data: { code: "test", image: "QUJD" } }),
      )
    }
    if (url.endsWith("/waiting-scan")) {
      return Promise.resolve(Response.json({ data: { display_name: "Test" } }))
    }
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  const client = new ZcaClient(fetcher)
  const login = client.loginQr(vi.fn())
  const rejected = expect(login).rejects.toBeDefined()
  await vi.waitFor(() => expect(signal).toBeDefined())
  await client.cancel()
  await rejected
  expect(signal?.aborted).toBe(true)
})
