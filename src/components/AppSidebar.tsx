"use client";

import Image from "next/image";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { LogoutButton } from "@/components/LogoutButton";

type NavItem = { href: string; label: string; icon: React.ReactNode };

// Three groups, read top to bottom as a working day: what needs doing, what
// has gone out, how the system is set up. Ctrl+1–8 follow this order.
const navGroups: { label: string; items: NavItem[] }[] = [
  {
    label: "Arbete",
    items: [
      {
        href: "/app/dashboard",
        label: "Översikt",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <rect x="2" y="2" width="5" height="5" rx="1" />
        <rect x="9" y="2" width="5" height="5" rx="1" />
        <rect x="2" y="9" width="5" height="5" rx="1" />
        <rect x="9" y="9" width="5" height="5" rx="1" />
      </svg>
        )
      },
      {
        href: "/app/patients",
        label: "Kunder",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <circle cx="8" cy="5" r="3" />
        <path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5" strokeLinecap="round" />
      </svg>
        )
      },
      {
        href: "/app/review",
        label: "Granskning",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 5v3.5l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
        )
      },
    ],
  },
  {
    label: "Utskick",
    items: [
      {
        href: "/app/scheduled-sms",
        label: "Schemalagda SMS",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <rect x="2" y="3" width="12" height="11" rx="1.5" />
        <path d="M2 6.5h12" />
        <path d="M5 2v2M11 2v2" strokeLinecap="round" />
      </svg>
        )
      },
      {
        href: "/app/sms-history",
        label: "SMS-historik",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <path d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H5l-3 2V4a1 1 0 011-1z" strokeLinejoin="round" />
      </svg>
        )
      },
      // Inkorg (/app/inbox) is deliberately absent. Production sends from the
      // alphanumeric sender ID "OsteopatiC", which cannot receive replies, so the
      // inbox no longer reflects a working reply loop. The route, its data and the
      // incoming webhook all still run -- restore this entry if the sender ID goes
      // back to a number. See docs/current_state.md.
      {
        href: "/app/analytics",
        label: "Analys",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <path d="M2 12l3.5-4 3 2.5L12 5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 14h12" strokeLinecap="round" />
      </svg>
        )
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        href: "/app/settings",
        label: "Inställningar",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <circle cx="8" cy="8" r="2" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M11.53 4.47l1.42-1.42M3.05 12.95l1.42-1.42" strokeLinecap="round" />
      </svg>
        )
      },
      {
        href: "/app/import",
        label: "Importera",
        icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <path d="M8 2v8M5 7l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 13h10" strokeLinecap="round" />
      </svg>
        )
      },
    ],
  },
];

const navItems = navGroups.flatMap((group) => group.items);

function NavItemContent({ item, shortcut }: { item: NavItem; shortcut: number }) {
  const { pending } = useLinkStatus();

  return (
    <>
      {item.icon}
      <span className="nav-label">{item.label}</span>
      <span className={`nav-shortcut${pending ? " pending" : ""}`} aria-hidden="true">
        {pending ? <span className="nav-pending-spinner" /> : shortcut}
      </span>
    </>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const idx = parseInt(e.key, 10);
      if (isNaN(idx) || idx < 1 || idx > navItems.length) return;
      const target = navItems[idx - 1];
      if (!target) return;
      e.preventDefault();
      router.push(target.href);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  return (
    <aside className="sidebar">
      <Link href="/app/dashboard" className="brand" aria-label="Till översikten">
        <Image src="/osteopaticentrum.svg" alt="Osteopaticentrum" width={160} height={40} style={{ width: "100%", height: "auto" }} priority />
      </Link>
      <nav className="nav" aria-label="Huvudnavigation">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.label} role="group" aria-labelledby={`nav-${group.label}`}>
            <p className="nav-section-label" id={`nav-${group.label}`}>{group.label}</p>
            <div className="nav-items">
              {group.items.map((item) => {
                const shortcut = navItems.indexOf(item) + 1;
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    className={active ? "active" : undefined}
                    aria-current={active ? "page" : undefined}
                    href={item.href}
                    key={item.href}
                    title={`${item.label} (Ctrl+${shortcut})`}
                  >
                    <NavItemContent item={item} shortcut={shortcut} />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <LogoutButton />
      </div>
    </aside>
  );
}
