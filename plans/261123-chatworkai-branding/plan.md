# ChatWorkAI display branding

Status: complete. Lint, touched-workspace typechecks, 221 focused tests and invariant review passed.

Outcome: replace ChatbotX user-visible product text with ChatWorkAI, and inventory old chatbotx.io links for a separate user decision.

Constraints: preserve existing URLs, public identifiers, package names, environment variables, licenses and stored customer branding. Do not deploy or modify live data. Existing ChatWorkAI app assets are reused.

Acceptance:
- Update platform defaults, all shipped translations, customer-facing branding, CLI/MCP descriptions and current introductory docs.
- Preserve technical compatibility and white-label tenant overrides.
- Supply a grouped URL checklist with file/line references.
- Run lint, touched-workspace types, focused affected tests and invariant review; report any blockers.

Report: [Old links and remaining identifiers](reports/old-chatbotx-links.md).
