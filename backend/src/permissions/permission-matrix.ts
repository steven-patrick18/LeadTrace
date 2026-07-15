import { PermissionScope } from '@prisma/client';

/**
 * The DEFAULT permission matrix (spec §3) — single source of truth, shared by
 * the seed AND the startup sync (permission-sync.service.ts).
 *
 * The Admin owns the live matrix via the Permissions page; the sync therefore
 * only CREATES rows that are missing (new permission keys shipped in code) and
 * never updates existing rows. One-time default changes for existing keys ship
 * as data migrations instead (see offices_manager_bucket).
 */
export type Cell = boolean | 'OWN' | 'ASSIGNED' | 'ALL' | 'VIEW';

export const ROLE_ORDER = ['AGENT', 'SR_AGENT', 'CLOSER', 'MANAGER', 'ADMIN'] as const;

// permission_key → [AGENT, SR_AGENT, CLOSER, MANAGER, ADMIN]
export const PERMISSION_MATRIX: Record<string, [Cell, Cell, Cell, Cell, Cell]> = {
  search_providers:   [true,  true,  false, true,  true],
  create_lead:        [true,  true,  false, true,  true],
  view_own_leads:     [true,  true,  true,  true,  true],
  view_all_leads:     [false, false, false, true,  true],
  edit_lead:          ['OWN', 'ASSIGNED', 'ASSIGNED', 'ALL', 'ALL'],
  log_activity:       [true,  true,  true,  true,  true],
  request_transfer:   [true,  true,  false, true,  true],
  // T2→T3 lands in the common Manager bucket — managers route it; admin retains full control
  route_leads:        [false, false, false, true,  true],
  close_deal:         [false, false, true,  true,  true],
  send_back:          [false, false, true,  true,  true],
  view_reports_team:  [false, false, false, true,  true],
  view_reports_own:   [true,  true,  true,  true,  true],
  view_api_costs:     [false, false, false, true,  true],
  export_data:        [false, false, false, true,  true],
  manage_users:       [false, false, false, 'VIEW', true],
  manage_permissions: [false, false, false, false, true],
  manage_providers:   [false, false, false, false, true],
  system_lockdown:    [false, false, false, false, true],
  // Lead enrichment module
  enrich_lead:          [true,  true,  true,  true,  true],
  view_enrichment:      [true,  true,  true,  true,  true],
  edit_score_weights:   [false, false, false, false, true],
  manage_dnc_optout:    [false, false, false, true,  true],
  view_enrichment_cost: [false, false, false, true,  true],
  // Custom fields, comments, per-lead access control
  manage_custom_fields: [false, false, false, false, true],
  comment_lead:         [true,  true,  true,  true,  true], // + server-side participant rule
  manage_lead_access:   [false, false, false, false, true],
  // Desk / batch-id sessions: manager sees the floor, admin manages it
  manage_desks:         [false, false, false, 'VIEW', true],
  // Offices: admin creates/renames; manager can view the list (dropdowns)
  manage_offices:       [false, false, false, 'VIEW', true],
};

export function cellToPermission(cell: Cell): { allowed: boolean; scope: PermissionScope } {
  if (cell === true) return { allowed: true, scope: PermissionScope.ALL };
  if (cell === false) return { allowed: false, scope: PermissionScope.ALL };
  return { allowed: true, scope: PermissionScope[cell] };
}
