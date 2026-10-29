import type { AppRole } from "@/types/database";

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "CEO/Admin",
  team_lead: "Team Lead",
};

export function isAdmin(user: { role: AppRole }): boolean {
  return user.role === "admin";
}
