// Line icons for the app chrome: 24×24, 2px strokes in currentColor.
const circle = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const PATHS = {
  menu: "M4 7h16M4 12h16M4 17h16",
  plus: "M12 5v14M5 12h14",
  search: `${circle(11, 11, 7)}M20 20l-4-4`,
  filter: "M4 6h16M7 12h10M10 18h4",
  folder: "M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z",
  chevron: "M7 10l5 5 5-5",
  bell: "M6 16v-5a6 6 0 1 1 12 0v5l2 2H4zM10 21h4",
  chart: "M5 20v-9M12 20V5M19 20v-7",
  clock: `${circle(12, 12, 9)}M12 7v5l3 2`,
  attach: "M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 7",
  pull: `${circle(6, 6, 2.25)}${circle(6, 18, 2.25)}${circle(18, 18, 2.25)}M6 8.25v7.5M18 15.75V10a3 3 0 0 0-3-3h-4M13.5 4.5 11 7l2.5 2.5`,
  files: "M8 3h7l4 4v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM15 3v4h4M3 8v11a2 2 0 0 0 2 2h9",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
  phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2",
  send: "M12 19V5M6 11l6-6 6 6",
  compare: "M12 4v16M8 20h8M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z",
  chat: "M4 5h16v11H9l-5 4z",
  terminal: "M4 17l6-5-6-5M12 19h8",
  globe: `${circle(12, 12, 9)}M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18`,
  note: "M5 4h10l4 4v12H5zM15 4v4h4M8 11h8M8 15h6",
  panel: "M4 5h16v14H4zM15 5v14",
  close: "M6 6l12 12M18 6L6 18",
  external: "M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  stop: "M7 7h10v10H7z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, class: cls = "" }: { name: IconName; class?: string }) {
  return (
    <svg class={`icon ${cls}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
