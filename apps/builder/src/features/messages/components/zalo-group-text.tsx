import { splitZaloMentions } from "@/features/zalo-accounts/lib/group-content"
import { ZaloMemberIdentity } from "./zalo-member-identity"

export function ZaloGroupText({
  text,
  mentions,
}: {
  text: string
  mentions: ReadonlyArray<{ uid: string; offset: number; length: number }>
}) {
  return splitZaloMentions(text, mentions).map((part) =>
    part.uid ? (
      <ZaloMemberIdentity key={`${part.offset}-${part.uid}`} uid={part.uid}>
        <mark className="rounded bg-primary/15 text-inherit">{part.text}</mark>
      </ZaloMemberIdentity>
    ) : (
      part.text
    ),
  )
}
