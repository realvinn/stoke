/**
 * A paste that a field's `maxLength` would cut, refused out loud.
 *
 * Chromium cuts pasted text at `maxlength` and fires nothing the page could
 * react to, so a 40,000-character log pasted into the Grok composer (32,768)
 * kept its first 32,768 characters, said nothing, and Send then sent the
 * shortened text. The same held for the hub remote tab's prompt (100,000) and
 * the Work fields. A paste is all or nothing here: refused whole with a note
 * naming the limit, the field unchanged and the clipboard untouched, so the
 * text can still go somewhere that takes it.
 *
 * Pure apart from `refuseOverlongPaste`, which only reads the event it is
 * handed, so `verify:browser-url` runs it under strip-types (no imports).
 */

/** The parts of an `<input>`/`<textarea>` the measure reads. */
export interface PasteField {
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  /** -1 (the DOM's "unset") or 0 means no limit. */
  maxLength: number
  /** A textarea keeps line breaks; a single-line input turns them into spaces. */
  multiline: boolean
}

/**
 * How long `text` is once the field has taken it, the way Blink measures it
 * against `maxlength`: a textarea's paste has CRLF and CR made LF
 * (CreateFragmentFromText); an input drops trailing breaks and turns each other
 * break into one space (TextFieldInputType::HandleBeforeTextInsertedEvent).
 */
export function pastedLength(text: string, multiline: boolean): number {
  if (multiline) return text.replace(/\r\n?/g, '\n').length
  return text.replace(/[\r\n]+$/, '').replace(/\r\n|[\r\n]/g, ' ').length
}

/** Thousands with commas, whatever the machine's locale: the note is read beside a number the user can count. */
function count(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * The note for a paste of `text` into `field` that would not fit whole, or null
 * when it fits or the field has no limit. Fitting exactly is fitting: Blink
 * cuts only past the limit.
 */
export function overlongPaste(field: PasteField, text: string): string | null {
  const max = field.maxLength
  if (!(max > 0) || !text) return null
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? start
  const kept = field.value.length - Math.max(0, end - start)
  const length = pastedLength(text, field.multiline)
  if (kept + length <= max) return null
  const room = Math.max(0, max - kept)
  const space = room === max ? `holds ${count(max)}` : room === 0 ? `is full (${count(max)})` : `has room for ${count(room)} more of its ${count(max)}`
  return `Not pasted: that is ${count(length)} character${length === 1 ? '' : 's'}, and this box ${space}. Your clipboard still has it.`
}

/** What `refuseOverlongPaste` reads off a React or DOM paste event. */
export interface PasteEventLike {
  currentTarget: { value: string; selectionStart: number | null; selectionEnd: number | null; maxLength: number; tagName: string }
  clipboardData: { getData(format: string): string } | null
  preventDefault(): void
}

/**
 * An `onPaste` for a field with a `maxLength`: a paste that would be cut is
 * cancelled, and its note returned for the field's own message line (a toast
 * would sit under the Settings scrim, gotcha 154). Null when it was let through.
 */
export function refuseOverlongPaste(event: PasteEventLike): string | null {
  const field = event.currentTarget
  const text = event.clipboardData?.getData('text/plain') ?? ''
  const note = overlongPaste({
    value: field.value,
    selectionStart: field.selectionStart,
    selectionEnd: field.selectionEnd,
    maxLength: field.maxLength,
    multiline: field.tagName.toUpperCase() === 'TEXTAREA'
  }, text)
  if (note) event.preventDefault()
  return note
}
