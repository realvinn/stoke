import type { Key } from 'node:readline'
import { nextCursor, previousCursor } from './input.ts'

export interface FormField {
  key: string
  label: string
  value: string
  placeholder?: string
  choices?: string[]
  cursor?: number
}
export interface MenuForm {
  title: string
  description: string
  fields: FormField[]
  focused: number
  submit: string
  error: string
}
export function insertFormText(form: MenuForm, text: string): void {
  const field = form.fields[form.focused]
  if (!field || field.choices) return
  const cursor = field.cursor ?? field.value.length
  const inserted = text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, Math.max(0, 2048 - field.value.length))
  field.value = field.value.slice(0, cursor) + inserted + field.value.slice(cursor)
  field.cursor = cursor + inserted.length
  form.error = ''
}
export function formKey(form: MenuForm, text: string | undefined, key: Key): 'save' | 'cancel' | void {
  if (key.name === 'escape' || key.name === 'f5' || key.ctrl && key.name === 'c') return 'cancel'
  if (key.ctrl && key.name === 's') return 'save'
  if (key.name === 'return') {
    if (form.focused === form.fields.length) return 'save'
    form.focused++
  } else if (key.name === 'tab' || key.name === 'down' || key.name === 'up') {
    const count = form.fields.length + 1
    form.focused = (form.focused + (key.shift || key.name === 'up' ? count - 1 : 1)) % count
  } else {
    const field = form.fields[form.focused]
    if (!field) return
    const cursor = field.cursor ?? field.value.length
    if (field.choices && (key.name === 'left' || key.name === 'right' || text === ' ')) {
      const choices = field.choices
      field.value = choices[(choices.indexOf(field.value) + (key.name === 'left' ? choices.length - 1 : 1)) % choices.length]
    } else if (!field.choices && key.name === 'left') field.cursor = previousCursor(field.value, cursor)
    else if (!field.choices && key.name === 'right') field.cursor = nextCursor(field.value, cursor)
    else if (!field.choices && (key.name === 'home' || key.ctrl && key.name === 'a')) field.cursor = 0
    else if (!field.choices && (key.name === 'end' || key.ctrl && key.name === 'e')) field.cursor = field.value.length
    else if (key.ctrl && key.name === 'u' && !field.choices) { field.value = ''; field.cursor = 0 }
    else if (key.name === 'backspace' && !field.choices) {
      const before = previousCursor(field.value, cursor)
      field.value = field.value.slice(0, before) + field.value.slice(cursor); field.cursor = before
    } else if (key.name === 'delete' && !field.choices) field.value = field.value.slice(0, cursor) + field.value.slice(nextCursor(field.value, cursor))
    else if (text && !key.ctrl && !key.meta && !text.includes('\x1b')) insertFormText(form, text)
  }
}
