import { createServer, type Server, type ServerResponse } from "node:http"

const write = (response: ServerResponse, status: number, body: object) => {
  const json = JSON.stringify(body)
  response.writeHead(status, {
    "Content-Length": Buffer.byteLength(json),
    "Content-Type": "application/json; charset=utf-8",
  })
  response.end(json)
}

export const createGatewayServer = (options: {
  isReady: () => boolean
}): Server =>
  createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname
    if (request.method === "GET" && path === "/healthz") {
      write(response, 200, { status: "healthy" })
      return
    }
    if (request.method === "GET" && path === "/readyz") {
      const ready = options.isReady()
      write(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
      })
      return
    }
    write(response, 404, { error: "not_found" })
  })
