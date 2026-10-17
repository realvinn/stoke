/** Read logical lines without mistaking an xterm soft wrap for a newline.
 * Self-contained so this exact function can run inside the owned CDP page. */
export function logicalTerminalText(buffer) {
  if (!buffer) return ''
  let text = ''
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    if (!line) continue
    if (row && !line.isWrapped) text += '\n'
    text += line.translateToString(!buffer.getLine(row + 1)?.isWrapped)
  }
  return text
}
