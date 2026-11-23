import { expect, it } from "vitest"
import { pathAndMethodToCommandName } from "../src/openapi-loader"

it("keeps all six Zalo media commands distinct", () => {
  const prefix = "/v1/zalo-accounts/{accountId}/media"
  const commands = [
    [prefix, "GET"],
    [`${prefix}/{referenceId}`, "GET"],
    [`${prefix}/{referenceId}/download`, "GET"],
    [`${prefix}/{referenceId}/retry`, "POST"],
    [`${prefix}/backfill`, "POST"],
    [`${prefix}/reconcile`, "POST"],
  ].map(([path, method]) =>
    pathAndMethodToCommandName(path as string, method as string),
  )
  expect(new Set(commands).size).toBe(6)
  expect(commands).toMatchInlineSnapshot(`
   [
     "zalo-accounts:media:list",
     "zalo-accounts:media:get",
     "zalo-accounts:download:list",
     "zalo-accounts:retry:add",
     "zalo-accounts:backfill:add",
     "zalo-accounts:reconcile:add",
   ]
 `)
})
