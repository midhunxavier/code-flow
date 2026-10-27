import { executionPaused, projects, settingsProject } from "./state.js";

/** A provider that is installed but paused, where "Not installed" would otherwise show. */
export { POLICY_PAUSED } from "./provider-readiness.js";

/**
 * Why `what` can't happen: a custom filesystem restriction in some project pauses app-managed work in
 * every project (docs/filesystem-policy.md). Names the project and links to its policy; nothing when
 * no restriction is active. `onReview` runs as the link is followed (a dialog closes itself, say).
 */
export function PolicyPauseNotice({ what, onReview }: { what: string; onReview?: () => void }) {
  if (!executionPaused.value) return null;
  const restricted = projects.value.filter((project) => project.filesystemRestricted);
  const names = restricted.map((project) => `“${project.name}”`).join(", ");
  const cause = !restricted.length ? "a project has a custom filesystem restriction" : `${restricted.length === 1 ? "project" : "projects"} ${names} ${restricted.length === 1 ? "has" : "have"} a custom filesystem restriction`;
  return (
    <p class="msg warn policy-pause">
      {what}: {cause}. While any project restricts file access, agents, terminals and provider checks pause in every project.{" "}
      <a href="#/settings/projects" onClick={() => { settingsProject.value = restricted[0]?.id ?? ""; onReview?.(); }}>Review the filesystem policy</a>
    </p>
  );
}
