import { useState } from "react"
import { Link, useLocation } from "wouter"
import {
  LayoutDashboard,
  Database,
  Network,
  Search,
  CalendarClock,
  ListChecks,
  Archive,
  SlidersHorizontal,
  Sparkles,
  Menu,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/collection", label: "Collection", icon: Database },
  { href: "/enrichment", label: "Enrichment", icon: Network },
  { href: "/lookup", label: "Lookup", icon: Search },
  { href: "/jobs", label: "Jobs", icon: ListChecks },
  { href: "/backups", label: "Backups", icon: Archive },
  { href: "/schedule", label: "Scheduler", icon: CalendarClock },
  { href: "/settings", label: "Settings", icon: SlidersHorizontal },
]

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-lg bg-primary/15 ring-1 ring-primary/30 flex items-center justify-center shrink-0">
        <Sparkles className="w-4 h-4 text-primary" />
      </div>
      <span className="font-semibold text-[15px] tracking-tight text-sidebar-foreground">
        IP Insight Engine
      </span>
    </div>
  )
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation()
  return (
    <nav className="flex-1 py-4 px-3 space-y-0.5 overflow-y-auto">
      {navItems.map((item) => {
        const active = location === item.href || (item.href !== "/" && location.startsWith(item.href))
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              active
                ? "bg-sidebar-accent text-primary"
                : "text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            }`}
          >
            <item.icon className="w-[18px] h-[18px] shrink-0" />
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="min-h-screen flex w-full bg-background text-foreground selection:bg-primary/25 selection:text-foreground">
      <aside className="w-60 border-r border-sidebar-border bg-sidebar flex-col hidden md:flex shrink-0">
        <div className="h-16 flex items-center px-5 border-b border-sidebar-border">
          <Brand />
        </div>
        <NavLinks />
        <div className="p-3 border-t border-sidebar-border text-[11px] text-sidebar-foreground/40 font-mono">
          self-hosted · v0.0.0
        </div>
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="p-0 w-64 bg-sidebar border-sidebar-border flex flex-col">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="h-16 flex items-center px-5 border-b border-sidebar-border">
            <Brand />
          </div>
          <NavLinks onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        <header className="h-16 border-b border-border flex items-center px-4 shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 z-10 sticky top-0 md:hidden">
          <Button variant="ghost" size="icon" className="mr-2 -ml-2" onClick={() => setMobileOpen(true)}>
            <Menu className="w-5 h-5" />
          </Button>
          <Brand />
        </header>
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </main>
    </div>
  )
}
