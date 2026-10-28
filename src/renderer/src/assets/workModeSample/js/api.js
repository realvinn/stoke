/**
 * A pretend storefront API. The catalog lives in this file and every call
 * waits a little, so loading states, cancellation and errors can be built
 * against something that behaves like a network without needing one.
 */

const CATALOG = Object.freeze([
  {
    sku: 'pk-ridge-38',
    name: 'Ridgeline 38 pack',
    category: 'packs',
    price: 21900,
    rating: 4.8,
    tone: '#7f9c86',
    blurb: 'Roll-top, waxed canvas body, a frame you can swap without tools.'
  },
  {
    sku: 'pk-day-18',
    name: 'Daybreak 18',
    category: 'packs',
    price: 11900,
    rating: 4.6,
    tone: '#b49a74',
    blurb: 'A day pack with a hip belt that disappears when you do not need it.'
  },
  {
    sku: 'sh-squall',
    name: 'Squall shell',
    category: 'shells',
    price: 27500,
    rating: 4.7,
    tone: '#4f6b78',
    blurb: 'Three-layer shell, pit zips, a hood that turns with your head.'
  },
  {
    sku: 'sh-drizzle',
    name: 'Drizzle wind shirt',
    category: 'shells',
    price: 13900,
    rating: 4.4,
    tone: '#8aa3a8',
    blurb: 'Packs into its own chest pocket; shrugs off a passing shower.'
  },
  {
    sku: 'cp-ember-stove',
    name: 'Ember simmer stove',
    category: 'camp',
    price: 8900,
    rating: 4.9,
    tone: '#c8642d',
    blurb: 'A burner that simmers for real, with a valve you can service.'
  },
  {
    sku: 'cp-hollow-pot',
    name: 'Hollow nesting pot',
    category: 'camp',
    price: 5400,
    rating: 4.5,
    tone: '#9a8f80',
    blurb: 'One litre, a lid that strains, and a stove that fits inside.'
  },
  {
    sku: 'sm-spares-kit',
    name: 'Field spares kit',
    category: 'small',
    price: 2400,
    rating: 4.9,
    tone: '#a7b48d',
    blurb: 'Buckles, cord locks, a needle and the right thread for our packs.'
  },
  {
    sku: 'sm-wool-beanie',
    name: 'Ridge wool beanie',
    category: 'small',
    price: 3200,
    rating: 4.3,
    tone: '#6d5f73',
    blurb: 'Knitted from offcuts of our sweater yarn, in whatever colour is left.'
  }
])

export class ApiError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Resolve after `ms`, or reject at once with an AbortError when `signal` aborts. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true }
    )
  })
}

/** The catalog, or one category of it, as copies the caller may change. */
export async function fetchProducts({ category = 'all', signal } = {}) {
  await wait(250 + Math.random() * 450, signal)
  if (category !== 'all' && !categories().includes(category)) {
    throw new ApiError(`There is no "${category}" section.`, 404)
  }
  return CATALOG.filter((item) => category === 'all' || item.category === category).map(
    (item) => ({ ...item })
  )
}

/** Sign an address up for the journal. */
export async function subscribe(email) {
  await wait(600)
  const value = String(email ?? '').trim()
  if (!value.includes('@') || value.length > 254) {
    throw new ApiError('That address does not look right.', 422)
  }
  if (value.endsWith('@example.com')) {
    throw new ApiError('Use a real inbox, not an example one.', 422)
  }
  return { ok: true, id: crypto.randomUUID() }
}

/** Every category the catalog holds, in the order it first lists them. */
export function categories() {
  return [...new Set(CATALOG.map((item) => item.category))]
}
