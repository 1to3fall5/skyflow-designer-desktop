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
