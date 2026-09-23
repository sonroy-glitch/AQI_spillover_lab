import { GraduationCap, HardHat, PersonStanding, type LucideIcon } from "lucide-react"
import type { ZoneType } from "@/lib/pollution/types"

export const ZONE_META: Record<
  ZoneType,
  { label: string; icon: LucideIcon }
> = {
  school: { label: "School", icon: GraduationCap },
  stadium: { label: "Stadium / Sports", icon: PersonStanding },
  worker_zone: { label: "Outdoor Workers", icon: HardHat },
}
