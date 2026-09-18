# TLKP Member Merge Apps Script

Source captured from Google Apps Script project `TLKP Member Merge` on 18 September 2026. The backup before automatic-merge work is commit `2a6f7d1862d9d627f5a66fcb6cdc7bd25b762d41` on branch `backup/member-merge-appscript-20260918`.

- Apps Script project ID: `1MXgzPc0f63-cxUjWfoRNMuXoOTO7WIa5RSGXGIV3zzshPSJ7du0CxrC2`
- Persistent trigger: `mergeMembersTrigger`
- Trigger type: time-driven, every 6 hours
- Latest inspected execution: 18 September 2026 06:44:40 SGT
- Latest inspected result: completed in 23.208 seconds; 4,213 master members and 177 exceptions

Script properties, credentials, form responses, Raklet data and member data are intentionally excluded.

## Proposed request-driven merge

This branch adds a lightweight `_member_merge_control` sheet shared by the verification worker and Apps Script:

1. The verification worker finishes a batch of new or edited Google Form rows.
2. It writes a unique request token to the control sheet.
3. A five-minute Apps Script trigger calls `mergeMembersTrigger`.
4. The trigger runs the existing full Form/Raklet merge only when a request is pending. It otherwise exits after reading one row.
5. A six-hour recovery run still occurs if no successful merge has completed in that period.

The script lock prevents two Apps Script rebuilds from overlapping. The completed token records the request captured at the start of a rebuild. If another request arrives while that rebuild is running, the new token remains pending and the next trigger performs another rebuild. Multiple requests before a trigger are deliberately coalesced because a full rebuild includes all Form and Raklet rows available when it starts.

`Code.gs` is the canonical definition of the merge functions. `raklet_api_test.gs` used to contain an exact duplicate; it is now a placeholder to prevent duplicate global function definitions.

## Required safety work before production

The Telegram membership bot writes `telegram_id`, `telegram_username`, `role`, and `notes` in `members_master`. The current full rebuild reads those columns, clears the sheet, and writes them back. A bot write during that interval can therefore be lost even though Apps Script rebuilds are locked.

Before deployment, the membership bot must coordinate with `_member_merge_control`: wait while `active_token` is present, then resolve the member row again by normalized mobile immediately before writing. This behavior needs an integration test that pauses a rebuild, attempts a Telegram link, resumes the rebuild, and confirms the link remains in the final sheet.

## Rollout and rollback

After the Telegram write guard is complete and tested:

1. Upload this Apps Script version.
2. Change the `mergeMembersTrigger` time-driven trigger to every five minutes.
3. Deploy the matching verification-worker and membership-bot changes.
4. Submit one test form edit and verify one merge runs, the request token completes, and a later empty trigger skips.
5. Keep the six-hour recovery behavior enabled.

Rollback restores the Apps Script files from commit `2a6f7d1862d9d627f5a66fcb6cdc7bd25b762d41`, restores the six-hour trigger, and deploys the prior worker/bot versions. The control sheet is inert under the old code and may remain in place during rollback.
