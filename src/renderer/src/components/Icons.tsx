import type { SVGProps } from 'react'

/** One consistent icon vocabulary: 16px grid, 1.5 stroke, round caps. */
function Base(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  const { children, ...rest } = props
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPlus = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M8 3.5v9M3.5 8h9" />
  </Base>
)

export const IconClose = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Base>
)

export const IconSearch = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <circle cx="7.2" cy="7.2" r="3.9" />
    <path d="M10.2 10.2L13 13" />
  </Base>
)

/* Drawn on a 24 grid: the toothed profile needs the extra resolution to stay
   legible at 16px, where the 16-grid version read as a sun. */
export const IconGear = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base viewBox="0 0 24 24" strokeWidth="1.9" {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.5 12c0-.5-.05-1-.14-1.47l2.02-1.5-2-3.46-2.37.92a7.7 7.7 0 0 0-2.55-1.48L14.2 2.5h-4l-.26 2.51A7.7 7.7 0 0 0 7.4 6.49l-2.38-.92-2 3.46 2.02 1.5a7.6 7.6 0 0 0 0 2.94l-2.02 1.5 2 3.46 2.37-.92a7.7 7.7 0 0 0 2.55 1.48l.26 2.51h4l.26-2.51a7.7 7.7 0 0 0 2.55-1.48l2.37.92 2-3.46-2.02-1.5c.09-.47.14-.96.14-1.47z" />
  </Base>
)

export const IconGlobe = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M2.4 8h11.2M8 2.4c1.5 1.6 2.2 3.6 2.2 5.6S9.5 12 8 13.6C6.5 12 5.8 10 5.8 8S6.5 4 8 2.4z" />
  </Base>
)

export const IconChevron = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </Base>
)

export const IconArrowLeft = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M12.5 8h-9M7 3.5L2.5 8 7 12.5" />
  </Base>
)

export const IconArrowRight = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M3.5 8h9M9 3.5L13.5 8 9 12.5" />
  </Base>
)

export const IconRefresh = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M13.2 6.8A5.4 5.4 0 1 0 13 10" />
    <path d="M13.4 2.9v3.9h-3.9" />
  </Base>
)

export const IconExternal = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M9.2 2.8h4v4M13.2 2.8L7.6 8.4" />
    <path d="M12 9.6v3a1.2 1.2 0 0 1-1.2 1.2h-7.6A1.2 1.2 0 0 1 2 12.6V5a1.2 1.2 0 0 1 1.2-1.2h3" />
  </Base>
)

export const IconFolder = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M2 4.6a1.1 1.1 0 0 1 1.1-1.1h2.6l1.3 1.7h5.9A1.1 1.1 0 0 1 14 6.3v5.1a1.1 1.1 0 0 1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 11.4z" />
  </Base>
)

export const IconPin = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M6 2.2h4l-.6 3.4 2.1 2.1H4.5l2.1-2.1z" />
    <path d="M8 7.7v6.1" />
  </Base>
)

export const IconSidebar = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" />
    <path d="M6.4 3.2v9.6" />
  </Base>
)

export const IconMinus = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M3.5 8h9" />
  </Base>
)

export const IconStar = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M8 2.3l1.75 3.55 3.92.57-2.84 2.76.67 3.9L8 11.24l-3.5 1.84.67-3.9L2.33 6.42l3.92-.57z" />
  </Base>
)

export const IconCode = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" />
  </Base>
)

/** Hand the current page to Claude. */
export const IconAsk = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p}>
    <path d="M13.5 9.6a1.4 1.4 0 0 1-1.4 1.4H6.2L3.5 13.4V4.3a1.4 1.4 0 0 1 1.4-1.4h7.2a1.4 1.4 0 0 1 1.4 1.4z" />
    <path d="M6.6 6.6h3.8M6.6 8.6h2.4" />
  </Base>
)

export const IconMinimize = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p} strokeWidth="1.2">
    <path d="M3 8h10" />
  </Base>
)

export const IconMaximize = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p} strokeWidth="1.2">
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.2" />
  </Base>
)

export const IconRestore = (p: SVGProps<SVGSVGElement>): React.JSX.Element => (
  <Base {...p} strokeWidth="1.2">
    <rect x="3.2" y="5.4" width="7.4" height="7.4" rx="1.2" />
    <path d="M5.7 5.4V4.4a1.2 1.2 0 0 1 1.2-1.2h4.7a1.2 1.2 0 0 1 1.2 1.2v4.7a1.2 1.2 0 0 1-1.2 1.2h-1" />
  </Base>
)

/** The app mark: a stylised flame, drawn filled rather than stroked. */
export function BrandMark(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      className="brand-mark"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M8 1.2c2.6 2.4 4.6 4.5 4.6 7.2a4.6 4.6 0 1 1-9.2 0c0-1.3.5-2.4 1.3-3.5.3 1 .9 1.7 1.6 2 .1-2.2.7-4 1.7-5.7z"
        fill="var(--accent)"
      />
      <path
        d="M8 14.4a2.5 2.5 0 0 1-2.5-2.5c0-1.5 1.2-2.5 2.5-4.3 1.3 1.8 2.5 2.8 2.5 4.3A2.5 2.5 0 0 1 8 14.4z"
        fill="var(--bg-sunken)"
      />
    </svg>
  )
}
