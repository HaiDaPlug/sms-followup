/**
 * One small, consistent icon set: 16px grid, 1.75 stroke, currentColor.
 * Inline SVG on purpose — no icon dependency, and every glyph inherits text color.
 */

type IconProps = { size?: number; className?: string; strokeWidth?: number };

function Svg({
  size = 16,
  className,
  strokeWidth = 1.75,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></Svg>
);
export const IconX = (p: IconProps) => (
  <Svg {...p}><path d="M4 4l8 8M12 4l-8 8" /></Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M3 8.5l3.2 3L13 4.5" /></Svg>
);
export const IconSend = (p: IconProps) => (
  <Svg {...p}><path d="M14 2L7 9" /><path d="M14 2l-4.5 12L7 9 2 6.5 14 2z" /></Svg>
);
export const IconCalendar = (p: IconProps) => (
  <Svg {...p}><rect x="2" y="3" width="12" height="11" rx="1.5" /><path d="M2 6.5h12M5 1.75v2.5M11 1.75v2.5" /></Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 4.75V8l2.25 1.5" /></Svg>
);
export const IconMore = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.4}><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" /></Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 4h11M6 4V2.75A.75.75 0 016.75 2h2.5a.75.75 0 01.75.75V4M12.25 4l-.6 8.6a1.5 1.5 0 01-1.5 1.4H5.85a1.5 1.5 0 01-1.5-1.4L3.75 4" /></Svg>
);
export const IconBan = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M3.75 3.75l8.5 8.5" /></Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M13.5 5.5A6 6 0 003.1 4.4L2 5.5M2.5 10.5a6 6 0 0010.4 1.1L14 10.5" /><path d="M2 2.5v3h3M14 13.5v-3h-3" /></Svg>
);
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}><path d="M3 8h10M9 4l4 4-4 4" /></Svg>
);
export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}><path d="M13 8H3M7 4L3 8l4 4" /></Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="M4 6l4 4 4-4" /></Svg>
);
export const IconAlert = (p: IconProps) => (
  <Svg {...p}><path d="M8 1.75L14.5 13.5h-13L8 1.75z" /><path d="M8 6.25v3.25M8 11.6h.01" /></Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 7.25V11M8 5h.01" /></Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}><circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" /><path d="M11 3.2a2.5 2.5 0 010 4.6M12.5 9.7c1.3.5 2 1.8 2 3.8" /></Svg>
);
export const IconUser = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="5" r="3" /><path d="M2.5 14c0-3 2.5-4.75 5.5-4.75S13.5 11 13.5 14" /></Svg>
);
export const IconPhone = (p: IconProps) => (
  <Svg {...p}><path d="M3 2h2.5l1.25 3.25-1.6 1a7.5 7.5 0 003.6 3.6l1-1.6L13 9.5V12a1.5 1.5 0 01-1.5 1.5A10.5 10.5 0 011.5 3.5 1.5 1.5 0 013 2z" /></Svg>
);
export const IconMail = (p: IconProps) => (
  <Svg {...p}><rect x="1.75" y="3" width="12.5" height="10" rx="1.5" /><path d="M2 4l6 5 6-5" /></Svg>
);
export const IconMessage = (p: IconProps) => (
  <Svg {...p}><path d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H5.5L2 14.5V4a1 1 0 011-1z" /></Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>
);
export const IconUpload = (p: IconProps) => (
  <Svg {...p}><path d="M8 11V2.5M4.75 5.75L8 2.5l3.25 3.25" /><path d="M2.5 10.5v2A1.5 1.5 0 004 14h8a1.5 1.5 0 001.5-1.5v-2" /></Svg>
);
export const IconFile = (p: IconProps) => (
  <Svg {...p}><path d="M9.5 1.75H4.25A1.25 1.25 0 003 3v10a1.25 1.25 0 001.25 1.25h7.5A1.25 1.25 0 0013 13V5.25L9.5 1.75z" /><path d="M9.5 1.75v3.5H13" /></Svg>
);
export const IconSparkle = (p: IconProps) => (
  <Svg {...p}><path d="M8 1.75l1.4 4.1 4.1 1.4-4.1 1.4L8 12.75l-1.4-4.1-4.1-1.4 4.1-1.4L8 1.75z" /></Svg>
);
export const IconPause = (p: IconProps) => (
  <Svg {...p}><path d="M5.5 3v10M10.5 3v10" /></Svg>
);
export const IconFlask = (p: IconProps) => (
  <Svg {...p}><path d="M6 1.75h4M6.5 1.75v4.5L2.75 12.6A1.1 1.1 0 003.7 14.25h8.6a1.1 1.1 0 00.95-1.65L9.5 6.25v-4.5" /><path d="M4.4 10h7.2" /></Svg>
);
export const IconPulse = (p: IconProps) => (
  <Svg {...p}><path d="M1.5 8.5h3l1.75-4.5 3 8.5 1.75-4h3.5" /></Svg>
);
export const IconHistory = (p: IconProps) => (
  <Svg {...p}><path d="M2.25 8a5.75 5.75 0 101.7-4.1L2.25 5.5" /><path d="M2.25 2.5v3h3M8 5v3.25l2 1.25" /></Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.25 1.25M11.35 11.35l1.25 1.25M11.35 4.65l1.25-1.25M3.4 12.6l1.25-1.25" /></Svg>
);
export const IconExternal = (p: IconProps) => (
  <Svg {...p}><path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5" /><path d="M12 9.5v3A1.5 1.5 0 0110.5 14h-7A1.5 1.5 0 012 12.5v-7A1.5 1.5 0 013.5 4h3" /></Svg>
);
