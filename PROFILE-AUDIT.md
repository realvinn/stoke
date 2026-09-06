# Profiles audit (0.9.3)

Trong said profiles “don’t feel so right” without naming a bug. This is
diagnosis, not a redesign. A profile stays a **view filter, never access
control**.

The only code change in this PR is the sidebar empty state when a selected
profile has no projects yet (it used to quote an empty search). Everything
else is a recommendation.

## 1. How profiles work today

A profile is a coloured chip that filters the sidebar to projects whose
`Project.group` matches. `group` is the parent folder’s basename
(`basename(dirname(projectPath))`). That is the whole membership rule —
there is no per-project override, no access gate, and the worklog does
not read the chip.

Two lists are merged in `resolveProfiles`:

1. **Derived seed.** Named folders `personal` / `school` / `work` / `side`
   become Personal, Study, Work, Side whenever they exist (even with one
   project). Any other parent folder with **more than one** project becomes
   an extra chip, capped at four, with a fallback colour. A lone repo in
   Documents is not a category.
2. **Stored records** in `Settings.profiles`. User create / rename /
   recolour / delete live here. They win, and they survive a machine that
   does not have those folders. Deleting a *derived* chip writes a
   tombstone (`groups: []`) so the folder layout cannot resurrect it;
   deleting a *user-made* record just drops it.

`visibleProfiles` then hides anything whose groups have no projects *and*
no matching scan root — so a just-created empty folder still gets a chip.

**Create** is name + location, and the name decides the folder:

- `G:/Code` + `Task` → create `G:/Code/Task` (empty).
- `G:/Code/Task` + `Task` → reuse it, import its subfolders.
- An existing child of that name is reused (no `Task/Task`).

Adopting the picked folder just because it already holds projects was
tried and removed: picking `G:/Code` and naming it `Task` would have
made the profile cover every project on the machine. Imports are a
consequence of the root, never a reason to pick a different one.

**The chip is not the only writer of the selection.** The active tab
follows its cwd into a profile (`profileIdForCwd` in App). Colour, filter,
status-bar pill and terminal cursor all move with it. Clicking All is
undone the next time you activate a tab that belongs to a profile. An
SSH tab and a folder no profile owns leave the chip where it is.

**Worklog** stores `worklogGroups` (folder names), not profile ids, and
never sees `activeProfile`. The Settings checkboxes are a face over that
list. That split is load-bearing (gotcha 18 / PLAN): a Work session must
still be watched while you browse Personal.

## 2. Why they feel off

The feature is internally consistent and well tested. The smell is that
**one chip is doing three jobs**, and the product copy does not agree
with itself about which job is the point.

### The chip is a mode, not a filter you hold

PLAN and the original ask: *“I should choose it manually.”* The sidebar
treats a press as a view filter. App then overwrites that choice from
the active tab, and the status bar’s tooltip says so:
`follows the folder of the tab in front`.

So: pick All → click a Work tab → the list collapses to Work and the
chrome turns green. Pick Study → the lecture folder’s tab is in the
background → the chip jumps back. The only way to *keep* All is to not
activate a project tab.

That is the highest-leverage mismatch with “view filter.” A filter you
cannot hold is a mode. Combined with Personal’s accent being Ember’s own
`#ff9552`, “did I switch?” is often answered by the list disappearing
rather than by colour.

### Three written definitions

| Place | A profile is… |
| --- | --- |
| `src/shared/profiles.ts` | a view filter, nothing more |
| `Settings.profiles` comment | a colour, and a worklog switch |
| Settings → Profiles hint | a colour and a folder |
| Settings nav | “Per-folder colours and scan roots” (under Appearance) |
| Status bar | the folder of the tab in front |

None of these is false in isolation. Together they teach three products.
Settings lives under Appearance because the visible effect is paint;
the folder half is “the half nobody comes looking for”
(`SettingsSheet.tsx`). Create, delete, and “why is this chip here?”
are the half people actually come looking for.

### Derived chips arrive unasked

On a machine that has never opened Settings, chips appear because
folders exist. That is the right zero-config seed, and it is also how
a `scratch` group (two dated folders under userData) or a `Code` group
(every repo parked in one parent) becomes a chip the user never named.

Named seeds still encode one desk: `school` is labelled **Study**, so a
real folder called `study` is claimed as a duplicate word and **does not
get a chip**, while the Study chip still filters on `school`. Projects
under `~/study` only show under All. The 0.4.0 `gitea-company` → `work`
rename was this class of bug; `school`/`Study` is the leftover.

User-made profiles and derived extras use different visibility rules
(one project is enough if you created it; extras need two). Settings
says “once a scanned folder holds more than one project,” which is
only true of the extras path.

### Create does what PLAN settled, not what the sentence still says

The original ask and PLAN’s summary still read: *if the chosen folder
contains project subfolders, import them all.* The implementation
deliberately does not, when the name does not match that folder. The
preview is honest (`Create G:/Code/Task. It starts empty…`). The
disappointment is: pick a folder full of repos, type a name, get an
empty child and a chip that filters to nothing.

After create, the new profile is **not** selected. You stay on All (or
whatever the active tab then follows). Combined with the old empty-state
copy, “Create and nothing happened” is still the easy reading.

You also cannot point an existing profile at a different folder, or add
a second group, in the UI. `groups: string[]` exists; the editor only
renames and recolours. Worklog already has the “partial groups” checkbox
state for a case the profile pane cannot produce.

### Worklog is per-group, presented as per-profile

Correct, and easy to misread. “Watch Work” writes `worklog`. Deleting
or tombstoning the Work chip leaves that group watched (orphans are
shown). Renaming the chip does not rename the group. A derived Study
chip and a user-made “Uni” chip that both cover `school` are one
watch switch. None of this is a gate bug; it is why “per profile”
in the original ask and “per group” in the gate feel like two features.

### Historical footguns — current state

| Old note | Now |
| --- | --- |
| Create / rename / recolour / delete “planned or rendered, never committed” | **Committed.** `profiles:create` writes the record + scan root; the editor patches `settings.profiles`. PLAN.md’s unverified-list line is stale. |
| `App` resolved against static `PROFILES`, sidebar derived its own | **Fixed.** One `resolveProfiles` → `visibleProfiles` list. |
| `gitea-company` / `gitea-vibe` labelled Work / Side | **Renamed** on hydrate to `work` / `side`; stored `groups` left alone so old folders still match. |
| Derived accent never painted | **Fixed.** `applyAppearance` + `deriveAccent` (gotcha 44). Personal-on-Ember is still a no-op by design. |

## 3. Ranked improvements

### P0 — stop the chip and the tab fighting

**Why.** This is the daily “off.” The settled rule is view filter.
Tab-follow makes the filter a slave of the front tab, so All is
unstable and switching conversations rewrites the project list and the
chrome.

**Do (pick one; this needs Trong):**

1. **Chip is the filter; tab does not move it.** Colour may still
   follow the tab (status-bar pill already names the profile). Effort:
   small (delete or gate the effect in `App.tsx` ~767). Risk: low.
   Closest to “I choose it manually.”
2. **Split the two.** Chip = filter (sticky, including All). A quieter
   indicator (status pill only, or a tab glyph) = “this session’s
   folder.” Effort: small–medium. Risk: low. Best match for “view
   filter” *and* “I can see where I am.”
3. Keep follow, but **do not let it leave All** (only move from one
   named profile to another). Effort: tiny. Risk: low. Half measure;
   All becomes the one holdable filter.

Do not make the worklog read the chip. That would break the settled
gate.

### P0 — empty profile state *(done in this PR)*

Selecting a chip with no matching projects used to render the search
miss: *Nothing matches* / *contains “”*. After create, that is the
first thing you see if you click the new chip. Copy now says the
profile is empty and points at Open / All.

### P1 — create should land on the new profile

**Why.** Create writes a chip and leaves you on All, then tab-follow
may paint a different profile. The user asked to *choose or create*.
Effort: small (`createProfile` already returns `record.id`; set
`activeProfile` after success, or include it in the patch). Risk: low,
but only feels right if P0 lands first — otherwise the next tab click
undoes it.

### P1 — say one thing in Settings

**Why.** Move Profiles next to Projects (or give the nav hint “which
projects you are looking at”). Lead the pane with the filter, then
colour, then folder. Drop “a profile is a colour and a folder” as the
first sentence. Align the `Settings.profiles` comment with
`shared/profiles.ts`. Effort: small (copy + nav). Risk: none.

### P1 — create preview when the name does not match the picked folder

**Why.** The rule is right; the surprise is not. If `G:/Code` has
twelve repos and the name is `Task`, the preview already says the
child starts empty. Add an explicit fork the user can pick:
**Use this folder** (reuse `G:/Code`, import the twelve, group =
`Code`) vs **Create Task inside it** (current default). That is the
original import ask, without the silent-adopt bug. Effort: medium
(plan + UI). Risk: medium (two actions must stay in `describePlan` /
`willCreate` lockstep — the suite already polices that).

Do not bring back “adopt whenever it holds projects” as the default.

### P1 — after create, you cannot change the folder

**Why.** Rename and recolour exist; “this profile is the wrong
directory” does not, except delete. `groups[]` already allows more
than one folder; Worklog already draws a dash for a partial watch.
A single “Folder” row (reuse the create planner, or a picker that
appends a group + scan root) closes the loop. Effort: medium. Risk:
medium (clash with a derived seed, scan-root leftovers).

### P1 — `school` / Study leftover

**Why.** Same shape as `gitea-company` holding the Work label. A
folder actually called `study` is denied a chip while Study filters
`school`. Options: label the seed `School`, or treat `study` as an
alias group on that seed. Effort: small. Risk: low if groups are
aliased rather than ids rewritten. Needs a yes — this is a named-seed
vocabulary change.

### P2 — derived extras from accidental parents

Scratch sessions live under `userData/scratch/<stamp>`, so two
scratches yield a **Scratch** chip. `~/Code` with two repos yields
**Code**. Exclude the scratch root from counts, and/or require
user-created records for extras (derived = named seeds only). Effort:
small–medium. Risk: low for scratch; higher if extras stop appearing
for real client/lab folders.

### P2 — delete a user-made profile vs its scan root

Delete drops the record and leaves the root. The folder’s projects
stay in All (correct — not access control) but a later `n > 1` derive
can put the chip back. Either tombstone user-made ids the same way as
seeds, or offer “stop scanning this folder” on delete. Effort: small.
Risk: low.

### P2 — Personal vs Ember, Study hairline

Colour cannot carry the active profile (suite prints this). The status
pill exists because of it. Nudging Personal off `#ff9552`, or a
non-colour selected state on the chip (check, not only fill), makes
All → Personal visible on the default theme. Effort: small. Risk: low
(do not restyle the other seven swatches — gotcha 44).

### P2 — do not invent access control or per-project assignment

Tempting, contradicts PLAN. Membership stays `group`. Moving a project
between profiles is moving it on disk (or, with the P1 folder editor,
adding its parent as a second group).

## 4. What this PR changes vs what needs a decision

**Changed**

- Sidebar empty state when a profile is selected and has no projects
  (`Sidebar.tsx`). Search miss copy is unchanged.

**Trong before any of the rest**

1. P0: chip sticky vs tab-follow vs split (1 / 2 / 3 above).
2. P1: create landing on the new profile (yes, once P0 is picked).
3. P1: “Use this folder” vs “Create a child” on create.
4. P1: `school` labelled Study — keep, rename, or alias `study`.
5. P2: should scratch (and other app-owned trees) ever seed a chip?

Not asked, not proposed: theme editor, per-profile Claude defaults,
worklog keyed on the chip, profiles as permissions.
