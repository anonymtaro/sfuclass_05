/**
 * Type tokens  (F5)
 *
 * A type scale, weights, and named text styles. As with spacing, sizes are
 * numbers: React Native cannot parse 'rem' and the web helper converts.
 *
 * Line heights are stored as multipliers, not as absolute values, because a
 * caption and a heading at the same multiplier stay proportional when someone
 * raises their system font size. Both platforms then compute the pixel value
 * themselves.
 */

export const fontFamily = {
  /**
   * System stacks on both platforms. A webfont would cost a render-blocking
   * request on the web and an asset bundle on mobile, and a classroom app is
   * read, not admired.
   */
  sans: {
    web: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    ios: 'System',
    android: 'Roboto',
  },
  /** Code blocks in lesson documents, and anything showing an id. */
  mono: {
    web: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
    ios: 'Menlo',
    android: 'monospace',
  },
} as const;

export const fontSize = {
  '2xs': 11,
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
  '5xl': 48,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/** Multipliers. Tight for headings, loose for anything read at length. */
export const lineHeight = {
  none: 1,
  tight: 1.2,
  snug: 1.35,
  normal: 1.5,
  relaxed: 1.65,
} as const;

export const letterSpacing = {
  tighter: -0.4,
  tight: -0.2,
  normal: 0,
  wide: 0.4,
  /** Small uppercase labels need air or they read as one word. */
  wider: 0.8,
} as const;

export interface TextStyle {
  fontSize: number;
  lineHeight: number;
  fontWeight: string;
  letterSpacing: number;
  textTransform?: 'none' | 'uppercase';
}

const style = (
  size: number,
  height: number,
  weight: string = fontWeight.regular,
  spacing: number = letterSpacing.normal,
): TextStyle => ({
  fontSize: size,
  lineHeight: Math.round(size * height),
  fontWeight: weight,
  letterSpacing: spacing,
});

/**
 * Named roles. Components use these, not raw sizes — the same reasoning as
 * semantic colours: a component that picks `fontSize['2xl']` directly will
 * drift away from every other heading in the product.
 */
export const text = {
  displayLg: style(fontSize['5xl'], lineHeight.tight, fontWeight.bold, letterSpacing.tighter),
  displaySm: style(fontSize['4xl'], lineHeight.tight, fontWeight.bold, letterSpacing.tighter),

  h1: style(fontSize['3xl'], lineHeight.tight, fontWeight.semibold, letterSpacing.tight),
  h2: style(fontSize['2xl'], lineHeight.snug, fontWeight.semibold, letterSpacing.tight),
  h3: style(fontSize.xl, lineHeight.snug, fontWeight.semibold),
  h4: style(fontSize.lg, lineHeight.snug, fontWeight.semibold),

  /** Lesson documents and long posts. Relaxed, because people read these. */
  prose: style(fontSize.base, lineHeight.relaxed),
  body: style(fontSize.base, lineHeight.normal),
  bodySm: style(fontSize.sm, lineHeight.normal),

  /** Chat: slightly tighter, because density matters in a message list. */
  message: style(fontSize.sm, lineHeight.snug),
  messageMeta: style(fontSize.xs, lineHeight.normal, fontWeight.medium),

  label: style(fontSize.sm, lineHeight.normal, fontWeight.medium),
  caption: style(fontSize.xs, lineHeight.normal),
  overline: {
    ...style(fontSize['2xs'], lineHeight.normal, fontWeight.semibold, letterSpacing.wider),
    textTransform: 'uppercase' as const,
  },

  button: style(fontSize.sm, lineHeight.none, fontWeight.semibold),
  code: style(fontSize.sm, lineHeight.normal),
} as const;

export type TextRole = keyof typeof text;

/** Web helper: a TextStyle as CSS properties. */
export const toCssText = (value: TextStyle): Record<string, string> => ({
  'font-size': `${value.fontSize}px`,
  'line-height': `${value.lineHeight}px`,
  'font-weight': value.fontWeight,
  'letter-spacing': `${value.letterSpacing}px`,
  ...(value.textTransform ? { 'text-transform': value.textTransform } : {}),
});