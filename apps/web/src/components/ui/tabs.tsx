import * as React from "react"
import { useState, useContext, createContext } from "react"

import { cn } from "@/lib/utils"

// ── Context ─────────────────────────────────────
interface TabsContextValue {
  activeTab: string
  setActiveTab: (value: string) => void
  orientation: "horizontal" | "vertical"
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext() {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error("Tabs compound components must be used inside <Tabs>")
  return ctx
}

// ── Tabs ────────────────────────────────────────
interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultValue?: string
  value?: string
  onValueChange?: (value: string) => void
  orientation?: "horizontal" | "vertical"
}

function Tabs({
  className,
  defaultValue = "",
  value,
  onValueChange,
  orientation = "horizontal",
  children,
  ...props
}: TabsProps) {
  const [internalTab, setInternalTab] = useState(defaultValue)
  const activeTab = value ?? internalTab
  const setActiveTab = (v: string) => {
    if (value === undefined) setInternalTab(v)
    onValueChange?.(v)
  }

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab, orientation }}>
      <div
        data-slot="tabs"
        data-orientation={orientation}
        className={cn(
          "group/tabs flex gap-2",
          orientation === "horizontal" ? "flex-col" : "",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </TabsContext.Provider>
  )
}

// ── TabsList ────────────────────────────────────
const tabsListVariantClasses: Record<string, string> = {
  default: "bg-muted",
  line: "gap-1 bg-transparent",
}

function tabsListVariants({ variant = "default" }: { variant?: string }) {
  return cn(
    "group/tabs-list inline-flex w-fit items-center justify-center rounded-full p-[3px] text-muted-foreground",
    tabsListVariantClasses[variant] ?? tabsListVariantClasses.default,
  )
}

interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: "default" | "line"
}

function TabsList({ className, variant = "default", ...props }: TabsListProps) {
  const { orientation } = useTabsContext()
  return (
    <div
      role="tablist"
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(
        tabsListVariants({ variant }),
        orientation === "horizontal" ? "h-8" : "h-fit flex-col",
        className,
      )}
      {...props}
    />
  )
}

// ── TabsTrigger ─────────────────────────────────
interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string
}

function TabsTrigger({ className, value, ...props }: TabsTriggerProps) {
  const { activeTab, setActiveTab } = useTabsContext()
  const isActive = activeTab === value

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      data-slot="tabs-trigger"
      data-active={isActive ? "" : undefined}
      onClick={() => setActiveTab(value)}
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-full border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        isActive &&
          "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

// ── TabsContent ─────────────────────────────────
interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string
}

function TabsContent({ className, value, children, ...props }: TabsContentProps) {
  const { activeTab } = useTabsContext()
  if (activeTab !== value) return null

  return (
    <div
      role="tabpanel"
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
