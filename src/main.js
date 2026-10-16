import './style.css'
import { drawScope } from './scope.js'

const root = document.documentElement

// ----- Theme toggle (remembers choice, otherwise follows the OS) -----
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')
const currentTheme = () => root.dataset.theme || (prefersDark.matches ? 'dark' : 'light')

document.querySelector('.theme-toggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  root.dataset.theme = next
  try {
    localStorage.setItem('theme', next)
  } catch {}
})

// ----- Mobile menu -----
const menuToggle = document.querySelector('.menu-toggle')
const navLinks = document.querySelector('.nav-links')

const setMenu = (open) => {
  navLinks.classList.toggle('open', open)
  menuToggle.setAttribute('aria-expanded', String(open))
  menuToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
}

menuToggle.addEventListener('click', () => setMenu(!navLinks.classList.contains('open')))
navLinks.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => setMenu(false)))

// ----- Highlight the nav link for the section in view -----
const links = new Map([...navLinks.querySelectorAll('a[href^="#"]')].map((a) => [a.hash.slice(1), a]))

const navObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      links.forEach((a) => a.classList.remove('active'))
      links.get(entry.target.id)?.classList.add('active')
    }
  },
  { rootMargin: '-45% 0px -50% 0px' },
)
document.querySelectorAll('main section[id]').forEach((s) => navObserver.observe(s))

// ----- Hero oscilloscope -----
const scope = document.querySelector('.scope')
if (scope) drawScope(scope)

// ----- Project galleries -----
// Thumbnails slide the main image; clicking the main image opens a larger view.
// The multi-image card nearest the middle of the screen advances on its own every SLIDE_MS.
const SLIDE_MS = 4000
document.documentElement.style.setProperty('--slide-duration', `${SLIDE_MS}ms`) // drives the countdown bar
const lightbox = document.querySelector('.lightbox')
const lightboxImg = lightbox?.querySelector('img')
const lightboxCaption = lightbox?.querySelector('figcaption')
let lightboxImages = []
let lightboxIndex = 0

const showInLightbox = (i) => {
  lightboxIndex = (i + lightboxImages.length) % lightboxImages.length
  const { src, alt } = lightboxImages[lightboxIndex]
  lightboxImg.src = src
  lightboxImg.alt = alt
  lightboxCaption.textContent =
    lightboxImages.length > 1 ? `${alt} (${lightboxIndex + 1} of ${lightboxImages.length})` : alt
}

// Covers without images (placeholders) are left out
const galleries = [...document.querySelectorAll('.project-cover')].filter((c) => c.querySelector('.cover-track')).map((cover) => {
  const track = cover.querySelector('.cover-track')
  const images = [...track.querySelectorAll('img')]
  const thumbs = [...cover.querySelectorAll('.thumb')]
  const g = { cover, images, current: 0, focused: false }

  g.show = (i) => {
    g.current = (i + images.length) % images.length
    track.style.transform = `translateX(${-100 * g.current}%)`
    images.forEach((img, j) => img.setAttribute('aria-hidden', String(j !== g.current)))
    thumbs.forEach((t, j) => {
      t.classList.toggle('is-active', j === g.current)
      t.setAttribute('aria-pressed', String(j === g.current))
    })
  }
  g.show(0)

  thumbs.forEach((thumb, i) =>
    thumb.addEventListener('click', () => {
      g.show(i)
      autoplay.restart()
    }),
  )

  cover.querySelector('.cover-main').addEventListener('click', () => {
    if (!lightbox) return
    lightboxImages = images.map((img) => ({ src: img.src, alt: img.alt }))
    lightbox.classList.toggle('single', images.length < 2)
    showInLightbox(g.current)
    lightbox.showModal()
    autoplay.restart()
  })

  // Keyboard focus inside a card holds it still. (Not hover: the pointer usually rests on
  // whatever card is mid-screen, which would stop the slideshow from ever running.)
  const hold = (on) => {
    g.focused = on
    autoplay.restart()
  }
  cover.addEventListener('focusin', () => hold(true))
  cover.addEventListener('focusout', (e) => {
    if (!cover.contains(e.relatedTarget)) hold(false)
  })
  return g
})

const autoplay = {
  active: null,
  timer: 0,
  // The card on screen whose center is closest to the screen's center; it only slides if it has
  // more than one image, so a single-image card in the middle keeps the others still
  pick() {
    const mid = window.innerHeight / 2
    let best = null
    let bestDist = Infinity
    // Every card counts, placeholders included, so a placeholder in the middle keeps the rest still
    for (const cover of document.querySelectorAll('.project-cover')) {
      const r = cover.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) continue
      const dist = Math.abs(r.top + r.height / 2 - mid)
      if (dist < bestDist) [best, bestDist] = [cover, dist]
    }
    best = galleries.find((g) => g.cover === best && g.images.length > 1) ?? null
    if (best !== this.active) {
      this.active = best
      this.restart()
    }
  },
  restart() {
    clearTimeout(this.timer)
    galleries.forEach((g) => g.cover.classList.remove('playing'))
    const g = this.active
    if (!g || g.focused || lightbox?.open || document.hidden) return
    void g.cover.offsetWidth // restart the progress bar animation
    g.cover.classList.add('playing')
    this.timer = setTimeout(() => {
      g.show(g.current + 1)
      this.restart()
    }, SLIDE_MS)
  },
}

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  let queued = false
  window.addEventListener(
    'scroll',
    () => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        autoplay.pick()
      })
    },
    { passive: true },
  )
  window.addEventListener('resize', () => autoplay.pick())
  document.addEventListener('visibilitychange', () => autoplay.restart())
  lightbox?.addEventListener('close', () => autoplay.restart())
  autoplay.pick()
} else {
  autoplay.restart = () => {}
}

if (lightbox) {
  lightbox.querySelector('.lightbox-close').addEventListener('click', () => lightbox.close())
  lightbox.querySelector('.lightbox-prev').addEventListener('click', () => showInLightbox(lightboxIndex - 1))
  lightbox.querySelector('.lightbox-next').addEventListener('click', () => showInLightbox(lightboxIndex + 1))
  // A click on the dimmed backdrop (the dialog itself, outside its contents) closes it
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.close()
  })
  lightbox.addEventListener('keydown', (e) => {
    if (lightboxImages.length < 2) return
    if (e.key === 'ArrowLeft') showInLightbox(lightboxIndex - 1)
    if (e.key === 'ArrowRight') showInLightbox(lightboxIndex + 1)
  })
}

// ----- Footer year -----
document.getElementById('year').textContent = new Date().getFullYear()
