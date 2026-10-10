import { SectionI18nProvider } from "@/i18n/SectionI18nProvider";
import sectionNamespaces from "@/i18n/routeNamespaces.generated.json";

/**
 * Dashboard home route (`/home`, the target of the `/dashboard` redirect) i18n
 * provider — the "home" set covers this subtree plus the companion components
 * under `src/app/(dashboard)/dashboard/` that home/page.tsx renders.
 */
export default function HomeRouteLayout({ children }: { children: React.ReactNode }) {
  return <SectionI18nProvider namespaces={sectionNamespaces.home}>{children}</SectionI18nProvider>;
}
