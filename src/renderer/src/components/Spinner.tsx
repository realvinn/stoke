/**
 * The busy mark for a button whose press is still being answered.
 *
 * A button that only greyed out while it worked read as refused, not busy —
 * "Check for updates" dropped to 45% opacity with the same label and looked
 * exactly like a button that could not be pressed. The house rule now, for
 * every check / refresh / look-again button:
 *
 *   - the button keeps `disabled`, so a second press cannot start a second run
 *     (gotchas 20 and 51 — the ref guard in the handler is the correctness
 *     half, `disabled` only the visible one);
 *   - it carries `aria-busy="true"`, which is what app.css reads to keep it at
 *     full strength instead of dimming it;
 *   - its label changes ("Checking…"), and this spinner sits before the label.
 *
 * The label is the part that carries the state; the spin only decorates it.
 * Under reduced motion the ring stands still (gotcha 72: the global block
 * would otherwise leave it at whatever frame 1ms of animation lands on), so a
 * button that swapped only the spinner in would say nothing to that user.
 *
 * Inside a `.btn` it is sized in `em` and drawn in `currentColor`, so it keeps
 * the label's own contrast on a primary or danger fill (gotchas 44 and 65)
 * rather than putting an accent arc on an accent button.
 */
export function Spinner(): React.JSX.Element {
  return <span className="spinner" aria-hidden="true" />
}
