/**
 * Tool glyphs, inlined as SVG path data.
 *
 * Adobe's own tool icons are off limits, so these are Lucide (ISC) — the same
 * set PhotoCraft ships in `assets/icons/`. They are stroke-based on a 24 grid
 * and inherit `currentColor`, which is what lets the toolbox tint them with
 * plain CSS instead of shipping two sets of files.
 *
 * The Unicode glyphs these replace (✎ ⌫ ✦ ⌖ ✥) came from five different
 * fonts, so they never lined up and two of them fell back to emoji on some
 * machines.
 *
 * Source: https://github.com/lucide-icons/lucide — ISC license.
 */

/** 24x24 viewBox path data, one entry per `<path>`. */
const PATHS: Record<string, string[]> = {
  // lucide:brush
  brush: [
    'm11 10 3 3',
    'M6.5 21A3.5 3.5 0 1 0 3 17.5a2.62 2.62 0 0 1-.708 1.792A1 1 0 0 0 3 21z',
    'M9.969 17.031 21.378 5.624a1 1 0 0 0-3.002-3.002L6.967 14.031',
  ],
  // A pen nib: the rhombus, the slit down to the point, and the vent hole.
  //
  // Hand-drawn rather than Lucide's `pen`, which is a *pencil* — next to the
  // brush in the toolbox the two were a pair of near-identical diagonals you
  // had to read the tip of to tell apart. The nib is a shape nothing else in
  // the box uses.
  pen: [
    'M12 2 6 13l6 9 6-9z',
    'M12 14v8',
    'M12 11.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z',
  ],
  // lucide:eraser
  eraser: [
    'M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21',
    'm5.082 11.09 8.828 8.828',
  ],
  // lucide:wand
  wand: [
    'M15 4V2',
    'M15 16v-2',
    'M8 9h2',
    'M20 9h2',
    'M17.8 11.8 19 13',
    'M15 9h.01',
    'M17.8 6.2 19 5',
    'm3 21 9-9',
    'M12.2 6.2 11 5',
  ],
  // lucide:pipette
  pipette: [
    'm12 9-8.414 8.414A2 2 0 0 0 3 18.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 3.828 21h1.344a2 2 0 0 0 1.414-.586L15 12',
    'm18 9 .4.4a1 1 0 1 1-3 3l-3.8-3.8a1 1 0 1 1 3-3l.4.4 3.4-3.4a1 1 0 1 1 3 3z',
    'm2 22 .414-.414',
  ],
  // lucide:hand
  hand: [
    'M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2',
    'M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2',
    'M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8',
    'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  ],

  // --- panel icons -------------------------------------------------------
  // Photoshop's panels are button-and-icon rows, not rows of words: the layer
  // panel is a strip of icons for new / delete / reorder, and each row leads
  // with an eye. Words there would cost the width the thumbnails need.

  // lucide:wind
  wind: [
    'M12.8 19.6A2 2 0 1 0 14 16H2',
    'M17.5 8a2.5 2.5 0 1 1 2 4H2',
    'M9.8 4.4A2 2 0 1 1 11 8H2',
  ],
  // lucide:box
  box: [
    'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
    'm3.3 7 8.7 5 8.7-5',
    'M12 22V12',
  ],
  // lucide:trash-2
  trash: [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ],
  // lucide:chevron-up / chevron-down / chevron-right
  up: ['m18 15-6-6-6 6'],
  down: ['m6 9 6 6 6-6'],
  right: ['m9 18 6-6-6-6'],
  // Layer visibility. Photoshop's two states for the eye column are an **eye**
  // and a **hollow square** — not an eye and a struck-through eye. A
  // struck-through glyph is one shape you have to decode per row; eyes against
  // boxes is a column you can scan straight down.
  //
  // Hand-drawn from the same primitives rather than copied, so the two are
  // guaranteed to sit on the same optical size.
  eye: [
    'M2 12c2.2-3.8 5.7-7 10-7s7.8 3.2 10 7c-2.2 3.8-5.7 7-10 7s-7.8-3.2-10-7z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  sq: [
    'M6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z',
  ],
  // Layer effects. Photoshop's own `fx` badge is a small four-point star, and
  // that is the mark people look for down the right-hand side of the layer
  // list — a sliders or wand glyph would read as a tool, not as a badge.
  fx: [
    'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    'M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  ],
  // Delete one effect. Deliberately a plain cross and not a bin: a bin means
  // "throw the whole thing away", and this only removes one row from a list.
  x: ['M6 6l12 12', 'M18 6L6 18'],
};

export type IconName = keyof typeof PATHS;

export function ToolIcon({ name, size = 18 }: { name: string; size?: number }) {
  const paths = PATHS[name];
  if (!paths) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="tool-glyph"
    >
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}
