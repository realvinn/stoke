/*
 * New session: a sheet (full-height on a phone, a 560px modal from 768px up)
 * in two steps — audit PX-11. The old screen started a real `claude` on ONE
 * tap of any of 61 unsearchable full-width cards, with no agent, mode, model
 * or effort choice. Now: pick where (the desktop switcher's own list,
 * `phonePickerGroups` — Recent projects, Default folder, Scratch session,
 * Remote machines, Browse folders…), then confirm with the choices the
 * desktop's launcher has, defaulted from `settings.defaults` (phone contract
 * points 2 and 8), on the desktop's default agent (`defaults.cli`). Bypass is
 * never offered.
 *
 * Browse walks folders under the places the server allows (phone contract
 * points 12, 13): a breadcrumb that starts at the place, the subfolders,
 * Start here, and New folder. Either adds the folder as a project on the
 * desktop before the session starts, which is what lets it pass `knownCwd`.
 */
import type { FolderChoice } from '@shared/launcher'
import {
  breadcrumb,
  initialAgent,
  MAX_FOLDER_NAME,
  middleTruncate,
  newFolderHint,
  phonePickerGroups,
  plural,
  relativeTime
} from '@shared/phoneUi'
import { api, folderName, host, loadHost, type FolderListing, type ProjectRow, type ProjectsReply } from './api'
import { el, failure, humanError, icon, openSheet, skeleton, toast } from './dom'
import { pendingMeta } from './session'

const MODES = [
  { id: 'default', label: 'Ask', hint: 'Asks before each tool use.' },
  { id: 'plan', label: 'Plan', hint: 'Researches and proposes; touches no files.' },
  { id: 'acceptEdits', label: 'Edits', hint: 'File edits apply; other tools still ask.' },
  { id: 'auto', label: 'Auto', hint: 'Decides when to ask by how risky the action is.' }
]
const MODELS = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'fable', label: 'Fable' }
]
const EFFORTS = [
  { id: 'default', label: 'Default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' }
]

/** Where a session will run, once picked. */
type Target =
  | { kind: 'folder'; path: string; name: string }
  | { kind: 'scratch' }
  | { kind: 'host'; id: string; label: string; alias: string }

const PLACE_META: Record<string, string> = {
  root: 'Project root',
  default: 'Default folder',
  parent: 'Where your projects are'
}

/** How many path characters fit a picker row at this width (12px mono ≈ 7.2px a character). */
export function pathRoom(): number {
  const width = Math.min(window.innerWidth, 560)
  return Math.max(24, Math.floor((width - 130) / 7.3))
}

/** One tappable row of the picker or the browser. Every row is a real button. */
function pickRow(
  p: {
    icon: string
    name: string
    badge?: string
    hint?: string
    path?: string
    meta?: string
    disabled?: boolean
    label?: string
  },
  onPick: () => void
): HTMLButtonElement {
  const b = el(
    'button',
    { type: 'button', class: 'prow', disabled: p.disabled, 'aria-label': p.label ?? `${p.name}${p.badge ? `, ${p.badge}` : ''}` },
    el('span', { class: 'prow-icon' }, icon(p.icon, 18)),
    el(
      'span',
      { class: 'prow-text' },
      el(
        'span',
        { class: 'prow-name' },
        el('span', { class: 'prow-label' }, p.name),
        p.hint ? el('span', { class: 'prow-hint' }, p.hint) : null,
        p.badge ? el('span', { class: 'tag' }, p.badge) : null
      ),
      p.path ? el('span', { class: 'prow-path' }, middleTruncate(p.path, pathRoom())) : null,
      p.meta ? el('span', { class: 'prow-meta' }, p.meta) : null
    ),
    el('span', { class: 'prow-go' }, icon('chevron', 18))
  )
  b.addEventListener('click', onPick)
  return b
}

/**
 * Open the sheet. With `start`, go straight to confirming a session in that
 * folder — the history page's "New session here"; Back still reaches the
 * full picker.
 */
export function openNewSession(start?: { cwd: string; name: string }): void {
  const sheet = openSheet({ title: 'New session', size: 'full' })
  let data: ProjectsReply | null = null

  /* ------------------------------------------------------ step 1: where */

  const pickFolder = (): void => {
    sheet.setTitle('New session', null)
    const search = el('input', {
      type: 'search',
      class: 'search',
      placeholder: 'Search projects',
      'aria-label': 'Search projects',
      autocomplete: 'off',
      enterkeyhint: 'search'
    })
    const results = el('div', { class: 'picker' })
    sheet.body.replaceChildren(el('label', { class: 'search-wrap' }, icon('search', 18), search), results)
    // No autofocus on a touch screen: it throws the keyboard over the list.
    if (matchMedia('(pointer: fine)').matches) search.focus()

    const choiceRow = (c: FolderChoice, byPath: Map<string, ProjectRow>, now: number): HTMLElement => {
      switch (c.kind) {
        case 'project': {
          const p = byPath.get(c.path)
          const meta = c.missing
            ? 'Folder is missing'
            : [p?.sessionCount ? plural(p.sessionCount, 'session') : 'no sessions yet', relativeTime(c.lastModified, now)]
                .filter(Boolean)
                .join(' · ')
          return pickRow(
            { icon: c.pinned ? 'pin' : 'folder', name: c.label, hint: c.hint, path: c.path, meta, disabled: c.missing },
            () => confirmStep({ kind: 'folder', path: c.path, name: c.label }, pickFolder)
          )
        }
        case 'default':
          return pickRow({ icon: 'folder', name: folderName(c.path), badge: 'Default folder', path: c.path }, () =>
            confirmStep({ kind: 'folder', path: c.path, name: folderName(c.path) }, pickFolder)
          )
        case 'scratch':
          return pickRow({ icon: 'plus', name: c.label, meta: 'A new dated folder, for throwaway work' }, () =>
            confirmStep({ kind: 'scratch' }, pickFolder)
          )
        case 'host':
          return pickRow(
            { icon: 'terminal', name: c.label, path: c.alias, meta: 'Claude Code over SSH', label: `${c.label}, remote machine` },
            () => confirmStep({ kind: 'host', id: c.id, label: c.label, alias: c.alias }, pickFolder)
          )
        case 'open':
          return pickRow({ icon: 'search', name: c.label, meta: 'Pick or create a folder beside your projects' }, () => browseStep(null))
      }
    }

    const draw = (): void => {
      if (!data) return
      const now = Date.now()
      const q = search.value.trim()
      const groups = phonePickerGroups({
        projects: data.projects,
        defaultCwd: data.defaultCwd,
        hosts: data.hosts ?? [],
        query: q,
        platform: host?.platform ?? 'darwin'
      })
      const byPath = new Map(data.projects.map((p) => [p.path, p]))
      const onlyBrowse = groups.every((g) => g.items.every((c) => c.kind === 'open'))
      results.replaceChildren(
        ...(q && onlyBrowse
          ? [el('div', { class: 'empty small' }, el('p', { class: 'empty-text' }, `No project matches “${search.value}”.`))]
          : []),
        ...groups.flatMap((g) => [
          g.title
            ? el(
                'h3',
                { class: 'section-head' },
                el('span', {}, g.title),
                g.items[0]?.kind === 'project' ? el('span', { class: 'section-count' }, String(g.items.length)) : null
              )
            : null,
          ...g.items.map((c) => choiceRow(c, byPath, now))
        ]).filter((n): n is HTMLElement => n !== null)
      )
    }

    search.addEventListener('input', draw)
    if (data) draw()
    else {
      results.replaceChildren(skeleton(6))
      Promise.all([api<ProjectsReply>('/api/projects'), host ? Promise.resolve(host) : loadHost()])
        .then(([reply]) => {
          data = reply
          draw()
        })
        .catch((err) => results.replaceChildren(failure('Could not load your projects', humanError(err), pickFolder)))
    }
  }

  /* -------------------------------------------------- step 1b: browse */

  /** Claimed before the request, so a double tap adds or creates once (gotcha 20). */
  let adding = false

  const browseStep = (path: string | null): void => {
    const listBox = el('div', { class: 'picker' })
    const footer = el('div', { class: 'sheet-footer' })
    sheet.setTitle(path ? folderName(path) : 'Browse', pickFolder)
    sheet.body.replaceChildren(listBox)
    listBox.replaceChildren(skeleton(5))

    const addThen = (payload: Record<string, unknown>, busy: HTMLButtonElement, busyText: string): void => {
      if (adding) return
      adding = true
      const was = busy.textContent
      busy.disabled = true
      busy.textContent = busyText
      api<{ path: string; name: string; created: boolean }>('/api/projects', { method: 'POST', body: JSON.stringify(payload) })
        .then((added) => {
          if (added.created) toast(`Created ${added.name}.`)
          confirmStep({ kind: 'folder', path: added.path, name: added.name }, () => browseStep(path))
        })
        .catch((err) => {
          busy.disabled = false
          busy.textContent = was
          toast(humanError(err), 'error')
        })
        .finally(() => {
          adding = false
        })
    }

    const showActions = (listing: FolderListing): void => {
      if (!listing.path) {
        footer.remove()
        return
      }
      const here = listing.path
      const newBtn = el('button', { type: 'button', class: 'btn' }, icon('plus', 18), 'New folder')
      const startBtn = el('button', { type: 'button', class: 'btn', 'data-variant': 'primary' }, 'Start here')
      startBtn.addEventListener('click', () => addThen({ path: here }, startBtn, 'Adding…'))
      newBtn.addEventListener('click', () => showNewFolder(here))
      footer.replaceChildren(el('div', { class: 'sheet-actions' }, newBtn, startBtn))
      sheet.body.append(footer)
    }

    const showNewFolder = (parent: string): void => {
      const input = el('input', {
        type: 'text',
        class: 'field-input',
        placeholder: 'Folder name',
        'aria-label': 'New folder name',
        autocomplete: 'off',
        autocapitalize: 'off',
        maxLength: MAX_FOLDER_NAME + 10,
        enterkeyhint: 'done'
      })
      // `el` drops a false prop, so this one is set directly.
      input.spellcheck = false
      const hint = el('p', { class: 'field-error', 'aria-live': 'polite' })
      const cancel = el('button', { type: 'button', class: 'btn' }, 'Cancel')
      const create = el('button', { type: 'button', class: 'btn', 'data-variant': 'primary', disabled: true }, 'Create')
      const check = (): boolean => {
        const problem = newFolderHint(input.value)
        hint.textContent = problem ?? ''
        hint.hidden = !problem
        create.disabled = !input.value.trim() || problem !== null
        return !create.disabled
      }
      input.addEventListener('input', check)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && check()) {
          e.preventDefault()
          addThen({ parent, name: input.value.trim() }, create, 'Creating…')
        }
      })
      create.addEventListener('click', () => {
        if (check()) addThen({ parent, name: input.value.trim() }, create, 'Creating…')
      })
      cancel.addEventListener('click', () => browseStep(parent))
      footer.replaceChildren(
        el('label', { class: 'field newfolder' }, el('span', { class: 'field-label' }, `New folder in ${folderName(parent)}`), input),
        hint,
        el('div', { class: 'sheet-actions' }, cancel, create)
      )
      check()
      input.focus()
    }

    const draw = (listing: FolderListing): void => {
      const nodes: HTMLElement[] = []
      if (listing.path && listing.base) {
        const up = listing.up
        sheet.setTitle(folderName(listing.path), () => browseStep(up))
        const places = el('button', { type: 'button', class: 'crumb' }, 'Places')
        places.addEventListener('click', () => browseStep(null))
        const crumbs = breadcrumb(listing.path, listing.base)
        const trail: HTMLElement[] = [places]
        crumbs.forEach((c, i) => {
          trail.push(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'))
          if (i === crumbs.length - 1) {
            trail.push(el('span', { class: 'crumb', 'aria-current': 'page' }, c.label))
          } else {
            const b = el('button', { type: 'button', class: 'crumb' }, c.label)
            b.addEventListener('click', () => browseStep(c.path))
            trail.push(b)
          }
        })
        nodes.push(el('nav', { class: 'crumbs', 'aria-label': 'Folder path' }, ...trail))
      } else {
        sheet.setTitle('Browse', pickFolder)
        nodes.push(el('h3', { class: 'section-head' }, el('span', {}, 'Places')))
      }
      if (!listing.folders.length) {
        nodes.push(
          el(
            'div',
            { class: 'empty small' },
            el('p', { class: 'empty-text' }, listing.path ? 'No folders in here.' : 'No project roots or default folder to browse. Add a project root in Stoke’s Settings.')
          )
        )
      }
      for (const f of listing.folders) {
        nodes.push(
          listing.path
            ? pickRow({ icon: 'folder', name: f.name }, () => browseStep(f.path))
            : pickRow({ icon: 'folder', name: f.name, path: f.path, meta: PLACE_META[f.kind ?? ''] }, () => browseStep(f.path))
        )
      }
      if (listing.truncated) {
        nodes.push(el('p', { class: 'browse-note' }, `Showing the first ${listing.folders.length} folders.`))
      }
      listBox.replaceChildren(...nodes)
      showActions(listing)
    }

    api<FolderListing>(path ? `/api/folders?path=${encodeURIComponent(path)}` : '/api/folders')
      .then(draw)
      .catch((err) => listBox.replaceChildren(failure('Could not open that folder', humanError(err), () => browseStep(path))))
  }

  /* ---------------------------------------------------- step 2: confirm */

  const confirmStep = (target: Target, back: () => void): void => {
    const title = target.kind === 'folder' ? target.name : target.kind === 'host' ? target.label : 'Scratch session'
    sheet.setTitle(title, back)
    // A remote machine runs Claude Code, whatever else this desktop has (gotcha 19).
    const offered = host?.agents?.length ? host.agents : [{ id: 'claude', name: 'Claude Code' }]
    const agents = target.kind === 'host' ? offered.filter((a) => a.id === 'claude').slice(0, 1) : offered
    const defaults = host?.defaults ?? { permissionMode: 'default', model: '', effort: 'default' }
    // The desktop's default agent, when this sheet offers it.
    let cli = target.kind === 'host' ? 'claude' : initialAgent(agents, defaults.cli)
    let mode = MODES.some((m) => m.id === defaults.permissionMode) ? defaults.permissionMode : 'default'
    let model = MODELS.some((m) => m.id === defaults.model) ? defaults.model : ''
    let effort = EFFORTS.some((e) => e.id === defaults.effort) ? defaults.effort : 'default'

    const segmented = (
      label: string,
      options: { id: string; label: string }[],
      value: () => string,
      set: (id: string) => void,
      grid = false
    ): HTMLElement => {
      const group = el('div', { class: grid ? 'seg seg-grid' : 'seg seg-wrap', role: 'radiogroup', 'aria-label': label })
      const paint = (): void => {
        for (const b of group.querySelectorAll<HTMLButtonElement>('button')) {
          b.setAttribute('aria-checked', String(b.dataset.id === value()))
        }
      }
      for (const o of options) {
        const b = el('button', { type: 'button', class: 'seg-btn', role: 'radio', 'data-id': o.id }, o.label)
        b.addEventListener('click', () => {
          set(o.id)
          paint()
          after()
        })
        group.append(b)
      }
      paint()
      return el('div', { class: 'field' }, el('div', { class: 'field-label' }, label), group)
    }

    const modeHint = el('p', { class: 'field-hint' })
    const claudeOnly = el('div', { class: 'claude-only' })
    const startBtn = el('button', { type: 'button', class: 'btn btn-block', 'data-variant': 'primary' })
    const startLabel =
      target.kind === 'folder' ? `Start in ${target.name}` : target.kind === 'host' ? `Connect to ${target.label}` : 'Start scratch session'
    const after = (): void => {
      modeHint.textContent = MODES.find((m) => m.id === mode)?.hint ?? ''
      claudeOnly.hidden = cli !== 'claude'
      startBtn.textContent = startLabel
    }

    claudeOnly.append(
      segmented('Permission mode', MODES, () => mode, (id) => (mode = id)),
      modeHint,
      segmented('Model', MODELS, () => model, (id) => (model = id)),
      segmented('Effort', EFFORTS, () => effort, (id) => (effort = id), true)
    )

    const where =
      target.kind === 'folder'
        ? el('div', { class: 'confirm-where' }, icon('folder', 18), el('span', {}, middleTruncate(target.path, 52)))
        : target.kind === 'host'
          ? el('div', { class: 'confirm-where' }, icon('terminal', 18), el('span', {}, `ssh ${target.alias}`))
          : el('div', { class: 'confirm-where' }, icon('plus', 18), el('span', {}, 'A new dated folder in Stoke’s scratch space'))
    const parts: HTMLElement[] = [where]
    if (agents.length > 1) {
      parts.push(segmented('Agent', agents.map((a) => ({ id: a.id, label: a.name })), () => cli, (id) => (cli = id)))
    }
    parts.push(claudeOnly)
    after()

    startBtn.addEventListener('click', () => {
      if (startBtn.disabled) return
      startBtn.disabled = true
      startBtn.textContent = 'Starting…'
      const body: Record<string, unknown> =
        target.kind === 'folder' ? { cwd: target.path } : target.kind === 'host' ? { hostId: target.id } : { scratch: true }
      if (cli !== 'claude') body.cli = cli
      else Object.assign(body, { permissionMode: mode, model, effort })
      void api<{ ptyId: string; sessionId: string; cwd?: string }>('/api/sessions', { method: 'POST', body: JSON.stringify(body) })
        .then((started) => {
          const cwd = started.cwd ?? (target.kind === 'folder' ? target.path : target.kind === 'host' ? target.alias : '')
          const project = target.kind === 'folder' ? target.name : target.kind === 'host' ? target.label : folderName(cwd)
          pendingMeta.set(started.ptyId, { cwd, project })
          sheet.close()
          // Straight into the session; its screen waits for the `attached`
          // frame rather than a fixed 1200ms timer.
          location.hash = `#/s/${encodeURIComponent(started.ptyId)}`
        })
        .catch((err) => {
          startBtn.disabled = false
          after()
          toast(humanError(err), 'error')
        })
    })

    sheet.body.replaceChildren(el('div', { class: 'confirm' }, ...parts), el('div', { class: 'sheet-footer' }, startBtn))
    startBtn.focus({ preventScroll: true })
  }

  if (start) {
    // The agent list and defaults come from /api/host; wait for them once.
    sheet.body.replaceChildren(skeleton(4))
    void (host ? Promise.resolve(host) : loadHost().catch(() => null)).then(() =>
      confirmStep({ kind: 'folder', path: start.cwd, name: start.name }, pickFolder)
    )
  } else pickFolder()
}
