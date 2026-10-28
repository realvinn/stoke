# Stats in Stoke: proposal to approve

## Approved 2026-10-28

The owner approved this design on 2026-10-28, with the recommended answer to each of §6's three
questions:

1. **Lines by agents count every Claude Code and Codex session on each computer**, including ones
   started outside Stoke, back-filled from the transcripts that survive.
2. **Sharing between computers is on by default**, with a switch in Settings › Account & sync.
3. **A removed computer's past totals are kept**, greyed and labelled "removed".

It is built in §5's three slices. Slice 1 (this computer, desktop only) is planned in
`docs/superpowers/plans/2026-10-28-stats-slice1-this-computer.md`; slices 2 and 3 get plans of their own.

Key `stats-design`, research only, 2026-10-28. No repo file was changed. Built on `stats-sources.md`.
"Measured here" means this Mac's real transcripts over the last 30 days, counted read-only.

**In short:** a **Stats** tab with four headline numbers and a stacked bar chart, one colour per
computer. It goes in the desktop's side dock, on the phone page and on the account website.
- Each computer counts its own numbers.
- Each computer seals one small item per month on the Hub, and every computer adds them all up.
- Three computers left on all day show **72 h**.

---

## 1. Where it lives

- **Desktop:** a new **Stats** tab, first in the side dock: `[Stats] Activity  Work boards`.
  - The title bar's Activity button opens the dock as it does today, now on Stats.
  - It is a dock column, so the docked browser never hides it (gotcha 14). It needs no new tab kind (gotcha 150).
  - It has no worklog gate. Today's Activity panel lists only projects the worklog watches. On this Mac that is
    none, so the panel is empty. It also misses subagent and workflow edits, which are **91 %** of this Mac's
    Claude lines over 30 days. Activity stays as it is.
- **Phone, through a computer's own link:** a **Stats** button on the sessions list. That computer
  answers from its own records.
- **Account website (stoke.vinn.dev/remote):** yes, the same screen.
  - A paired phone is a guest on the account (`remote-guest`, never `vault`). It cannot unseal the stats itself.
  - So every online computer adds a small summary to the sealed status it already sends: about 3–4 KB
    (30 days plus 12 months, per computer). The status limit is 24 KiB, and older Stokes ignore fields they do
    not know.
  - The phone keeps the last copy and shows "as of 14:02". With every computer off, it shows that copy.
- The dock is 340 px wide, about a phone's width, so **one layout serves both**. Numbers below are made up for
  the picture.

Phone, and the dock's content:

```
 ‹ Computers                    Stats
 ─────────────────────────────────────
  [7 d] [30 d] [12 mo]   All computers ▾

  Stoke open            Lines by agents
  1,272 h               +248k
  3 computers           −11k removed

  Agents working        Streak
  96 h · 1.2× at once   3 days · best 11
 ─────────────────────────────────────
  (Stoke open)   Agents   Lines

  72 ┤                      ░
     ┤         ░      ░     ░
  48 ┤░░░░    ░░░ ▒░░░░░▒ ░░▒░░  ░░
     ┤▒▒▒▒    ▒▒▒ ▒▒▒▒▒▒▒ ▒▒▒▒▒  ▒▒
  24 ┤██████░░█████████████████████▒
     ┤██████▒▒██████████████████████
   0 ┼──────────────────────────────
      29 Sep                 today ↑
                            so far
  █ Mac mini (this one)   660 h
  ▒ MacBook Pro           324 h
  ░ Windows PC            288 h
                          Show table
```

Desktop, showing where it sits:

```
┌────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  stoke › beta     Claude · stoke  +           ⌕  [Activity]  ⚙   │
├───────────┬──────────────────────────────────┬─────────────────────────┤
│ PROJECTS  │ ╭ Claude Code ─────────────────╮ │ [Stats] Activity  Work  │
│ ▸ stoke   │ │ >                            │ │ [7 d] [30 d] [12 mo]    │
│ ▸ hub     │ │                              │ │ Stoke open   Lines      │
│           │ │                              │ │ 1,272 h      +248k      │
│           │ ╰──────────────────────────────╯ │ … the phone layout,     │
│           │                                  │   340 px wide           │
└───────────┴──────────────────────────────────┴─────────────────────────┘
```

---

## 2. The numbers, exactly

**Stoke open (the uptime you asked for)**
- Each computer counts the minutes Stoke is running while the computer is awake. Sleep does not count; a
  locked screen does.
- It ticks once a minute. Each tick books at most 2 minutes, so a crash or a missed sleep can never add hours.
- The figure is summed over every computer on the account.
- Each computer books its own local day, and the chart adds days by date.
- Only the installed, signed-in Stoke reports. The dev build and test sandboxes never add hours, and neither
  does a paired phone.

**Agents working**
- Minutes when at least one agent tab was busy, from the 1-second busy poll and the hooks.
- Also "agent-hours", the sum over tabs. Their ratio is the "× at once" figure.
- Measured here: 78.6 h busy and 92.3 h of agent-hours in 30 days, so **1.17× at once**.

**Lines by agents**
- Counts the lines that Claude Code and Codex wrote into files, taken from each edit's own patch.
  - Each edit counts once, by its tool-call id.
  - Subagents and workflows are included.
  - A whole-file write counts every line it wrote.
  - "Removed" is the smaller second figure.
- It does **not** count:
  - hand typing;
  - `sed`, scripts or codegen run through Bash;
  - other agents (OpenCode, Cline and Zed have no edit parser yet);
  - private chats.
- An SSH tab is counted by the computer it ran on, and only if that computer runs Stoke, so nothing is counted
  twice.
- The wording stays "lines by agents", never "lines in your repo". Per-repo git numbers can sit beside it on the
  computer being viewed, never summed: the same repo on three computers would triple them.
- Measured here: **+213,993 / −9,543 in 30 days** (Claude +184,890 / −6,221 and Codex +29,103 / −3,322), and
  +46,942 / −1,641 in 7 days.

**Streak**
- Days in a row with any agent work. Measured here: 22 of 30 days were active, with a current streak of 3 and a
  best of 11.

**What history appears on day one**
- Lines and agent time are back-filled from the transcripts each computer still has. Here they go back to 9 July.
- Uptime starts the day this ships, because nothing recorded it before.

### The graph

- **Form:** stacked columns, one per day for 7 d and 30 d, and one per month for 12 mo.
  - The pieces are computers, stacked in the order each one joined the account. A computer keeps its colour and
    its place whatever else is on or off.
- **Y axis:** hours. A gridline every 24 h means "one computer, all day".
  - The axis tops out at 24 h × the number of computers, so a full column means every computer was on all day.
  - The 12 mo view does the same per month.
- **Lines and Agents** use the same chart through the toggle. Each has its own single axis; two scales never
  share one chart.
- **A computer that was off** gets no piece that day, so the column is shorter. Tapping the column shows "off".
- **A computer that has not synced** has its missing days marked "not synced", never 0. The legend shows "last
  synced 3 h ago".
- **Before a computer started counting**, nothing is drawn and the readout says "not counting yet".
- **Today's column** is labelled "so far".
- **Tap, hover or keyboard focus** on a column shows every computer's value, with the value first. "Show table"
  lists every number, so nothing depends on colour or on the tap readout.
- **What "72 h for 3 computers" looks like** is the full column on Wed 21 Oct above. Beside it is a day the
  Mac mini was off:

```
 ┌ Wed 21 Oct ───────── 72 h ┐
 │ █ 24 h  Mac mini          │
 │ ▒ 24 h  MacBook Pro       │
 │ ░ 24 h  Windows PC        │
 └───────────────────────────┘
 ┌ Mon 5 Oct ────────── 24 h ┐
 │ █ off   Mac mini          │
 │ ▒ 12 h  MacBook Pro       │
 │ ░ 12 h  Windows PC        │
 └───────────────────────────┘
```

**Colours** (done the dataviz way)
- New per-theme tokens, `--series-1…4` and `--series-other`, made by the theme generator. Components never use a
  hex.
- Each theme's dock surface is checked by the dataviz validator inside `verify:theme-gen`.
- I ran the reference palette's first four colours against the default dock surfaces:
  - **Ember (dark):** every check passes. The worst colourblind separation is ΔE 8.4.
  - **Daylight (light):** it passes the colourblind checks, but three colours are under 3:1 contrast. The
    legend totals and the table view (both in the design) are the required relief.
- With 5–7 computers, the legend and the readout carry who is who. An 8th computer and beyond fold into "Other".
- **Marks:** thin columns (about 7 px at 30 days in a 340 px dock), a 2 px gap between pieces, 4 px rounded tops
  and solid hairline gridlines.
- **Motion:** none, so reduced motion looks the same.

---

## 3. Sync, privacy and storage

- **Stays on each computer**, in `userData/stats/` (never `settings.json`, gotcha 63):
  - the detailed ledger, including minute-by-minute on/off maps;
  - numbers per project (by folder name);
  - per-repo git lines and the count of files touched.
- **Synced:** each computer seals **its own month** as one item, `t6/stats/<computer>/<YYYY-MM>`.
  - It holds about 11 numbers per day: the three time figures, lines ±, prompts, sessions, and tokens in and
    out.
  - It is written hourly, at midnight and on quit.
  - Only its owner writes it. The others read it, add it up, and keep a local copy, so a Hub hiccup never blanks
    the chart.
- **What the Hub sees:** one encrypted blob per computer-month, its size, and when it was saved. No numbers,
  names or paths.
- **Privacy defaults:**
  - Counting is on and stays local.
  - Sharing with your other computers is on when signed in, with a switch in Settings › Account & sync.
  - Project names never sync.
  - Private chats are never counted.
  - A "Reset stats" button clears this computer's ledger and its items.
- **Storage:**

| Synced item contents | Per computer-month | Per computer-year | 3 computers × 10 years |
|---|---|---|---|
| Daily counters | 2.6 KB | 31 KiB | 1.1 MiB, about 4 % of the 25 MiB cap |
| + hour-of-day counts (for the heatmap) | 5.5 KB | 64 KiB | 1.9 MiB, about 8 % |

  That is 12 items per computer per year, against the 5,000-item cap. The whole Hub holds 4.4 MB today. The
  local ledger is about 0.5 MiB per year.
- **One trap with older Stokes (beta.20 and earlier):** removing a computer from an older Stoke, or re-keying
  the account there, deletes every stats item from the Hub. The older Stoke re-saves only the items it
  understands.
  - The fix: each computer re-uploads its own months, and on first run it re-reads everything once.
  - Because every computer also keeps its local copy, nothing is lost.
  - To be safe, update every computer before removing one.

---

## 4. More stats

Build first, best value for least work. All of these reuse signals Stoke already has.

| # | Stat | Measured here (30 d) |
|---|---|---|
| 1 | **Agents working + "× at once"** (in the headline) | 78.6 h busy, 1.17× |
| 2 | **Streak** (in the headline) | current 3, best 11 |
| 3 | **Busiest hours heatmap**, weekday × hour, shaded from light to dark in one colour | peak 14:00–16:00; top slot Fri 16:00 |
| 4 | **Prompts, sessions, subagents and workflows run** | ≈508 prompts, 26 sessions, 455 subagent runs |
| 5 | **Tokens and models** | 16.7 M tokens out, 9.76 B cache reads; Opus 5.5 wrote 91 % of replies |
| 6 | **Marathon**: the longest single session | 25.4 h of agent time in one session; one tab open 12.3 days |
| 7 | **Top projects** by lines or time, shown on this computer only | — |

Skip, and why:
- **Notional API cost.** It reads like a bill you do not pay on a plan.
- **Commits and git lines summed across computers.** The same repo on three computers triples them. They stay a
  per-repo note on one computer.
- **Files touched.** Mostly scratch files, and the paths must never leave the computer.
- **Tool calls by type.** 73 % of them are Bash, so the stat says little, and MCP server names can reveal what
  you work on.
- **"You at the keyboard" time.** It needs idle thresholds and starts to feel like surveillance. Add it later if
  you want it.
- **Uptime counted by the Hub from connections.** It is not end-to-end encrypted, it misses offline use, and it
  needs a change on the NUC.
- **Cache hit ratio, plan-limit history, crash-free days.** These are niche; they belong in Usage or Diagnostics.

---

## 5. Build plan

1. **This computer (ships first, desktop only)**
   - The ledger:
     - Stoke open, agents working, lines ±, prompts and sessions.
     - A once-a-minute tick, a sleep and crash cap, a midnight split, and a flush on quit.
   - An incremental transcript reader in the chat-history worker:
     - It reads only new bytes, de-duplicates by tool-call id, covers subagents and Codex, and skips private
       chats.
     - It back-fills from the surviving transcripts.
   - The Stats tab: tiles, a one-computer chart (one colour, no legend), 7 d / 30 d / 12 mo, and the table view.
   - The theme series tokens and their validator check.
   - Tests: a `verify:stats` suite for the counting, plus a window suite that takes a screenshot.
2. **All computers**
   - The monthly sealed items, the local copy of the other computers' months, the re-upload rule and the
     one-time re-read.
   - The Settings switch.
   - The stacked per-computer chart, with the legend, the off and not-synced states, and the 72 h view.
   - Hub path checks in `verify:hub` and `verify:hub-client`. No change to the Hub server.
3. **Phone and extras**
   - The Stats screen on the phone page (from its computer) and on the account website (through the sealed
     status).
   - The heatmap. It adds the hour counts, which takes an item from 2.6 KB to 5.5 KB.
   - Tokens and models, the marathon, prompts and sessions, and top projects (this computer only).

---

## 6. Three questions for you

1. **Which sessions count toward "lines by agents"?**
   **Recommended: every Claude Code and Codex session on each computer,** including ones started in a plain
   terminal.
   - It back-fills months of history. "Stoke tabs only" cannot look back before the day this ships.
   - It is where you work anyway.
2. **Should stats be shared between your computers by default?** Only counts would be shared, sealed so the Hub
   cannot read them.
   **Recommended: yes, on by default,** with a switch in Settings › Account & sync. Project names stay on each
   computer.
3. **When you remove a computer from the account, should its past hours and lines stay in the totals?**
   **Recommended: keep them,** greyed and labelled "removed", so all-time numbers never drop.

---

Not yet confirmed:
- Your account lists 4 devices and you said 3. The fourth is probably the paired phone, which is a guest. Only
  computers running Stoke count, so the totals are right either way.
- How many of the subagents' whole-file writes replaced an existing file. Those count every line, as "written".
