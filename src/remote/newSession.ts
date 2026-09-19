/*
 * New session: a sheet (full-height on a phone, a 560px modal from 768px up)
 * in two steps — audit PX-11. The old screen started a real `claude` on ONE
 * tap of any of 61 unsearchable full-width cards, with no agent, mode, model
 * or effort choice. Now: pick a folder (search, Pinned, Recent, All), then
 * confirm with the choices the desktop's launcher has, defaulted from
 * `settings.defaults` (phone contract points 2 and 8). Bypass is never offered.
 */
import { groupProjects, middleTruncate, plural, relativeTime } from '@shared/phoneUi'
import { api, folderName, host, loadHost, type ProjectRow } from './api'
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

interface ProjectsReply {
  defaultCwd: string
  projects: ProjectRow[]
}

/** How many path characters fit a picker row at this width (12px mono ≈ 7.2px a character). */
export function pathRoom(): number {
  const width = Math.min(window.innerWidth, 560)
  return Math.max(24, Math.floor((width - 130) / 7.3))
}

export function openNewSession(): void {
  const sheet = openSheet({ title: 'New session', size: 'full' })
  let data: ProjectsReply | null = null

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
    sheet.body.replaceChildren(
      el('label', { class: 'search-wrap' }, icon('search', 18), search),
      results
    )
    // No autofocus on a touch screen: it throws the keyboard over the list.
    if (matchMedia('(pointer: fine)').matches) search.focus()

    const draw = (): void => {
      if (!data) return
      const now = Date.now()
      const def = data.defaultCwd
      // The default folder has its own row; macOS lists /tmp as /private/tmp.
      const same = (p: string): boolean => p === def || p === `/private${def}` || `/private${p}` === def
      const groups = groupProjects(
        data.projects.filter((p) => !same(p.path)),
        search.value,
        now
      )
      const q = search.value.trim().toLowerCase()
      const defaultRow =
        !q || folderName(def).toLowerCase().includes(q)
          ? projectButton({ name: folderName(def), path: def, badge: 'Default folder' })
          : null
      if (!groups.length && !defaultRow) {
        results.replaceChildren(el('div', { class: 'empty small' }, el('p', { class: 'empty-text' }, `No project matches “${search.value}”.`)))
        return
      }
      results.replaceChildren(
        ...(defaultRow ? [defaultRow] : []),
        ...groups.flatMap((g) => [
          el('h3', { class: 'section-head' }, el('span', {}, g.label), el('span', { class: 'section-count' }, String(g.rows.length))),
          ...g.rows.map((p) =>
            projectButton({
              name: p.name,
              path: p.path,
              meta: [p.sessionCount ? plural(p.sessionCount, 'session') : 'no sessions yet', relativeTime(p.lastActivityAt, now)]
                .filter(Boolean)
                .join(' · '),
              pinned: p.pinned,
              missing: !p.exists
            })
          )
        ])
      )
    }

    const projectButton = (p: { name: string; path: string; meta?: string; badge?: string; pinned?: boolean; missing?: boolean }): HTMLElement => {
      const b = el(
        'button',
        { type: 'button', class: 'prow', disabled: p.missing, 'aria-label': `${p.name}${p.badge ? `, ${p.badge}` : ''}` },
        el('span', { class: 'prow-icon' }, icon(p.pinned ? 'pin' : 'folder', 18)),
        el(
          'span',
          { class: 'prow-text' },
          el('span', { class: 'prow-name' }, p.name, p.badge ? el('span', { class: 'tag' }, p.badge) : null),
          el('span', { class: 'prow-path' }, middleTruncate(p.path, pathRoom())),
          p.meta || p.missing ? el('span', { class: 'prow-meta' }, p.missing ? 'Folder is missing' : p.meta ?? '') : null
        ),
        el('span', { class: 'prow-go' }, icon('chevron', 18))
      )
      b.addEventListener('click', () => confirmStep(p.name, p.path))
      return b
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

  const confirmStep = (name: string, path: string): void => {
    sheet.setTitle(name, pickFolder)
    const agents = host?.agents?.length ? host.agents : [{ id: 'claude', name: 'Claude Code' }]
    const defaults = host?.defaults ?? { permissionMode: 'default', model: '', effort: 'default' }
    let cli = agents[0].id
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
    const after = (): void => {
      modeHint.textContent = MODES.find((m) => m.id === mode)?.hint ?? ''
      claudeOnly.hidden = cli !== 'claude'
      startBtn.textContent = `Start in ${name}`
    }

    claudeOnly.append(
      segmented('Permission mode', MODES, () => mode, (id) => (mode = id)),
      modeHint,
      segmented('Model', MODELS, () => model, (id) => (model = id)),
      segmented('Effort', EFFORTS, () => effort, (id) => (effort = id), true)
    )

    const where = el('div', { class: 'confirm-where' }, icon('folder', 18), el('span', {}, middleTruncate(path, 52)))
    const parts: HTMLElement[] = [where]
    if (agents.length > 1) {
      parts.push(segmented('Agent', agents.map((a) => ({ id: a.id, label: a.name })), () => cli, (id) => (cli = id)))
    }
    parts.push(claudeOnly)
    after()

    startBtn.addEventListener('click', () => {
      startBtn.disabled = true
      startBtn.textContent = 'Starting…'
      const body: Record<string, unknown> = { cwd: path }
      if (cli !== 'claude') body.cli = cli
      else Object.assign(body, { permissionMode: mode, model, effort })
      void api<{ ptyId: string; sessionId: string }>('/api/sessions', { method: 'POST', body: JSON.stringify(body) })
        .then((started) => {
          pendingMeta.set(started.ptyId, { cwd: path, project: name })
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

  pickFolder()
}
