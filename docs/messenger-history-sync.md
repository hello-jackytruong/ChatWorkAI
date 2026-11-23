# Messenger history sync

Messenger coexist sync imports existing Page conversations in two phases: contacts first, then messages. The worker stores **365 days** of messages measured backwards from each conversation's `updated_time` (current time is the fallback when that field is missing). It also keeps at least the newest 100 usable messages even when they are older than the window. Messages outside the storage window may still be scanned for phone/email discovery within the existing discovery-page budget.

## Page settings

Open Settings → Channels → Messenger → Manage. The history section provides:

- **Skip accounts without a name**, on by default. Missing, empty and whitespace-only Facebook participant names are excluded before creating contacts, and their conversations are excluded from message import. Turn it off to import those accounts. Save the form to persist the preference, or start a sync to persist and use the current choice. Existing unnamed contacts are kept; live inbound messaging and Automatic Customer Scan are unchanged.
- A history sync toggle, which keeps the existing incremental behavior.
- **Sync history again**, which starts a full 365-day scan without the prior run's timestamp ceiling. This is how a Page previously synced with the 90-day limit imports the additional history. Existing messages are deduplicated by the historical importer. If a run is already active, the operation reuses it without resetting its progress; request a full scan after it finishes if needed.

An active chunk reads the saved skip preference when it starts. Changes made while a chunk is running take effect in later chunks. Sync availability remains subject to the existing Page permissions, provider responses and throttling.

## API, CLI and MCP

`messengerChannels.getSettings` returns `coexistSkipNamelessContacts`. Change it through `messengerChannels.patchSettings` or `messengerChannels.updateSettings`; omitted values preserve the saved preference for older clients.

`PUT /v1/messenger-channels/{id}/coexist` (`messengerChannels.setCoexist`) accepts:

```json
{
  "enabled": true,
  "skipNamelessContacts": true,
  "resyncHistory": true
}
```

Omit `skipNamelessContacts` to preserve the Page setting. Omit `resyncHistory` for incremental sync. These options apply to Messenger; Instagram and WhatsApp retain their existing behavior. The CLI and MCP derive these inputs from the public OpenAPI spec; refresh a cached CLI spec after deployment. Obtain the integration id from `messengerChannels.list`.

## Deployment

Apply the reviewed `add_messenger_skip_nameless_contacts` migration before deploying code that reads the new column. It adds `IntegrationMessenger.coexistSkipNamelessContacts` as `boolean DEFAULT true NOT NULL`, including existing Pages. No contacts or messages are deleted. Migration application requires explicit operator approval.

The full-scan choice is persisted as the run's `triggerSource = 'manual-full-history'`, so chunk continuations and scheduler retries retain it. Only the cross-run ceiling is bypassed; the run's own continuation frontier and normal ownership checks remain active.
