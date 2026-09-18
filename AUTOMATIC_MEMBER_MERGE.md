# Automatic member merge design

## Existing behavior preserved

- Members are keyed by normalized Singapore mobile number.
- Google Form rows are read before Raklet rows.
- When both sources contain the same mobile, Form name, email and mobile win unless blank; the record is marked as coming from both sources.
- Existing Telegram and administrator fields are preserved by normalized mobile.
- A manual `Raklet Sync + Merge` still forces a full rebuild.

## Request lifecycle

The verification worker creates one merge request after it writes a non-empty batch to `verification_cache`. The request contains a timestamped UUID. The Apps Script trigger compares `requested_token` with `completed_token`.

- Equal tokens: no work is pending, so the trigger exits.
- Different tokens: a full rebuild runs.
- A newer token arriving during a rebuild remains different from the captured completed token, so it is handled by the next trigger.
- Several submissions before the next trigger can share one rebuild because the rebuild reads the complete source sheets.
- If there are no requests, a recovery rebuild runs once six hours have elapsed since the last successful rebuild.

## Failure behavior

- Apps Script uses a script lock, so only one rebuild can run at a time.
- A failed rebuild clears its active marker, records the error, and leaves the request incomplete for retry.
- The worker requests a merge only after cache writes succeed.
- The original six-hour flow can be restored from the backup branch without deleting the control sheet.

## Production gate

Do not deploy this branch until the membership bot honors the active merge marker and re-resolves the destination row immediately before writing Telegram fields. Unit tests cover request coalescing and arrivals during a rebuild; the final integration test must cover a Telegram link attempted during a rebuild.
