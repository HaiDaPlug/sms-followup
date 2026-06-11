"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { LogoutButton } from "@/components/LogoutButton";

const navItems = [
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
    label: "Patienter",
    icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <circle cx="8" cy="5" r="3" />
        <path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5" strokeLinecap="round" />
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
  {
    href: "/app/inbox",
    label: "Inkorg",
    icon: (
      <svg className="nav-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.75}>
        <path d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H5l-3 2V4a1 1 0 011-1z" strokeLinejoin="round" />
        <path d="M5 7h6M5 9.5h4" strokeLinecap="round" />
      </svg>
    )
  },
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
  }
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    console.log("[AppSidebar] keyboard shortcut listener mounted");
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const idx = parseInt(e.key, 10);
      console.log("[AppSidebar] keydown", { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, idx });
      if (isNaN(idx) || idx < 1 || idx > navItems.length) {
        console.log("[AppSidebar] key out of range, ignoring");
        return;
      }
      const target = navItems[idx - 1];
      if (!target) return;
      console.log("[AppSidebar] navigating to", target.href);
      e.preventDefault();
      router.push(target.href);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      console.log("[AppSidebar] keyboard shortcut listener unmounted");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [router]);

  return (
    <aside className="sidebar">
      <Link href="/app/dashboard" className="brand" style={{ display: "flex" }}>
        <Image src="/osteopaticentrum.svg" alt="Osteopaticentrum" width={160} height={40} style={{ width: "100%", height: "auto" }} priority />
      </Link>
      <nav className="nav" aria-label="Huvudnavigation">
        {navItems.map((item, i) => (
          <Link
            className={pathname.startsWith(item.href) ? "active" : undefined}
            href={item.href}
            key={item.href}
          >
            {item.icon}
            <span className="nav-label">{item.label}</span>
            <span className="nav-shortcut">{i + 1}</span>
          </Link>
        ))}
      </nav>
      <div className="sidebar-footer" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <LogoutButton />
        <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.3)", paddingLeft: 10 }}>Osteopaticentrum · Borås</div>
      </div>
    </aside>
  );
}
