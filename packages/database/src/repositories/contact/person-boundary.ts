/** Customer operations cannot address a channel-owned group anchor. */
export const personContactWhere = <T extends Record<string, unknown>>(
  where: T,
) => ({
  AND: [where, { kind: "person" as const }],
})
