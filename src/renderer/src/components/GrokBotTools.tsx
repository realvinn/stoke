import { useEffect, useRef, useState } from 'react'
import type { GrokBotOperation, GrokBotResult } from '@shared/grokBot'
import { grokBotApprovals, grokBotProfile, grokBotSkills, type GrokBotApproval, type GrokBotProfile, type GrokBotSkill, type GrokBotThread } from '@shared/grokBotConversation'

export type GrokBotTool = 'profile' | 'skills' | 'approvals' | 'computer' | 'create'
type Action = Omit<GrokBotOperation, 'accountId'>
export function GrokBotTools({ tool, target, accountLabel, threads, busy, onOperate, onRefresh, onClose }: {
  tool: GrokBotTool; target?: GrokBotThread; accountLabel: string; threads: GrokBotThread[]; busy: boolean
  onOperate: (operation: Action) => Promise<GrokBotResult | null>; onRefresh: () => Promise<boolean>; onClose: () => void
}): React.JSX.Element {
  const [profile, setProfile] = useState<GrokBotProfile | null>(null)
  const [skills, setSkills] = useState<GrokBotSkill[]>([])
  const [approvals, setApprovals] = useState<GrokBotApproval[]>([])
  const [name, setName] = useState(''), [description, setDescription] = useState('')
  const [group, setGroup] = useState(false), [members, setMembers] = useState<string[]>([])
  const [markdown, setMarkdown] = useState(''), [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const live = useRef(true), operate = useRef(onOperate)
  operate.current = onOperate
  const targetKind = target?.kind === 'Group' ? 'group' : 'bot'
  const read = async () => {
    const kind = tool === 'profile' ? 'get' : tool === 'skills' ? 'skills' : 'approvals'
    const result = await operate.current({ kind, target: target?.id, targetKind })
    if (!live.current || !result?.ok) return
    if (tool === 'profile') setProfile(grokBotProfile(result.data))
    else if (tool === 'skills') setSkills(grokBotSkills(result.data))
    else setApprovals(grokBotApprovals(result.data))
  }
  useEffect(() => {
    live.current = true
    if (['profile', 'skills', 'approvals'].includes(tool)) void read()
    return () => { live.current = false }
  }, [])
  const act = async (operation: Action, message: string, refresh = true) => {
    setNotice(''); setConfirm(null)
    const result = await operate.current(operation)
    if (!live.current || !result?.ok) return false
    setNotice(result.message || message)
    if (refresh) { await onRefresh(); if (live.current && ['profile', 'skills', 'approvals'].includes(tool)) await read() }
    return true
  }
  const memberPicker = (selected: string[], change: (members: string[]) => void) => <fieldset className="grok-member-picker" disabled={busy}>
    <legend>Member bots (1–6)</legend>
    {threads.filter(thread => thread.kind === 'Bot').map(thread => <label key={thread.id}><input type="checkbox" checked={selected.includes(thread.id)} disabled={!selected.includes(thread.id) && selected.length >= 6} onChange={event => change(event.target.checked ? [...selected, thread.id] : selected.filter(id => id !== thread.id))} />{thread.name}</label>)}
  </fieldset>
  return <div className="grok-tools" aria-label="Grok Bot tools" data-tool={tool}>
    <div className="grok-tools-heading"><div><h3>{tool === 'profile' ? `${target?.kind || 'Bot'} settings` : tool === 'create' ? 'Create a bot or group' : tool === 'skills' ? 'Shared skills' : tool === 'approvals' ? 'Pending approvals' : 'Bot’s computer'}</h3><p>{accountLabel}{target && tool !== 'skills' ? ` · ${target.name}` : ''}</p></div><button className="btn" onClick={onClose} disabled={busy}>Back to chat</button></div>
    {notice && <p role="status" className="grok-tool-notice">{notice}</p>}
    {tool === 'create' && <form onSubmit={event => { event.preventDefault(); void act({ kind: 'create', targetKind: group ? 'group' : 'bot', name, description, ...(group ? { members } : {}) }, 'Created. Choose it in the bot list.').then(ok => { if (ok && live.current) { setName(''); setDescription(''); setMembers([]) } }) }}>
      <label>Type<select value={group ? 'group' : 'bot'} disabled={busy} onChange={event => setGroup(event.target.value === 'group')}><option value="bot">Bot</option><option value="group">Group</option></select></label>
      <label>Name<input value={name} maxLength={100} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Description<textarea value={description} maxLength={16384} disabled={busy} onChange={event => setDescription(event.target.value)} placeholder="What should this bot or group work on?" /></label>
      {group && memberPicker(members, setMembers)}
      <button className="btn" data-variant="primary" disabled={busy || !name.trim() || (group && !members.length)}>Create {group ? 'group' : 'bot'}</button>
    </form>}
    {tool === 'profile' && (profile ? <>
      <form onSubmit={event => { event.preventDefault(); void act({ kind: 'update', target: target!.id, targetKind, name: profile.name, title: profile.title, description: profile.description, notify: profile.notify, hidden: profile.hidden }, 'Profile saved.') }}>
        <label>Name<input value={profile.name} maxLength={100} required disabled={busy} onChange={event => setProfile({ ...profile, name: event.target.value })} /></label>
        <label>Title<input value={profile.title} maxLength={256} disabled={busy} onChange={event => setProfile({ ...profile, title: event.target.value })} /></label>
        <label>Description<textarea value={profile.description} maxLength={16384} disabled={busy} onChange={event => setProfile({ ...profile, description: event.target.value })} /></label>
        <label className="grok-check"><input type="checkbox" checked={profile.notify} disabled={busy} onChange={event => setProfile({ ...profile, notify: event.target.checked })} />Notify on bot updates</label>
        <label className="grok-check"><input type="checkbox" checked={profile.hidden} disabled={busy} onChange={event => setProfile({ ...profile, hidden: event.target.checked })} />Hide from the bot list</label>
        <button className="btn" data-variant="primary" disabled={busy || !profile.name.trim()}>Save profile</button>
      </form>
      {targetKind === 'group' && <form onSubmit={event => { event.preventDefault(); void act({ kind: 'members-set', target: target!.id, members: profile.members }, 'Group members saved.') }}>
        {memberPicker(profile.members, members => setProfile({ ...profile, members }))}<button className="btn" disabled={busy || !profile.members.length}>Save members</button>
      </form>}
      <div className="grok-danger">{confirm === target!.id ? <><p>Delete “{target!.name}” from {accountLabel}? This removes the {targetKind} from Grok Bot.</p><div className="btn-row"><button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button className="btn" disabled={busy} onClick={() => void act({ kind: 'delete', target: target!.id, targetKind }, 'Deleted. Choose another bot from the list.').then(ok => { if (ok && live.current) onClose() })}>Confirm delete</button></div></> : <button className="btn" disabled={busy} onClick={() => setConfirm(target!.id)}>Delete {targetKind}…</button>}</div>
    </> : <p>{busy ? 'Reading profile…' : 'Profile unavailable. Refresh the bot list and try again.'}</p>)}
    {tool === 'skills' && <>
      <p>Every bot in this account shares this library.</p><button className="btn" disabled={busy} onClick={() => void read()}>Refresh skills</button>
      <ul className="grok-tool-list">{skills.map(skill => <li key={skill.id}><strong>{skill.name}</strong><small>{skill.source}</small><p>{skill.description}</p>{skill.source === 'workflow' && (confirm === skill.id ? <div className="btn-row"><span>Remove this skill for every bot?</span><button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button className="btn" disabled={busy} onClick={() => void act({ kind: 'skill-remove', target: skill.id }, 'Skill removed.')}>Confirm removal</button></div> : <button className="btn" disabled={busy} onClick={() => setConfirm(skill.id)}>Remove…</button>)}</li>)}</ul>
      {!skills.length && <p>{busy ? 'Reading skills…' : 'No readable skills in this account.'}</p>}
      <form onSubmit={event => { event.preventDefault(); void act({ kind: 'skill-add', markdown }, 'Skill added.').then(ok => { if (ok && live.current) setMarkdown('') }) }}><label>Add SKILL.md contents<textarea value={markdown} maxLength={100000} disabled={busy} onChange={event => setMarkdown(event.target.value)} placeholder={'---\nname: research\ndescription: Research a topic\n---\n\nYour instructions…'} /></label><button className="btn" data-variant="primary" disabled={busy || !markdown.trim()}>Add shared skill</button></form>
    </>}
    {tool === 'approvals' && <>
      <p>Requests from the latest 200 entries. Review the action before allowing it.</p><button className="btn" disabled={busy} onClick={() => void read()}>Refresh approvals</button>
      <ul className="grok-tool-list">{approvals.map(card => <li key={`${card.entryId}:${card.requestId}`}><strong>{card.type === 'local-tool-permission' ? 'Command on your computer' : 'Review an action'}</strong><pre>{card.details || 'Open Grok Bot to inspect this request.'}</pre>{card.truncated && <p>Details are truncated. Review and accept in the Grok Bot app.</p>}<div className="btn-row"><button className="btn" disabled={busy} onClick={() => void act({ kind: 'approval-respond', target: target!.id, entryId: card.entryId, requestId: card.requestId, decision: 'decline' }, 'Request denied.')}>Deny</button><button className="btn" disabled={busy || card.truncated || !card.details} onClick={() => void act({ kind: 'approval-respond', target: target!.id, entryId: card.entryId, requestId: card.requestId, decision: 'accept' }, 'Allowed once.')}>Allow once</button></div></li>)}</ul>
      {!approvals.length && <p>{busy ? 'Reading approvals…' : 'No pending requests found in the latest 200 entries.'}</p>}
    </>}
    {tool === 'computer' && <>
      <p>Open the Grok Bot desktop app, check that its signed-in account matches <strong>{accountLabel}</strong>, then open <strong>Computer</strong>.</p>
      <p>Watch the desktop or choose <strong>Take over</strong> to use its browser and terminal. All bots in that account share the computer.</p>
      <button className="btn" data-variant="primary" disabled={busy} onClick={() => void act({ kind: 'desktop' }, 'Grok Bot opened.', false)}>Open Grok Bot desktop</button>
      <p className="plugin-muted">Desktop viewing and control happen in Grok Bot. Stoke keeps chat on your selected saved account; opening the desktop app does not switch its login.</p>
    </>}
  </div>
}
