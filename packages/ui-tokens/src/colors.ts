/**
 * Colour tokens  (F5)
 *
 * Raw values, not CSS. The web app turns these into custom properties and the
 * mobile app hands them to StyleSheet, so nothing here may assume a browser:
 * no `rgb()` strings with alpha channels React Native cannot parse, no `var()`,
 * no media queries.
 *
 * Two layers, and the distinction is the whole point:
 *
 *   palette   raw colours with numeric shades. Never referenced by a component.
 *   theme     semantic roles — surface, text, danger. This is what components
 *             use, and it is what changes between light and dark.
 *
 * A component that reaches past a role into the palette is the bug this
 * structure exists to prevent: it will look wrong in dark mode and nobody will
 * notice until a user complains.
 */

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const palette = {
  /** Brand. 500 is the accent everything else is derived from. */
  indigo: {
    50: '#EEF2FF',
    100: '#E0E7FF',
    200: '#C7D2FE',
    300: '#A5B4FC',
    400: '#818CF8',
    500: '#4F62E8',
    600: '#3D4ED1',
    700: '#323FAC',
    800: '#2A3689',
    900: '#26306D',
  },
  slate: {
    0: '#FFFFFF',
    25: '#FCFCFD',
    50: '#F7F8FA',
    100: '#EFF1F5',
    200: '#E2E6ED',
    300: '#CBD2DE',
    400: '#9AA4B8',
    500: '#6B7689',
    600: '#4C566B',
    700: '#38414F',
    800: '#232A35',
    900: '#161B23',
    950: '#0D1116',
  },
  green: { 100: '#DCFCE7', 400: '#4ADE80', 500: '#22A55B', 700: '#166534' },
  amber: { 100: '#FEF3C7', 400: '#FBBF24', 500: '#D97706', 700: '#92400E' },
  red: { 100: '#FEE2E2', 400: '#F87171', 500: '#DC2626', 700: '#991B1B' },
  blue: { 100: '#DBEAFE', 400: '#60A5FA', 500: '#2563EB', 700: '#1D4ED8' },
} as const;

// ---------------------------------------------------------------------------
// Semantic roles
// ---------------------------------------------------------------------------

export interface ThemeColors {
  // surfaces, back to front
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  overlay: string;

  // text, by emphasis
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;

  border: string;
  borderStrong: string;
  divider: string;

  // interactive
  accent: string;
  accentHover: string;
  accentMuted: string;
  accentText: string;
  focusRing: string;

  // status
  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  danger: string;
  dangerSurface: string;
  info: string;
  infoSurface: string;

  /** Live session states. A red dot means recording, everywhere. */
  live: string;
  recording: string;
  /** Presence, shared by community, chat and classroom. */
  presenceOnline: string;
  presenceAway: string;
  presenceInClass: string;
  presenceOffline: string;
}

export const lightTheme: ThemeColors = {
  background: palette.slate[50],
  surface: palette.slate[0],
  surfaceRaised: palette.slate[0],
  surfaceSunken: palette.slate[100],
  // Deliberately not a token with alpha: React Native wants 8-digit hex.
  overlay: '#161B23CC',

  textPrimary: palette.slate[900],
  textSecondary: palette.slate[600],
  textMuted: palette.slate[500],
  textInverse: palette.slate[0],

  border: palette.slate[200],
  borderStrong: palette.slate[300],
  divider: palette.slate[100],

  accent: palette.indigo[500],
  accentHover: palette.indigo[600],
  accentMuted: palette.indigo[50],
  accentText: palette.slate[0],
  focusRing: palette.indigo[400],

  success: palette.green[500],
  successSurface: palette.green[100],
  warning: palette.amber[500],
  warningSurface: palette.amber[100],
  danger: palette.red[500],
  dangerSurface: palette.red[100],
  info: palette.blue[500],
  infoSurface: palette.blue[100],

  live: palette.red[500],
  recording: palette.red[500],
  presenceOnline: palette.green[500],
  presenceAway: palette.amber[400],
  presenceInClass: palette.indigo[500],
  presenceOffline: palette.slate[400],
};

/**
 * Dark is not light inverted. Surfaces get lighter as they come forward, and
 * the accent is lifted a step because a mid-tone indigo on a near-black
 * background reads as muddy.
 */
export const darkTheme: ThemeColors = {
  background: palette.slate[950],
  surface: palette.slate[900],
  surfaceRaised: palette.slate[800],
  surfaceSunken: palette.slate[950],
  overlay: '#0D1116E6',

  textPrimary: palette.slate[50],
  textSecondary: palette.slate[300],
  textMuted: palette.slate[400],
  textInverse: palette.slate[900],

  border: palette.slate[800],
  borderStrong: palette.slate[700],
  divider: palette.slate[800],

  accent: palette.indigo[400],
  accentHover: palette.indigo[300],
  accentMuted: palette.indigo[900],
  accentText: palette.slate[950],
  focusRing: palette.indigo[300],

  success: palette.green[400],
  successSurface: palette.green[700],
  warning: palette.amber[400],
  warningSurface: palette.amber[700],
  danger: palette.red[400],
  dangerSurface: palette.red[700],
  info: palette.blue[400],
  infoSurface: palette.blue[700],

  live: palette.red[400],
  recording: palette.red[400],
  presenceOnline: palette.green[400],
  presenceAway: palette.amber[400],
  presenceInClass: palette.indigo[400],
  presenceOffline: palette.slate[600],
};

export const themes = { light: lightTheme, dark: darkTheme } as const;
export type ThemeName = keyof typeof themes;

/**
 * Flattens a theme into custom properties for the web build. The mobile app
 * never calls this — it passes the object straight to StyleSheet.
 */
export const toCssVariables = (theme: ThemeColors, prefix = '--c'): Record<string, string> =>
  Object.fromEntries(
    Object.entries(theme).map(([key, value]) => [
      `${prefix}-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      value,
    ]),
  );