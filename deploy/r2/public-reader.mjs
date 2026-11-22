// Keep the bucket private. Only keys explicitly in public/ can be read here.
export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      })
    }
    let key
    try {
      key = decodeURIComponent(new URL(request.url).pathname.slice(1))
    } catch {
      return new Response(null, { status: 400 })
    }
    if (
      !key.startsWith("public/") ||
      key.split("/").some((s) => s === ".." || s === ".") ||
      key.includes("\\")
    ) {
      return new Response(null, { status: 404 })
    }
    const object =
      request.method === "HEAD"
        ? await env.MEDIA.head(key)
        : await env.MEDIA.get(key, {
            range: request.headers,
          })
    if (!object) {
      return new Response(null, { status: 404 })
    }
    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set("ETag", object.httpEtag)
    headers.set("Access-Control-Allow-Origin", "*")
    headers.set("X-Content-Type-Options", "nosniff")
    headers.set("Accept-Ranges", "bytes")
    // Media may be deleted or replaced. Do not cache indefinitely.
    headers.set("Cache-Control", "public, max-age=300")
    if (request.method === "HEAD") {
      headers.set("Content-Length", String(object.size))
      return new Response(null, { headers })
    }
    if (object.range && object.size > 0) {
      const offset =
        object.range.offset ??
        Math.max(0, object.size - (object.range.suffix ?? object.size))
      const length = Math.min(
        object.range.length ?? object.range.suffix ?? object.size,
        object.size - offset,
      )
      headers.set(
        "Content-Range",
        `bytes ${offset}-${offset + length - 1}/${object.size}`,
      )
      headers.set("Content-Length", String(length))
      return new Response(object.body, { status: 206, headers })
    }
    headers.set("Content-Length", String(object.size))
    return new Response(object.body, { headers })
  },
}
