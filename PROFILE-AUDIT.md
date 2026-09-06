# Profiles audit (0.9.3)

Trong said profiles “don’t feel so right” without naming a bug. This is
diagnosis, not a redesign. A profile stays a **view filter, never access
control**.

**Split is the settled decision** (Trong, this PR). The sidebar chip is a
sticky view filter. The quieter chrome — status pill and the session’s
terminal accent — follows the tab in front. The worklog still keys off
the session’s folder group, never the chip.

Shipped with that: create selects the new profile; Settings says one
thing; the empty-profile sidebar copy no longer quotes a blank search.

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

**Split (shipped).** The chip is the only writer of the selection. The
active tab still resolves through `profileIdForCwd`, but only to name
the status pill and paint the session’s cursor — it must not call
`patchSettings({ activeProfile })`. An SSH tab and a folder no profile
owns have no pill. The filter stays where the user left it.

**Worklog** stores `worklogGroups` (folder names), not profile ids, and
never sees `activeProfile`. The Settings checkboxes are a face over that
list. That split is load-bearing (gotcha 18 / PLAN): a Work session must
still be watched while you browse Personal.

## 2. Why they feel off

The feature is internally consistent and well tested. The smell is that
**one chip is doing three jobs**, and the product copy does not agree
with itself about which job is the point.

### The chip was a mode, not a filter you hold *(fixed: Split)*

PLAN and the original ask: *“I should choose it manually.”* Before
Split, App overwrote that choice from the active tab. Pick All → click
a Work tab → the list collapsed and the chrome turned green. The only
way to *keep* All was to not activate a project tab.

Split is the fix: the chip stays; the status pill and the session
cursor say which folder the tab belongs to. Personal-on-Ember is still
a no-op by colour, which is why the pill is named, not merely tinted.

### Three written definitions *(fixed: one sentence)*

Settings, the nav hint, and the `Settings.profiles` / `activeProfile`
comments now all say the same thing: a view filter by folder group.
Colour and the worklog switch are how it shows and what it can trigger,
not a second meaning. The pane still sits under Appearance (chrome
paint); moving the nav row is leftover.

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

After create, the new profile **is** selected (`activeProfile` is in
the create patch). Combined with Split, that lands and stays.

You still cannot point an existing profile at a different folder, or add
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

### P0 — Split *(done in this PR)*

Chip = sticky filter. Tab-follow no longer writes `activeProfile`.
Status pill (muted, named) and the session’s terminal accent follow
`profileIdForCwd`. Worklog still does not see the chip.

### P0 — empty profile state *(done in this PR)*

Selecting a chip with no matching projects used to render the search
miss: *Nothing matches* / *contains “”*. Copy now says the profile is
empty and points at Open / All.

### P1 — create should land on the new profile *(done in this PR)*

`createProfile`’s patch now includes `activeProfile: record.id`. The
chip lands on the new profile and, because the filter is sticky, stays
there.

### P1 — say one thing in Settings *(done in this PR)*

The pane and the nav hint now say view filter by folder group. The
`Settings.profiles` / `activeProfile` comments match. Profiles still
sit under Appearance (chrome paint); moving the nav row is leftover.

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

### P2 — do not invent access control *(membership is curated now)*

Access control still out of scope. Membership is no longer `group`-only:
`projectPaths` is the curated set; folder groups seed and name worklog /
pill. Moving between profiles edits path lists, never folders on disk.

## 4. What this PR changed vs what still needs a decision

**Shipped**

- Split: chip is sticky; status pill + session accent follow the tab.
- Create selects the new profile.
- Settings copy is one sentence (view filter by folder group).
- Empty-profile sidebar copy.

**Still Trong, not this pass**

1. “Use this folder” vs “Create a child” on create.
2. Folder editor after create.
3. `school` labelled Study — keep, rename, or alias `study`.
4. Should scratch (and other app-owned trees) ever seed a chip?

Not asked, not proposed: theme editor, per-profile Claude defaults,
worklog keyed on the chip, profiles as permissions.


## 5. Curated membership (this PR, after Split)

**Supersedes** PLAN / earlier audit notes that membership equals `Project.group`
only. A profile is now a **curated set of projects** (`projectPaths` on the
stored record). Folder groups still:

- seed defaults (projects under `work/` start on Work),
- power "Add all in folder",
- drive the worklog watch list and `profileIdForCwd` (status pill / session
  accent).

The sidebar chip filters to `projectPaths`. Moving a project between profiles
edits those arrays and **never** renames or moves folders on disk. All / search /
Open / command palette still reach every project.

**Migration:** `hydrateMembership` snapshots group-matched paths onto stored
records that lack `projectPaths` once projects have loaded, so chips do not
empty overnight. Derived-only chips (no stored record) keep live group seeding
until the user add/removes once. Tombstones use `groups: []` and
`projectPaths: []`.
