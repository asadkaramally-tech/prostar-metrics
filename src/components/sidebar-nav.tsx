"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/components/nav-items";

/**
 * Compact desktop-first dashboard navigation. The same four-link markup
 * becomes a horizontal overflow row at small widths, with no separate mobile
 * nav component.
 */
export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Metrics dashboards">
      {navItems.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={active ? "active" : undefined}
          >
            <item.icon className="i" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
