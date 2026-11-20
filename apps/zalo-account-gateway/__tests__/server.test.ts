import { request } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { createGatewayServer } from "../src/server"

const get = (port: number, path: string) =>
  new Promise<{ body: string; status: number }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
        }),
      )
    })
    req.on("error", reject)
    req.end()
  })

describe("gateway health server", () => {
  const servers: ReturnType<typeof createGatewayServer>[] = []
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    )
  })

  it("keeps liveness independent while readiness reflects dependencies", async () => {
    let ready = false
    const server = createGatewayServer({ isReady: () => ready })
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    )
    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("no address")
    }

    await expect(get(address.port, "/healthz")).resolves.toMatchObject({
      status: 200,
    })
    await expect(get(address.port, "/readyz")).resolves.toMatchObject({
      status: 503,
    })
    ready = true
    await expect(get(address.port, "/readyz")).resolves.toMatchObject({
      status: 200,
    })
  })
})
