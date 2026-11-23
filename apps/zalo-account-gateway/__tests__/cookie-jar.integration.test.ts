import { expect, it, vi } from "vitest"
import type { API } from "zca-js"
import { getCookieFactory } from "../node_modules/zca-js/dist/apis/getCookie.js"
import { loginQR } from "../node_modules/zca-js/dist/apis/loginQR.js"
import {
  type ContextSession,
  createContext,
} from "../node_modules/zca-js/dist/context.js"

it("exposes SDK HTTP cookie mutations through its real getCookie factory", async () => {
  const context = createContext()
  context.options.logging = false
  context.options.polyfill = vi.fn((input) => {
    const url = String(input)
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
    if (url.endsWith("/waiting-confirm")) {
      return Promise.resolve(
        Response.json(
          { error_code: 0 },
          {
            headers: {
              "set-cookie":
                "zpw=test-rotated; Domain=.zalo.me; Path=/; Secure; HttpOnly",
            },
          },
        ),
      )
    }
    if (url.endsWith("/userinfo")) {
      return Promise.resolve(
        Response.json({ data: { logged: true, info: { name: "Test" } } }),
      )
    }
    return Promise.resolve(Response.json({}))
  }) as typeof fetch
  const result = await loginQR(context, { userAgent: "test-agent" }, vi.fn())
  expect(result?.cookies).toContainEqual(
    expect.objectContaining({ key: "zpw", value: "test-rotated" }),
  )
  const session = Object.assign(context, {
    secretKey: "test-key",
  }) as ContextSession
  const getCookie = getCookieFactory(session, {} as API)
  expect(getCookie()?.serializeSync()?.cookies).toContainEqual(
    expect.objectContaining({ key: "zpw", value: "test-rotated" }),
  )
})
