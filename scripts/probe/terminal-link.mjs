/** CDP probe locator, serialized into the production renderer. The fixture
 * is ASCII and can span either soft or hard rows, including its last marker. */
export function terminalLinkPoint(terminal, target, screen, trimGutters = false) {
  const buffer = terminal.buffer.active
  let text = ''
  const cells = [], rows = []
  for (let y = buffer.viewportY; y < Math.min(buffer.length, buffer.viewportY + terminal.rows); y++) {
    const line = buffer.getLine(y), raw = line?.translateToString(true) || ''
    const value = trimGutters ? raw.trim() : raw
    const start = trimGutters ? Math.max(0, raw.search(/\S/)) : 0
    rows.push({ y, wrapped: line?.isWrapped })
    for (let x = 0; x < value.length; x++) cells.push({ x: x + start, y })
    text += value
  }
  const at = text.lastIndexOf(target)
  if (at < 0) return null
  const start = cells[at], end = cells[at + target.length - 1]
  return {
    x: screen.x + (end.x + .5) * screen.width / terminal.cols,
    y: screen.y + (end.y - buffer.viewportY + .5) * screen.height / terminal.rows,
    hardBoundary: rows.some(row => row.y > start.y && row.y <= end.y && !row.wrapped)
  }
}
