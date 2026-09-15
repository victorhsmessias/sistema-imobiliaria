/**
 * Icones de traco, desenhados na mesma grade de 16px. Decorativos por padrao:
 * o texto ao lado ou o aria-label do botao carrega o significado.
 */
const PATHS = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  plus: <path d="M8 3v10M3 8h10" />,
  chevronLeft: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  chevronRight: <path d="M6 3.5 10.5 8 6 12.5" />,
  logout: <><path d="M6 13.5H3.5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H6" /><path d="M10.5 11 13.5 8l-3-3M13.5 8H6" /></>,
  upload: <><path d="M8 10.5V2.5M5 5.5l3-3 3 3" /><path d="M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10" /></>,
  sliders: <><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="6" cy="11.5" r="1.5" /></>,
  network: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.5 1.6 2.2 3.4 2.2 5.5S9.5 11.9 8 13.5C6.5 11.9 5.8 10.1 5.8 8S6.5 4.1 8 2.5Z" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" /></>,
  image: <><rect x="2.5" y="3" width="11" height="10" rx="1" /><circle cx="6" cy="6.5" r="1" /><path d="m13.5 10.5-3-3-6 5.5" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
