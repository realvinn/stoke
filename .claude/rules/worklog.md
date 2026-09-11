---
paths:
  - "src/main/agent.ts"
  - "src/main/worklog/*.ts"
  - "src/shared/worklog.ts"
  - "src/renderer/src/lib/worklogBoards.ts"
  - "src/renderer/src/components/Worklog*.tsx"
  - "scripts/verify-worklog-*.mts"
---

# Worklog agent

The Notion/ClickUp worklog: the hermetic scan, recall, closed statuses and the queue. Loaded when
a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are permanent — code
comments cite them as "CLAUDE.md gotcha N".

## 15. `--safe-mode` and MCP are mutually exclusive

**`--safe-mode` and MCP are mutually exclusive.** Safe mode switches every MCP server off,
so a run cannot both be hermetic and read a connector. That is why the worklog reads the
boards in a *separate* run (`recall.ts`) and keeps the scan itself hermetic.

## 16. A board's closed statuses are on none of its open tasks

**A board's closed statuses are on none of its open tasks.** Reading the tasks tells you
"open" and "in progress" and never "complete", so a status vocabulary inferred from them
can describe every state except the one a finished job needs. `clickup_get_list` is asked
for the list's own states separately, and only a status that came back from somewhere is
ever written.

## 17. The queue's dedupe key is load-bearing beyond dedupe

**The queue's dedupe key is load-bearing beyond dedupe.** Proposal ids are its sha1 and
rejections are tombstones keyed on it, so changing the key format for a `create` silently
resurrects every proposal the user has ever rejected. Updates got their own key shape
(`sessionId|update|board:id`) precisely so the create key could stay byte-for-byte.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The update key now also ends in the target status: `${sessionId}|update|${board}:${id}|${status}` (`dedupeKey`, src/main/worklog/queue.ts:113; composite form e.g. `s1|update|notion:x,clickup:y|done,done`). `dedupeKeys` (queue.ts:161-172) adds one per-record key of the same shape for each record named. The create key `${sessionId}|${flattened title}` (queue.ts:129) is unchanged.
> - `WorklogQueue.add()` never matches on stored ids. It recomputes every stored proposal's keys from that proposal's own fields: `seen` from `dedupeKeys(p)` (queue.ts:378) and `refused` from `dedupeKey({ sessionId, title })` (queue.ts:393-397). queue.ts:153-155 says nothing on disk stores a key. So if the create key were reformatted from the same (sessionId, title), it would still match every rejection, and only newly minted `id`s would differ from the stored ones. Rejections would come back only if the key started to depend on a field where a stored proposal and a new draft can differ. The suite comment at scripts/verify-worklog-runner.mts:1176-1181 ('the id itself, which is the thing the tombstone is actually keyed on') repeats the same wrong mechanism. The pin is still harmless.

## 30. Three separate things stopped the worklog ever marking anything done, and only one of them was in the write path

**Three separate things stopped the worklog ever marking anything done, and only one of them
was in the write path.** In likelihood order:

- **`formatRecall` blind-sliced the listing.** `clip(blocks.join('\n'), 2400)` against
  `MAX_RECALL_ITEMS = 30` at ~130 characters a line left roughly half the records standing,
  with the boundary line severed mid-id. That string is the *only* channel by which a board
  id reaches a scan — the scan is `--safe-mode` (gotcha 15) with no MCP server to look one
  up, and is told an id it cannot see does not exist — so a finished task below the cut came
  back as a duplicate **create** and the original stayed open. Nothing counted it: `demoted`
  only counts ids the model *did* name. The two caps must be reconciled or the smaller one
  silently decides how many records the scan can see; the budget is now per board, trims
  whole lines, and never trims the header, which carries the closed statuses.
- **The queue's update key ignored the status.** `sessionId|update|<record>` meant a
  session's first update took the record's key and every later one collapsed onto it — and
  the prompt asks for an update whenever an item was finished, started *or blocked*, so
  "started X" reliably consumed the key that "X is done" needed. Silently: `add` just
  `continue`s. Accepting the first does not release it either, since `accept` only patches
  `status` and `ProposalPatch` excludes `newStatus`. The status is in the key now; gotcha 17
  still holds, because the *create* key is untouched and rejections also contribute a
  title-based key (`queue.ts:368-372`).
- **Notion had no way to learn its own closed statuses.** `TOOLS_FOR.notion` held only
  `query-data-sources` and `search`, neither of which returns a schema, so "report every
  value its status property allows" was unanswerable and the vocabulary degraded to whatever
  appeared on the pages recalled. That is gotcha 16's ClickUp problem exactly, unfixed on
  the destination that ships as the default. `notion-fetch` is in both the recall allowlist
  and the update write list now — the write needs it too, because a page's status property
  can be called anything and `notion-update-page` has to name it.

Two smaller ones worth carrying: an out-of-vocabulary status was dropped with **no counter,
no log and no field**, so the note was written, the write returned ok, and the panel drew
"Written" over a task nobody had closed — from outside, "nothing needed closing" and "the
closing word was refused" were the same event. And the gate compared lowercased but stored
the model's spelling, so the live queue holds `{"notion":"COMPLETE"}` against a board that
spells it otherwise; `canonicalStatus` returns the board's own spelling now.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - Lines 368-372 of src/main/worklog/queue.ts are now the doc comment of `add()`. The rejection title-key logic is the `refused` set at queue.ts:393-397 (explained in the comment at 380-392), and it is checked at 418-422.
