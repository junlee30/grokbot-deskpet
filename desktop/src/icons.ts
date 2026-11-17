// Small inline interface icons (static markup, currentColor, 16-unit grid). SF Symbols aren't
// available to a webview, so these are drawn to sit next to the system font at 12–16 px.

// Gear: 8 teeth (a dashed ring, pathLength 16 → exactly 8 dash/gap pairs) over a solid ring.
// The half-dash offset centres a tooth on 0°/90°/180°/270°, so the glyph is mirror-symmetric
// on both axes and sits optically centred in a round button.
export const GEAR_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" pathLength="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="1 1" stroke-dashoffset="0.5"/><circle cx="8" cy="8" r="4.1" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';

export const CHECK_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const LOCK_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="7" rx="1.6" fill="currentColor"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
