import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = "packages/database/drizzle"
const hash = createHash("sha256")
for (const entry of readdirSync(root).sort()) {
  const path = join(root, entry, "migration.sql")
  try {
    const bytes = readFileSync(path)
    hash.update(`${entry}\0`)
    hash.update(bytes)
    hash.update("\0")
  } catch (error) {
    if (error.code !== "ENOTDIR" && error.code !== "ENOENT") {
      throw error
    }
  }
}
process.stdout.write(`${hash.digest("hex")}\n`)
