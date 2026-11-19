/** Splits `items` into arrays of at most `size`; `chunk([1,2,3], 2)` is `[[1,2],[3]]`. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}
