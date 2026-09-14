/**
 * Spacing, radii, elevation and layout  (F5)
 *
 * A 4px base scale. Every gap, pad and inset in both apps comes from here, so
 * that a card in the web course builder and a card in the mobile course viewer
 * are recognisably the same object.
 *
 * Values are unitless numbers, not '16px' strings. React Native requires
 * numbers; the web helper appends px. Storing strings would make the tokens
 * unusable on one of the two platforms, which defeats the point of the package.
 */

export const space = {
  0: 0,
  px: 1,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
} as const;

export type SpaceToken = keyof typeof space;

export const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
  /** Pills and avatars. Large rather than 9999 so RN does not clip oddly. */
  full: 999,
} as const;

export const borderWidth = { none: 0, hairline: 1, thin: 1, thick: 2 } as const;

/**
 * Elevation as data, not as a shadow string. The web helper builds a box-shadow
 * and the mobile one maps to shadowOffset/shadowRadius plus Android elevation —
 * the same visual intent expressed twice, from one source.
 */
export interface Elevation {
  offsetY: number;
  blur: number;
  spread: number;
  opacity: number;
  /** Android's own shadow system ignores the rest of these. */
  androidElevation: number;
}

export const elevation: Record<'none' | 'sm' | 'md' | 'lg' | 'xl', Elevation> = {
  none: { offsetY: 0, blur: 0, spread: 0, opacity: 0, androidElevation: 0 },
  sm: { offsetY: 1, blur: 2, spread: 0, opacity: 0.06, androidElevation: 1 },
  md: { offsetY: 2, blur: 8, spread: -1, opacity: 0.08, androidElevation: 3 },
  lg: { offsetY: 8, blur: 24, spread: -4, opacity: 0.12, androidElevation: 8 },
  xl: { offsetY: 16, blur: 40, spread: -8, opacity: 0.16, androidElevation: 16 },
};

export const toBoxShadow = (level: Elevation, color = '#161B23'): string =>
  level.blur === 0
    ? 'none'
    : `0 ${level.offsetY}px ${level.blur}px ${level.spread}px ${color}${Math.round(
        level.opacity * 255,
      )
        .toString(16)
        .padStart(2, '0')}`;

/**
 * Breakpoints. The mobile app ignores all but `sm`, which it uses to tell a
 * phone from a tablet — a tablet gets the two-column classroom layout.
 */
export const breakpoint = { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } as const;

/** Stacking order, in one place, so nothing has to guess a z-index. */
export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 100,
  /** The chat dock floats above content but below anything modal. */
  dock: 200,
  overlay: 300,
  modal: 400,
  popover: 500,
  toast: 600,
  /** A screen share pinned to the top of a lesson outranks everything. */
  screenShare: 700,
} as const;

/** Minimum touch target. Below this, people miss on a phone. */
export const minTouchTarget = 44;

export const layout = {
  maxContentWidth: 1200,
  maxProseWidth: 680,
  sidebarWidth: 280,
  chatDockWidth: 360,
  /** The lesson filmstrip beside a pinned screen share. */
  filmstripWidth: 200,
} as const;

export const px = (value: number): string => `${value}px`;