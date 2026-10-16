import type { ComponentType, SVGProps } from "react";
import { AppleIcon, DrumstickIcon, DumbbellIcon, ImageIcon, LeafIcon } from "./Icons";

type Theme = { icon: ComponentType<SVGProps<SVGSVGElement>>; tile: string; ink: string };

// Placeholder look per category; anything else falls back to a neutral tile.
const THEMES: Record<string, Theme> = {
  meat: { icon: DrumstickIcon, tile: "from-rose-100 to-orange-50 dark:from-rose-950/60 dark:to-orange-950/30", ink: "text-rose-500" },
  vegetables: { icon: LeafIcon, tile: "from-emerald-100 to-lime-50 dark:from-emerald-950/60 dark:to-lime-950/30", ink: "text-emerald-600" },
  fruit: { icon: AppleIcon, tile: "from-amber-100 to-yellow-50 dark:from-amber-950/60 dark:to-yellow-950/30", ink: "text-amber-500" },
  gym: { icon: DumbbellIcon, tile: "from-indigo-100 to-sky-50 dark:from-indigo-950/60 dark:to-sky-950/30", ink: "text-indigo-500" },
};
const FALLBACK: Theme = { icon: ImageIcon, tile: "from-neutral-100 to-neutral-50 dark:from-neutral-800 dark:to-neutral-900", ink: "text-neutral-400" };

type Props = { src: string | null; alt: string; category?: string };

/** Product photo, or a soft category placeholder until a photo is added. */
export function ProductImage({ src, alt, category }: Props) {
  const theme = (category && THEMES[category]) || FALLBACK;
  const Icon = theme.icon;
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl">
      {src ? (
        // Photos come from arbitrary hosts (Supabase, store CDNs) or /public; a plain img keeps that simple.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
      ) : (
        <div className={`flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br ${theme.tile}`}>
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/80 shadow-sm ring-1 ring-black/5 backdrop-blur dark:bg-white/10 dark:ring-white/10">
            <Icon className={`h-7 w-7 ${theme.ink}`} />
          </span>
          <span className="text-[11px] font-medium tracking-wide text-neutral-500/80 dark:text-neutral-400/80">
            Photo coming soon
          </span>
        </div>
      )}
    </div>
  );
}
