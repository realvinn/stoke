import { createCart, formatPrice } from './js/cart.js'
import { ApiError, categories, fetchProducts, subscribe } from './js/api.js'

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const cart = createCart(window.localStorage)

let products = []
let activeCategory = 'all'
let pending = null

/* ------------------------------------------------------------ catalog */

function setStatus(text) {
  const status = $('[data-status]')
  status.textContent = text
  status.hidden = text === ''
}

function renderProducts(list) {
  const grid = $('[data-products]')
  const template = $('#product-card')
  const fragment = document.createDocumentFragment()

  for (const product of list) {
    const card = template.content.firstElementChild.cloneNode(true)
    card.dataset.sku = product.sku
    card.style.setProperty('--fern-tone', product.tone)
    card.style.setProperty('--fern-rating', String(product.rating))
    $('.card__title', card).textContent = product.name
    $('.card__blurb', card).textContent = product.blurb
    $('.card__price', card).textContent = formatPrice(product.price)
    $('[data-quick-view] .visually-hidden', card).textContent = `Quick view: ${product.name}`
    fragment.append(card)
  }

  grid.replaceChildren(fragment)
  observeReveals($$('.reveal', grid))
}

async function loadProducts(category = activeCategory) {
  pending?.abort()
  const controller = new AbortController()
  pending = controller
  setStatus('Loading the catalog…')

  try {
    products = await fetchProducts({ category, signal: controller.signal })
    renderProducts(products)
    setStatus(products.length ? '' : 'Nothing here yet. Try another category.')
  } catch (error) {
    if (error.name === 'AbortError') return
    const message = error instanceof ApiError ? error.message : 'Something went wrong.'
    setStatus(`${message} Pull to refresh, or try again in a moment.`)
  } finally {
    if (pending === controller) pending = null
  }
}

function initChips() {
  const chips = $$('.chip')
  const known = new Set(['all', ...categories()])

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const next = chip.dataset.category
      if (!known.has(next) || next === activeCategory) return
      activeCategory = next
      for (const other of chips) other.setAttribute('aria-pressed', String(other === chip))
      loadProducts(next)
    })
  }
}

/* --------------------------------------------------------- quick view */

function initQuickView() {
  const dialog = $('#quick-view')
  const qty = $('[data-qv-qty]', dialog)
  let current = null

  const open = (product) => {
    current = product
    qty.value = '1'
    $('[data-qv-title]', dialog).textContent = product.name
    $('[data-qv-price]', dialog).textContent = formatPrice(product.price)
    $('[data-qv-blurb]', dialog).textContent = product.blurb
    $('[data-qv-media]', dialog).style.background = product.tone
    dialog.showModal()
  }

  $('[data-products]').addEventListener('click', (event) => {
    const card = event.target.closest('.card')
    if (!card) return
    const product = products.find((item) => item.sku === card.dataset.sku)
    if (!product) return
    if (event.target.closest('[data-quick-view]')) open(product)
    if (event.target.closest('[data-add]')) addToCart(product, 1)
  })

  dialog.addEventListener('click', (event) => {
    // A click on the backdrop lands on the dialog itself, outside its box.
    const box = dialog.getBoundingClientRect()
    const inside = event.clientX >= box.left && event.clientX <= box.right
    if (!inside || event.clientY < box.top || event.clientY > box.bottom) dialog.close()
  })

  for (const step of $$('[data-step]', dialog)) {
    step.addEventListener('click', () => {
      const next = Number(qty.value) + Number(step.dataset.step)
      qty.value = String(Math.min(99, Math.max(1, next)))
    })
  }

  $('[data-qv-add]', dialog).addEventListener('click', () => {
    if (current) addToCart(current, Number(qty.value))
    dialog.close()
  })
}

/* -------------------------------------------------------------- cart */

function addToCart(product, quantity) {
  cart.add(product, quantity)
  const badge = $('[data-cart-count]')
  badge.classList.remove('bump')
  void badge.offsetWidth
  badge.classList.add('bump')
}

function renderCart() {
  const lines = $('[data-cart-lines]')
  const items = cart.entries()
  lines.replaceChildren(
    ...items.map(({ product, quantity }) => {
      const li = document.createElement('li')
      li.className = 'cart-line'
      li.innerHTML = '<span class="cart-line__name"></span><span class="cart-line__qty"></span>'
      li.firstElementChild.textContent = product.name
      li.lastElementChild.textContent = `× ${quantity}`
      return li
    })
  )
  $('[data-cart-count]').textContent = String(cart.count())
  $('[data-cart-subtotal]').textContent = formatPrice(cart.subtotal())
  $('[data-cart-empty]').hidden = items.length > 0
  $('[data-checkout]').disabled = items.length === 0
}

function initCartDrawer() {
  const drawer = $('#cart-drawer')
  const toggle = $('.cart-toggle')

  const setOpen = (open) => {
    drawer.dataset.open = String(open)
    toggle.setAttribute('aria-expanded', String(open))
    if (open) $('[data-cart-close]', drawer).focus()
  }

  toggle.addEventListener('click', () => setOpen(drawer.dataset.open !== 'true'))
  $('[data-cart-close]', drawer).addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawer.dataset.open === 'true') setOpen(false)
  })

  cart.subscribe(renderCart)
  renderCart()
}

/* ---------------------------------------------------------- carousel */

function initCarousel(root = $('#stories')) {
  const track = $('[data-track]', root)
  const slides = $$('.story', track)
  const dots = $('[data-dots]', root)
  let index = 0
  let timer = 0

  const go = (next) => {
    index = (next + slides.length) % slides.length
    const behavior = reducedMotion.matches ? 'auto' : 'smooth'
    track.scrollTo({ left: slides[index].offsetLeft, behavior })
    for (const [i, dot] of [...dots.children].entries()) {
      dot.setAttribute('aria-current', String(i === index))
    }
  }

  dots.replaceChildren(
    ...slides.map((_, i) => {
      const dot = document.createElement('button')
      dot.type = 'button'
      dot.className = 'stories__dot'
      dot.setAttribute('aria-label', `Story ${i + 1}`)
      dot.addEventListener('click', () => go(i))
      return dot
    })
  )

  const play = () => {
    if (reducedMotion.matches || timer) return
    timer = window.setInterval(() => go(index + 1), 6000)
  }
  const pause = () => {
    window.clearInterval(timer)
    timer = 0
  }

  $('[data-prev]', root).addEventListener('click', () => go(index - 1))
  $('[data-next]', root).addEventListener('click', () => go(index + 1))
  root.addEventListener('pointerenter', pause)
  root.addEventListener('pointerleave', play)
  root.addEventListener('focusin', pause)
  root.addEventListener('focusout', play)
  go(0)
  play()
}

/* --------------------------------------------------------- newsletter */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function showError(field, errorEl, message) {
  field.setAttribute('aria-invalid', String(Boolean(message)))
  errorEl.textContent = message
  errorEl.hidden = !message
}

function initNewsletter() {
  const form = $('[data-newsletter]')
  const email = $('#email', form)
  const consent = $('[name="consent"]', form)
  const success = $('.newsletter__success', form)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const value = email.value.trim()
    const emailProblem = EMAIL.test(value) ? '' : 'Enter an email like name@example.com.'
    const consentProblem = consent.checked ? '' : 'Tick the box so we may write to you.'
    showError(email, $('#email-error'), emailProblem)
    showError(consent, $('#consent-error'), consentProblem)
    if (!EMAIL.test(value) || !consent.checked) return

    const button = $('button[type="submit"]', form)
    button.disabled = true
    button.setAttribute('aria-busy', 'true')
    try {
      await subscribe(value)
      form.reset()
      success.hidden = false
    } catch (error) {
      showError(email, $('#email-error'), error.message)
    } finally {
      button.disabled = false
      button.removeAttribute('aria-busy')
    }
  })
}

/* ------------------------------------------------------ small things */

const revealer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('is-visible')
      revealer.unobserve(entry.target)
    }
  },
  { rootMargin: '0px 0px -10% 0px', threshold: 0.15 }
)

function observeReveals(elements) {
  for (const element of elements) revealer.observe(element)
}

function initHeaderShadow() {
  const header = $('.site-header')
  let queued = false
  window.addEventListener(
    'scroll',
    () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        header.dataset.elevated = String(window.scrollY > 8)
        queued = false
      })
    },
    { passive: true }
  )
}

document.addEventListener('DOMContentLoaded', () => {
  initChips()
  initQuickView()
  initCartDrawer()
  initCarousel()
  initNewsletter()
  initHeaderShadow()
  observeReveals($$('.reveal'))
  loadProducts()
})
