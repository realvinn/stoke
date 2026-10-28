/**
 * The cart: a map of lines kept in memory, mirrored to storage, and a set of
 * listeners told after every change. Prices are whole cents throughout, so a
 * subtotal never picks up a rounding error.
 */

export const STORAGE_KEY = 'fernway.cart.v2'

const MAX_QUANTITY = 99
const formatters = new Map()

/** `cents` as money, with one formatter per currency and locale. */
export function formatPrice(cents, currency = 'USD', locale = navigator.language) {
  const key = `${locale}|${currency}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: 'currency', currency })
    formatters.set(key, formatter)
  }
  return formatter.format(cents / 100)
}

function clampQuantity(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return 0
  return Math.min(MAX_QUANTITY, Math.max(0, n))
}

/** A cart over `storage` (localStorage, or anything with getItem and setItem). */
export function createCart(storage, key = STORAGE_KEY) {
  const lines = new Map()
  const listeners = new Set()

  function load() {
    let saved = null
    try {
      saved = JSON.parse(storage.getItem(key) ?? 'null')
    } catch {
      // A cart written by an older build, or by hand: start empty rather than fail.
      saved = null
    }
    if (!Array.isArray(saved)) return
    for (const line of saved) {
      if (!line || typeof line.sku !== 'string' || !line.product) continue
      const quantity = clampQuantity(line.quantity)
      if (quantity > 0) lines.set(line.sku, { product: line.product, quantity })
    }
  }

  function persist() {
    const data = [...lines].map(([sku, line]) => ({ sku, ...line }))
    try {
      storage.setItem(key, JSON.stringify(data))
    } catch {
      // Private mode, or storage full: the cart still works for this visit.
    }
  }

  function emit() {
    persist()
    for (const listener of listeners) {
      try {
        listener(api)
      } catch (error) {
        console.error('cart listener failed', error)
      }
    }
  }

  function add(product, quantity = 1) {
    const current = lines.get(product.sku)?.quantity ?? 0
    const next = clampQuantity(current + quantity)
    if (next === current) return
    lines.set(product.sku, { product, quantity: next })
    emit()
  }

  function setQuantity(sku, quantity) {
    const line = lines.get(sku)
    if (!line) return
    const next = clampQuantity(quantity)
    if (next === 0) lines.delete(sku)
    else lines.set(sku, { ...line, quantity: next })
    emit()
  }

  function remove(sku) {
    if (lines.delete(sku)) emit()
  }

  function clear() {
    if (lines.size === 0) return
    lines.clear()
    emit()
  }

  function count() {
    let total = 0
    for (const line of lines.values()) total += line.quantity
    return total
  }

  function subtotal() {
    let cents = 0
    for (const { product, quantity } of lines.values()) cents += product.price * quantity
    return cents
  }

  function entries() {
    return [...lines.values()].map((line) => ({ ...line }))
  }

  /** Call `listener` after every change; the answer stops it. */
  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const api = Object.freeze({
    add,
    setQuantity,
    remove,
    clear,
    count,
    subtotal,
    entries,
    subscribe
  })

  load()
  return api
}
