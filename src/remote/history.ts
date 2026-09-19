/*
 * History: projects, then a project's past sessions, then one conversation
 * read back. Everything done earlier lives in Claude Code's own transcripts,
 * which is usually what someone opening this on a phone is after.
 *
 * A session running right now is marked Live and opens rather than resumes
 * (PX-10: Resume on a live session forked it with a second `claude --resume`).
 * The read-back opens at the newest message and folds tool-only turns (PX-15).
 */
import { collapseTurns, middleTruncate, plural, relativeTime, splitMarkdown } from '@shared/phoneUi'
import { api, folderName, resumeSession, type HistoryRow, type ProjectRow, type TurnRow } from './api'
import { confirmSheet, el, failure, humanError, icon, iconButton, skeleton, toast } from './dom'
import { meterMini } from './list'
import { pathRoom } from './newSession'
import { pendingMeta } from './session'

export interface Page {
  root: HTMLElement
  destroy: () => void
}

function page(title: string, back: string | null, actions: HTMLElement[] = []): { root: HTMLElement; body: HTMLElement } {
  const head = el('header', { class: 'topbar' })
  if (back) {
    const b = iconButton('back', 'Back')
    b.addEventListener('click', () => (location.hash = back))
    head.append(b)
  }
  head.append(el('h1', { class: 'topbar-title' }, title), el('span', { class: 'spacer' }), ...actions)
  const body = el('main', { class: 'scroll' })
  return { root: el('section', { class: 'page' }, head, body), body }
}

const sessionsCache = new Map<string, HistoryRow[]>()

export const historyHref = (cwd: string): string => `#/history/p/${encodeURIComponent(cwd)}`
const transcriptHref = (id: string, cwd: string): string => `#/history/t/${encodeURIComponent(id)}/${encodeURIComponent(cwd)}`

/* ------------------------------------------------------------ projects */

export function mountHistory(): Page {
  const { root, body } = page('History', '#/')
  const search = el('input', { type: 'search', class: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects' })
  const list = el('div', { class: 'picker' })
  body.append(el('div', { class: 'content' }, el('label', { class: 'search-wrap' }, icon('search', 18), search), list))
  let projects: ProjectRow[] = []

  const draw = (): void => {
    const q = search.value.trim().toLowerCase()
    const now = Date.now()
    const rows = projects
      .filter((p) => p.sessionCount > 0)
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    if (!rows.length) {
      list.replaceChildren(
        el('div', { class: 'empty small' }, el('p', { class: 'empty-text' }, q ? `No project matches “${search.value}”.` : 'No past sessions on this machine yet.'))
      )
      return
    }
    list.replaceChildren(
      ...rows.map((p) =>
        el(
          'a',
          { class: 'prow', href: historyHref(p.path) },
          el('span', { class: 'prow-icon' }, icon(p.pinned ? 'pin' : 'folder', 18)),
          el(
            'span',
            { class: 'prow-text' },
            el('span', { class: 'prow-name' }, p.name),
            el('span', { class: 'prow-path' }, middleTruncate(p.path, pathRoom())),
            el('span', { class: 'prow-meta' }, [plural(p.sessionCount, 'session'), relativeTime(p.lastActivityAt, now)].filter(Boolean).join(' · '))
          ),
          el('span', { class: 'prow-go' }, icon('chevron', 18))
        )
      )
    )
  }
  search.addEventListener('input', draw)

  const load = (): void => {
    list.replaceChildren(skeleton(5))
    api<{ projects: ProjectRow[] }>('/api/projects')
      .then((d) => {
        projects = d.projects
        draw()
      })
      .catch((err) => list.replaceChildren(failure('Could not load history', humanError(err), load)))
  }
  load()
  return { root, destroy: () => {} }
}

/* --------------------------------------------------- one project's sessions */

export function mountProjectHistory(cwd: string): Page {
  const { root, body } = page(folderName(cwd), '#/history')
  const content = el('div', { class: 'content' })
  body.append(content)

  const sessionRow = (s: HistoryRow, now: number): HTMLElement => {
    const title = s.title || s.firstPrompt || 'Untitled session'
    const href = s.live && s.ptyId ? `#/s/${encodeURIComponent(s.ptyId)}` : transcriptHref(s.id, cwd)
    return el(
      'a',
      { class: 'hrow', href },
      el(
        'span',
        { class: 'hrow-top' },
        el('span', { class: 'hrow-title' }, title),
        s.live ? el('span', { class: 'pill', 'data-tone': 'busy' }, el('i', { 'aria-hidden': 'true' }), 'Live') : null
      ),
      el(
        'span',
        { class: 'hrow-meta' },
        el('span', {}, [relativeTime(s.modified, now), plural(s.messageCount, 'message'), s.gitBranch].filter(Boolean).join(' · ')),
        s.contextTokens > 0 ? meterMini(s.contextTokens, s.contextLimit) : null
      )
    )
  }

  const load = (): void => {
    content.replaceChildren(skeleton(5))
    api<{ sessions: HistoryRow[] }>(`/api/history?cwd=${encodeURIComponent(cwd)}`)
      .then((d) => {
        sessionsCache.set(cwd, d.sessions)
        const now = Date.now()
        const empty = d.sessions.filter((s) => s.messageCount === 0 && !s.title && !s.firstPrompt)
        const real = d.sessions.filter((s) => !empty.includes(s))
        if (!real.length && !empty.length) {
          content.replaceChildren(el('div', { class: 'empty small' }, el('p', { class: 'empty-text' }, 'No conversations in this project yet.')))
          return
        }
        const nodes: HTMLElement[] = [el('div', { class: 'hlist' }, ...real.map((s) => sessionRow(s, now)))]
        if (empty.length) {
          nodes.push(
            el(
              'details',
              { class: 'empties' },
              el('summary', {}, `Empty sessions (${empty.length})`),
              el('div', { class: 'hlist' }, ...empty.map((s) => sessionRow(s, now)))
            )
          )
        }
        content.replaceChildren(...nodes)
      })
      .catch((err) => content.replaceChildren(failure('Could not load these sessions', humanError(err), load)))
  }
  load()
  return { root, destroy: () => {} }
}

/* ------------------------------------------------------ one conversation */

function renderText(text: string): HTMLElement {
  const box = el('div', { class: 'turn-text' })
  for (const part of splitMarkdown(text)) {
    if (part.kind === 'text') box.append(part.text)
    else if (part.kind === 'code') box.append(el('code', {}, part.text))
    else box.append(el('pre', { class: 'fence', 'data-lang': part.lang || undefined }, el('code', {}, part.text)))
  }
  return box
}

export function mountTranscript(id: string, cwd: string): Page {
  const action = el('button', { type: 'button', class: 'btn btn-sm', 'data-variant': 'primary', hidden: true }, 'Resume')
  const { root, body } = page('Conversation', historyHref(cwd), [action])
  const title = root.querySelector('.topbar-title') as HTMLElement
  const content = el('div', { class: 'content transcript' })
  body.append(content)
  let meta: HistoryRow | null = sessionsCache.get(cwd)?.find((s) => s.id === id) ?? null

  const paintAction = (): void => {
    if (!meta) return
    title.textContent = meta.title || meta.firstPrompt || folderName(cwd)
    action.hidden = false
    action.textContent = meta.live ? 'Open' : 'Resume'
  }

  action.addEventListener('click', () => {
    if (!meta) return
    if (meta.live && meta.ptyId) {
      location.hash = `#/s/${encodeURIComponent(meta.ptyId)}`
      return
    }
    const m = meta
    void (async () => {
      // Recently touched: it may be open in a terminal somewhere else, and a
      // second --resume on it forks the conversation.
      if (Date.now() - m.modified < 5 * 60_000) {
        const ok = await confirmSheet({
          title: 'Resume this conversation?',
          message: `It changed ${relativeTime(m.modified, Date.now())}. If it is still open somewhere else, resuming here starts a second copy that the two will not share.`,
          confirm: 'Resume anyway'
        })
        if (!ok) return
      }
      action.disabled = true
      action.textContent = 'Resuming…'
      try {
        const started = await resumeSession(m.projectPath, m.id)
        if (started.alreadyOpen) toast('That conversation is already open. Showing it.')
        else pendingMeta.set(started.ptyId, { cwd: m.projectPath, project: folderName(m.projectPath) })
        location.hash = `#/s/${encodeURIComponent(started.ptyId)}`
      } catch (err) {
        action.disabled = false
        paintAction()
        toast(humanError(err), 'error')
      }
    })()
  })

  const load = (): void => {
    content.replaceChildren(skeleton(4))
    const metaJob = meta
      ? Promise.resolve(meta)
      : api<{ sessions: HistoryRow[] }>(`/api/history?cwd=${encodeURIComponent(cwd)}`).then((d) => {
          sessionsCache.set(cwd, d.sessions)
          return d.sessions.find((s) => s.id === id) ?? null
        })
    Promise.all([metaJob, api<{ turns: TurnRow[]; total: number; truncated: boolean }>(`/api/transcript?id=${encodeURIComponent(id)}`)])
      .then(([m, data]) => {
        meta = m
        paintAction()
        const items = collapseTurns(data.turns)
        if (!items.length) {
          content.replaceChildren(el('div', { class: 'empty small' }, el('p', { class: 'empty-text' }, 'Nothing readable in this conversation.')))
          return
        }
        const now = Date.now()
        const nodes: HTMLElement[] = []
        if (data.truncated) nodes.push(el('p', { class: 'note' }, `Showing the last ${data.turns.length} of ${data.total} messages.`))
        for (const item of items) {
          if (item.kind === 'tools') {
            nodes.push(
              el(
                'div',
                { class: 'turn-tools' },
                icon('terminal', 14),
                el('span', {}, `Ran ${plural(item.count, 'tool')}`),
                el('span', { class: 'turn-tools-list' }, item.summary)
              )
            )
            continue
          }
          const t = item.turn
          nodes.push(
            el(
              'article',
              { class: 'turn', 'data-role': t.role },
              el('div', { class: 'turn-head' }, el('span', {}, t.role === 'user' ? 'You' : 'Claude'), el('span', {}, relativeTime(t.at, now))),
              t.text ? renderText(t.text) : null,
              t.tools.length ? el('div', { class: 'turn-tools inline' }, icon('terminal', 14), el('span', {}, t.tools.join(', '))) : null
            )
          )
        }
        content.replaceChildren(...nodes)
        // The newest message is the one you came for (PX-15).
        requestAnimationFrame(() => (body.scrollTop = body.scrollHeight))
      })
      .catch((err) => content.replaceChildren(failure('Could not read this conversation', humanError(err), load)))
  }
  load()
  return { root, destroy: () => {} }
}
