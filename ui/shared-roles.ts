import type { SharedRole } from "../src/shared-accounts.js";

// Mirrors SHARED_ROLES and roleAtLeast in src/shared-accounts.ts, which the browser bundle cannot import
// (it loads node:fs and node:crypto); test/shared-accounts.test.ts asserts that both copies agree.
/** Weakest first: each role includes everything the roles before it may do. */
export const SHARED_ROLES: readonly SharedRole[] = ["viewer", "reviewer", "contributor", "maintainer"];
/** What each role adds over the previous one, for the role select and the team board. */
export const SHARED_ROLE_HELP: Record<SharedRole, string> = { viewer: "reads results", reviewer: "also comments and records reviews", contributor: "also owns team tasks and runs them on their own computer", maintainer: "also manages project tasks, repositories and handovers" };
export const roleLabel = (role: SharedRole) => role.charAt(0).toUpperCase() + role.slice(1);
/** A missing or unrecognised role never satisfies a requirement. */
export function roleAtLeast(role: SharedRole | undefined, needed: SharedRole): boolean { const rank = role === undefined ? -1 : SHARED_ROLES.indexOf(role), floor = SHARED_ROLES.indexOf(needed); return rank >= 0 && floor >= 0 && rank >= floor; }
