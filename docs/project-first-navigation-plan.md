# Project navigation review and implementation plan

Status: Phases 1–5 implemented on 21 October 2026. Phase 6 software validation is complete; the participant pilot remains an external release activity. Original review baseline: `d82a2e1`.

Make **Project** the main place to start, follow and review work. Repositories, runs, shared boards, people and scheduled work should have predictable places inside that project. Show the computer that owns the project and, where relevant, the computer that executes the work.

The initial experience should be: **Open a project → describe the task → start a run → review the result.** A person using one repository on one computer should not have to configure a workspace, a team or a connection first.

## Implemented navigation contract

The owner experience uses **Project** for a group of repositories, drafts and runs; **Repository** for a Git root; **Run** for an execution and its evidence; and **Computer** for the host that owns files and project records. **Repository tools** replaces Workspace in the owner navigation. Board contains shared tasks; People contains membership and access. Shared dashboards retain independent safe projections. Project Automation and global Scheduling use the existing schedule, backlog and mission operations.

| Destination / visible label | Address and source identity | Access and compatibility |
| --- | --- | --- |
| New run / project draft | `#/project/:id/new`; current computer + project ID | Owner; legacy `#/` and `#/new` resume the last draft; `#/new/unassigned` opens the unassigned draft. |
| Overview | `#/project/:id` | Owner projection from that computer's projects and runs. |
| Runs | `#/project/:id/runs` | Owner; independent project query, archived option and pagination. |
| Repositories / Repository tools | `#/project/:id/repositories/:encodedPath/:tool` | Owner; only project roots and known project run worktrees. Full path stays visible. |
| Project settings | `#/project/:id/settings` | Owner; project editing, outcomes and scenarios. Missions live in Automation. |
| Legacy repository tools | `#/workspace`, `#/settings/workspace`, `#/project/:id/workspace` | Global bookmarks retain composer repository context; project bookmarks render Repositories with their project context. |
| Run / result review | `#/run/:id`, `#/review/:id/:branch` | Existing run identity, branch decoding and review permissions. |
| Inbox / Insights | `#/inbox`, `#/insights` (including settings aliases) | Existing global filters. Filtering cannot alter a composer destination. |
| Project Board / People | `#/project/:id/board`, `#/project/:id/people` | Owning computer’s board only (`team=local`). Switching from a linked board replaces the document before rendering collaboration controls. |
| Linked Board / People | `?team=:connection#/team/project/:id`, `#/team/people/:id` | Connection pinned per document; server-authorized membership and repository keys. Account/grant administration remains owner-only. |
| Project Automation | `#/project/:id/automation/:kind` | Explicit project and repository; independent of sidebar filters and the previously open composer draft. |
| Scheduling | `#/automations/:kind` | Current computer and existing saved schedule identity. The global project filter controls the list; choose a project/repository here before configuring new work. |
| Settings / Connections | `#/settings/:section`, connection groups | Existing owner settings. Old SSH, remote-access and team settings aliases remain supported. |
| Board / task | `#/team`, `#/team/project/:id`, `#/team/task/:id` | Existing selected collaboration connection + board ID. No local-project identity inferred from matching names or IDs. |
| Detached side panel | `#/side/:tab/:scope` | Existing run/project/repository pin; target remains independent of composer navigation. |
| Another computer | `/computer/:computer/` plus these routes | Existing server request prefix and browser-storage namespace. No local fallback when disconnected. |
| Shared-user dashboard | Existing shared-account entry and projections | Existing grants and safe APIs; owner pages are not rendered for shared accounts. |
| Invalid/unavailable target | Malformed project route, missing project or removed repository | Explicit recovery state. Retain draft; block a new launch into an invalid destination. |

Screen sketches used for this slice:

```text
First visit                Project Overview            Project composer
Computer: This computer    Project · Computer           Project · repository
Open repository            Overview | Runs | Repos      Task + context
Join shared project        Describe task / Continue     Workflow + run options
On another computer        Needs you · Running          Computer / Project / Repo
                           Recent results               Start run

Multiple repositories      Shared board (retained)
Project · Computer         Collaboration connection
Repository cards + paths   Board / task details
Selected root or worktree  Existing membership/grants
Repository tool selector   No inferred local mapping
```

There is one task editor. Overview opens the existing composer rather than maintaining a second task field. Only the visible project section mounts its specialized panels.

Draft storage is versioned IndexedDB, scoped by computer and project, with a retained legacy backup and an unassigned destination for ambiguous migration. Text, attachments, selected paths, workflow roles/models, checks, limits, approvals, source, scenario, context budget and execution options travel together. The current implementation maintains one saved draft per project in this browser; simultaneous editing of the same project's draft in multiple tabs has last-writer behavior.

New UI launches send an explicit-selection marker. The server verifies that the project exists and the canonical repository remains a member before preparation and again at placement. Adding a repository is an explicit API operation. Existing API/automation callers retain their placement behavior unless they request strict selection.

The automated scenario baseline covers route aliases, computer namespaces, delayed repository responses, draft switching and launch placement. No human completion-time or wrong-turn baseline was collected in this implementation session. The participant pilot and before/after measurements remain required release validation in Phase 6; automated tests do not establish usability improvement.

## Phases 4–6 implementation and validation

Phase 4 reuses the existing board API, account CAS updates, repository-key editor and explicit host-execution/terminal grants. Owner projects embed only their own computer’s board. Linked boards remain connection-scoped; there is no inferred remote-to-local relationship. URLs retain `team` identity, requests/downloads and subscriptions stay pinned to that document, and a source switch reloads the document. An unavailable project does not expand to all projects. Refused board/task reads clear stale content and controls. Shared People uses only authorized board projections and never mounts owner account controls.

Phase 5 adds Automation with Run once later, Repeat, Process a backlog and Pursue a mission. Project lists ignore the global filter. Repository selection is explicit; opening backlog items waits for the chosen project’s saved agent workflow to restore and retains its destination. Missions move from settings to Automation; actionable opportunities link there from Overview and Inbox. More and command search always expose specialized destinations. Saved collaboration, schedules and missions remain discoverable when the optional Board shortcut is off.

No rollout flag is needed for this implementation: it uses additive routes, existing permissions/APIs and the compatible draft format from phases 1–3. No execution records, repository keys, roles, schedules or mission history are migrated. Legacy routes and search aliases remain available. No deployment or user-data reset was performed.

Validation record (21 October 2026):

- Full unit suite: 1,212 tests, 1,204 passed, eight opt-in integration checks skipped, zero failures.
- Project-navigation browser suite: all ten scenarios pass, including colliding linked project IDs, access refusal, project-specific scheduling/backlogs and mobile light/dark accessibility.
- Shared collaboration/account browser suites: all 24 scenarios pass, including an empty shared project with repository keys and no server clone, maintainer People access without owner requests, live revocation, host execution and terminal grants.
- Existing mission, experience and scheduling browser scenarios pass after moving mission navigation. An initialization race found by the new backlog scenario was fixed: an unsuccessful draft restore cannot open the picker with the prior repository.
- Build, TypeScript and 12 documentation checks pass. The documentation capture script now produces project Overview and Automation screenshots with disposable demo data. Mobile screenshots were inspected; More, project tabs and scheduling controls fit at 390 pixels.
- Final full browser suite: all 153 scenarios pass, zero failures. The earlier full run found six failures. Fixes preserve Auto team answer drafts when a question moves into the attention card, keep the mobile computer header within the viewport while reconnecting, remove duplicate global scheduling filters, and update tests to wait for explicit project selection and use the current repository/backlog controls.
- Final full unit rerun: 1,204 passed, eight opt-in skips, zero failures. All 52 focused collaboration/API/UI checks also pass after the final visibility and terminology updates.
- Additional integrations: VS Code extension-host acceptance passes; the opt-in Rust reader test and both real loopback SSH tests pass. After recovering Docker Desktop from stale backend processes, `npm run test:containers` passes all five real Docker checks with zero failures or skips: read/write isolation, host-secret and Git-metadata protection, cancellation, hard timeout, and filtered edit import. Together these runs cover all eight integration checks skipped by the default unit command. Live provider-usage tests were not invoked.
- Final build, typecheck, documentation checks and whitespace validation pass. Documentation screenshots were regenerated and inspected after the UI fixes.

PR integration against `main` at `0968718` preserves complete project history counts and the newer editable-retry behavior. Retry identity, custom verification and execution options now travel with each project draft, including when projects share a repository. The retry action waits for draft initialization. The full unit rerun passes 1,231 of 1,239 checks with zero failures and eight opt-in skips; all five Docker checks pass separately. The full browser run exercised 165 scenarios: 160 passed, four retry-navigation checks failed, and one reconnect test raced the expected page reload. After fixing those issues, the complete 11-scenario daily-workflow suite (including a new initialization regression) and seven-scenario Tailscale suite pass with zero failures. This verifies 166 distinct browser scenarios across the full run and focused reruns. Final build, typecheck, all 12 documentation checks and whitespace validation pass; refreshed project screenshots were visually inspected.

The automated scenario matrix is exercised by the project-navigation, team/shared-projects, SSH/computer, automation, mission, workspace and accessibility suites. Automated keyboard/axe checks support validation but do not establish human usability improvement. No participant pilot or completion-time comparison was conducted. The original five-person pilot and its wrong-destination threshold remain an external release gate; no pilot results are claimed.

## Review of the idea

The direction is sound, but changing labels alone will not resolve the confusion. The app has overlapping navigation destinations, implicit project selection and several legitimate meanings of workspace and team. Those need consistent behavior as well as consistent names.

The current implementation already provides a useful foundation:

| Finding | Evidence | Design consequence |
| --- | --- | --- |
| Projects already group repositories, runs and workflow defaults. A repository can occur in more than one project. | [Project model](../src/projects.ts) | Build on the existing project entity; avoid a new organizational layer or assuming exclusive repository ownership. |
| Starting a run can create a project or add a repository to one. The composer can change the active project after a repository choice. | [Selection state](../ui/state.ts), [project placement](../src/projects.ts) | Make the destination understandable before launch and make membership changes explicit. |
| The project page has a task box, metrics, scenarios, missions, results, repository details and automations together. | [Project page](../ui/project.tsx) | Give immediate work priority and move configuration and specialized workflows to predictable destinations. |
| Human collaboration is partly called People, but its main destination is a task board. | [Application breadcrumbs](../ui/app.tsx), [board](../ui/collab-board.tsx) | Call the task board Board; reserve People for membership and access. |
| Repository tools opens a page called Repository workspace or the project's workspace. | [Project page](../ui/project.tsx), [activity page](../ui/activity.tsx) | Use Repositories for the destination and Repository tools for actions inside it. |
| SSH computers have separate API paths, browser state and drafts. The sidebar already lists projects by computer. | [Client routing](../ui/lib.ts), [connected projects](../ui/connected-projects.tsx), [routing regression](../test/workspace-routing.test.ts) | Keep computer identity visible and preserve those boundaries. |
| A selected collaboration connection can address a different server from the current computer's project store. Shared repositories use keys mapped to local clones. | [Collaboration connections](../src/collab/connections.ts), [collaboration state](../ui/collab-state.ts) | A project name or ID alone cannot identify a board across connections. |
| Connections, optional People controls and purpose-based Scheduling already exist. | [Connections](../ui/connections.tsx), [Scheduling](../ui/scheduling.tsx), [existing acceptance tests](../test/e2e/simplification.e2e.ts) | Extend the simplification already in progress and retain its useful workflows. |

Three refinements are necessary to the original proposal:

1. **Computer remains visible context.** Removing workspace as a navigation concept must not obscure where files, CLIs, terminals and settings live. Delegating an agent turn to a worker is a different operation from opening a project on another computer.
2. **Runs and board tasks retain distinct meanings.** A run is an execution with results and evidence. A board task records ownership, discussion, reviews and execution attempts. A combined task system would require a separate product and data-model decision.
3. **Project organization must feel optional for a simple start.** Opening a repository should suggest a project name automatically. Users should not complete an administrative form before describing their task.

The expected benefit is fewer decisions and fewer context switches. That remains a usability hypothesis until the proposed flows are tested with users.

## Terminology contract

| Term | Meaning and placement |
| --- | --- |
| Project | The main navigation destination for related work. Its identity includes the source that owns it. |
| Repository | Code attached to a project. A single repository is selected automatically; multiple repositories require a visible selection. |
| Run | One execution of a requested task. Keep New run, Start run, run history and review terminology consistent. |
| Board | Optional shared task management within a project. Board cards open task details and their linked attempts or runs. |
| People | Members, project roles and access. Administrative account creation remains subject to owner authority. |
| Agents | Providers and roles performing a run. Use Agent workflow for their configuration. |
| Computer | The location of project files and the Code Flow instance serving them. A run can additionally name an execution worker. |
| Automation | Scheduled, deferred or triggered work within a project. Keep existing distinctions between repeat tasks, backlogs and missions. |
| Mission | An optional ongoing goal under Automation. Retain preview eligibility and existing review controls. |
| Workspace | Acceptable descriptive prose for the app as a whole; remove it from competing primary destinations and ambiguous context labels. |

Keep established workflow names such as Auto team during this change. Explain them under Agent workflow. Renaming every public workflow, internal class, API and storage key would broaden the change without improving navigation.

Use the same display terms in visible labels, accessible names, breadcrumbs, command search, empty states and documentation. Old words remain search aliases so existing users can find relocated features.

## Proposed navigation

The navigation for the common local-owner case should look like this:

```text
New run
Inbox

Projects
  Code Flow
  Storefront
  Add project

Application menu
  Scheduling across projects
  Insights
  Connections
  Settings
  Help
```

Projects remain expandable to recent runs, preserving fast access from the sidebar. Show computer groups only when multiple computers are configured. Keep an unobtrusive computer label in the project header, including on a single-computer installation. On a hosted session, use the server's available name or Remote server rather than calling the browser's device This computer.

Within a project:

```text
Storefront                         Computer: Development VM
Overview     Runs     Repositories     More

More
  Board
  People
  Automation
  Project settings
```

Overview, Runs and Repositories are the owner view's primary destinations. Board becomes a visible tab when collaboration is configured; Automation can become visible when the project has active scheduled work. Keep their positions stable for that project rather than changing tabs on every transient response. People stays an access-management destination. Shared users receive destinations allowed by their existing access, such as Board and Results; they do not receive owner tools merely because the shell is shared.

Overview shows the task entry point, items requiring a decision, active work and recent results. Put usage summaries, scenario libraries and detailed mission configuration behind their relevant destinations. Existing mission decisions still appear in the overview and Inbox when actionable.

Keep the global Inbox and Scheduling views as cross-project tools on the current computer. Label their scope. They must not imply that they aggregate every connected computer or collaboration server. Cross-server aggregation is outside the initial release.

## User flows

### First project and first run

1. The empty state offers **Open repository** and **Join shared project**. Remote setup is available through **On another computer** in the repository flow.
2. Open repository validates the selected repository and suggests its folder name as the project name. Reuse an unambiguous existing project; if several contain it, show their names and require a choice.
3. Create or open the project through the existing project API. Keep the name editable. Creating the project succeeds independently of launching an agent.
4. Open the composer with the project and repository already set. Present a recommended installed agent/workflow using existing defaults and availability rules.
5. The user describes the task, reviews the compact summary and selects Start run. The summary includes repository, branch, execution computer, agents, checks and limits.

Advanced run options remain available. Preserve current permission, check and approval defaults; reduced visual complexity must not silently change execution behavior.

### Returning to a project

Open its Overview from the sidebar. Its task box and New run action lead to the same composer with explicit project context. A global New run action reuses the current valid project, or offers a lightweight project choice when none is selected. An existing unsent draft is restored rather than overwritten by a navigation action.

Use one canonical composer for both entry points. Avoid two independent prompt forms with different defaults, attachment behavior or launch validation.

### Working with multiple repositories

Show the selected repository in the composer summary even when there is only one. For multiple repositories, use the last valid selection for that project and computer; show a selector before launch. Repositories displays the full list with paths and branch context sufficient to distinguish identical folder names.

Choosing a repository outside the current project offers explicit **Open its project** or **Add to this project** actions. Adding uses the project's membership operation and reports success before launch. Canceling leaves the current project and draft intact. The server revalidates project membership at launch, including if another tab removed the repository.

### Working on another computer

Open the remote project directly from the existing computer-grouped sidebar. Preserve the owning computer in the URL, API routing, drafts and settings. A disconnected project shows a reconnect action and its computer name; execution stays unavailable until the intended connection is restored.

Switching the computer opens that computer's project context. It does not move a project, copy repository files or reuse a local path on the remote machine. The run summary names a delegated worker separately when configured.

### Collaborating with people

An owner opens Project → People to view members and roles. Existing owner administration supplies account creation and access grants. A maintainer sees only actions the existing API authorizes.

Project → Board shows shared task ownership and progress. Join shared project reuses the existing connection flow, then lists authorized projects and maps shared repository keys to local clones when execution requires them. Joining must not create an unrelated local project with the same name and imply that it is the shared project.

For a linked server, a board link carries its connection identity as well as its project identity. A local project may show a linked board shortcut only when the relationship has been explicitly established; matching names, paths or IDs is insufficient. Keep the existing connection-scoped board entry available until that relationship is supported reliably.

### Scheduling and ongoing missions

Project → Automation opens the existing Scheduling purposes scoped to that project. Each purpose obtains its repository from the project context rather than directing users to New run just to select one. Keep Run once later, Repeat, Process a backlog and Pursue a mission as distinct choices.

Global Scheduling can filter across projects on the current computer. Managed mission schedules remain controlled by mission settings; moving their navigation does not grant generic automation controls authority to edit them.

## Context and routing design

### Resolve context explicitly

Introduce a small UI context module that derives the current project, source, repository and available capabilities. Separate the project being viewed, the composer draft's destination and the filter used by global lists. Today these purposes share parts of the active-project state, which makes unrelated screens influence one another.

An owner project reference needs the computer identity and project ID. A linked shared project reference additionally needs the collaboration connection and its project ID, qualified by the computer holding that connection. Run and board-task references likewise retain their source. These are client routing identities, not new organization records or replacements for server authorization.

The context module should implement these rules:

- A valid project route determines the page's project. Global filters cannot silently override it.
- Explicit draft choices take precedence over remembered defaults. Defaults apply only to unset fields or an intentional reset.
- An empty project has no runnable repository. It still has a useful add-repository or board-setup state.
- Drafts and selected repositories are isolated by source and project. A repository removed from membership becomes an explicit unresolved destination; it must not silently redirect the draft elsewhere.
- Reads, subscriptions and async selection responses are scoped and invalidated when context changes. A late response cannot overwrite a later choice.
- The composer, side panel, repository tools and launch summary use the same resolved destination unless the side panel is explicitly pinned. A pin remains clearly labeled with its actual scope.
- Unavailable or unauthorized sources stop resolution; they never fall back to a different computer or project for a mutation.

Keep server-side identity, permission, membership and checkout validation authoritative. A project ID accepted by a UI component is not evidence of access.

### Add project destinations without breaking links

Extend the project route with a validated section and optional repository/tool selection. Build links centrally rather than concatenating them in every component. Persist repository/tool context needed to reopen a deep link; do not depend on whatever the composer last selected.

| Existing entry | Proposed behavior |
| --- | --- |
| `#/project/:id` | Project Overview. |
| New `#/project/:id/runs` | Project run history. |
| New `#/project/:id/repositories` | Repository list and tools with explicit repository selection. |
| `#/project/:id/workspace` | Compatibility alias for the project's Repositories destination. |
| New `#/project/:id/automation/:kind` | Existing Scheduling purpose with an explicit project. |
| New project Board and People routes | Resolve only against the owning server or an explicitly identified collaboration source. |
| `#/run/:id` and `#/review/:id/:branch` | Keep working and derive project breadcrumbs from the result's recorded context. |
| `#/team`, project and task variants | Keep connection identity and open the corresponding board/task view. Never reinterpret against an unrelated active project. |
| `#/workspace` and `#/settings/workspace` | Open repository tools for a valid current destination; otherwise show an explicit repository/project chooser. |
| Legacy SSH, team and remote-access settings links | Continue resolving through Connections. |

Retain `/computer/:id/` prefixes, existing team query context and URL encoding. Malformed links produce a recoverable state. Unsupported project subroutes should not silently appear to be Overview. Browser back/forward must restore both the destination and its context.

### Reuse existing screens

| Area | Main implementation locations | Required change |
| --- | --- | --- |
| Routes and context | `ui/navigation.ts`, `ui/state.ts`, `ui/lib.ts`, new focused context module | Explicit view/draft/filter contexts, qualified references, aliases and consistent link building. |
| Shell and sidebar | `ui/app.tsx`, `ui/rail.tsx`, `ui/connected-projects.tsx` | Project destinations, scope labels, breadcrumbs and discoverable global tools. |
| Project and composer | `ui/project.tsx`, `ui/projects.tsx`, `ui/composer.tsx` | Focused overview, direct repository onboarding and one composer path. |
| Repository tools | `ui/activity.tsx`, `ui/workbench.tsx`, side-panel scope in `ui/state.ts` | Explicit repository context, consistent labels and preserved worktree targets. |
| Collaboration | `ui/collab-board.tsx`, `ui/collab-state.ts`, `ui/collab-settings.tsx`, `ui/shared.tsx`, `ui/team-connections.tsx` | Board versus People distinction, correct connection scope and role-appropriate views. |
| Automation | `ui/scheduling.tsx`, `ui/automations.tsx`, `ui/project-teams.tsx` | Explicit project parameters and one configuration home for each schedule or mission. |
| Connections and settings | `ui/connections.tsx`, `ui/ssh-projects.tsx`, `ui/team-server-wizard.tsx`, `ui/settings-sections.ts`, `ui/preferences.ts` | Computer-oriented language, shared-project setup and consistent search aliases. |
| Server integration | `src/projects.ts`, `src/server.ts`, `src/collab/connections.ts`, existing access-policy modules | Reuse existing project operations and enforce launch membership for the new explicit UI flow. Add narrowly scoped projections only when required. |

Extract reusable content from existing pages so an embedded project view does not render duplicate headers, pickers or event subscriptions. Hidden tabs should not fetch owner-only data or maintain unnecessary live feeds.

## Implementation sequence

### Phase 1 Establish the design contract

Create a route and label inventory covering owner, SSH, linked-server and shared-user views. Record the identity source and access requirements of each destination. Build lightweight screen sketches for the empty state, project overview, composer summary, multiple repositories and shared board. Check whether each location answers “Which project?”, “Which repository?” and “Which computer?” when those answers matter.

Deliver the terminology map, route matrix and scenario checklist as the implementation contract. Capture baseline completion time and wrong turns for the usability scenarios below. This is a small design and investigation phase; it should expose any shared-project mapping gaps before route work begins.

**Exit criterion:** every existing destination has a proposed home or compatibility entry, and the first-run flow requires no separate workspace or team setup.

### Phase 2 Implement explicit context and route compatibility

Add the context module and project sections. Separate global list filters from composer destination state. Add project/source-qualified draft and repository preferences with a versioned migration from existing browser state. Preserve the existing per-computer namespaces.

Wire route resolution, late-response guards, deep links and back/forward behavior before restructuring pages. Use the existing project APIs for explicit membership changes. The new project-bound UI launch path should request strict membership validation; retain deliberate compatibility behavior for existing automation and API clients.

**Exit criterion:** routing and selection tests show that a project, repository or connection switch cannot redirect a launch, leak a draft or overwrite a more recent selection. Old bookmarks continue to resolve.

### Phase 3 Deliver the owner project experience

Implement the focused overview, Runs and Repositories destinations. Reuse existing result rows and tools. Add Open repository onboarding and simplify the single-repository composer. Update sidebar entry points, breadcrumbs, repository changes and the compact execution summary together.

Keep cross-project Inbox available. Move global Scheduling only when its project destination and command-search entry are working. Preserve keyboard shortcuts and recent-run navigation.

**Exit criterion:** a new local user can open a repository, launch a fake-agent run and review its result through one project; an existing user can recover drafts, archives and repository tools without losing context.

This is the first useful release slice, dependent on Phases 1 and 2. It can ship before the collaboration restructuring.

### Phase 4 Integrate collaboration with correct source identity

Separate Board from People and embed authorized project views. Reuse existing account administration, grants and board-task operations. Add explicit collaboration-source handling to navigation, requests and subscriptions. Preserve the connection-scoped board when no reliable local-project relationship exists.

Adapt shared dashboards using their existing safe data projections; do not embed the owner project page with controls merely hidden. Test empty shared projects that have repository keys but no server-side local clone. Expose existing terminal or host-execution grants only to their authorized recipients.

**Exit criterion:** two servers with identical project or task IDs remain distinct, permission changes remove access promptly, and selecting another board cannot redirect an existing task execution.

### Phase 5 Complete project automation and discoverability

Scope Scheduling, backlogs and missions explicitly to the project and repository. Surface actionable outcomes in Overview and Inbox using the existing evidence and approval rules. Align settings search, command search, connection setup, errors and help text with the terminology contract.

Apply predictable visibility: hide unused specialized controls initially, retain access through More or search, and surface already-configured features even when an old optional-navigation preference is off. Authorization decides availability; a preference decides presentation only.

**Exit criterion:** users can find and manage existing schedules, missions, shared work and connection settings from their expected project or app location. All first-run instructions match the implemented navigation.

### Phase 6 Validate and roll out

Run the relevant behavioral and browser suites, then the full required checks for the final code change. Conduct the usability scenarios and inspect narrow screens, light/dark themes and keyboard/screen-reader behavior. Refresh documentation and screenshots after the routes stabilize.

Use a temporary navigation rollout switch if the implementation needs staged exposure. Both paths should use compatible storage so reverting navigation does not require restoring user data. Remove the temporary branch after validation rather than maintaining two permanent information architectures.

**Exit criterion:** the scenario matrix passes, no unexplained source or destination switches occur, and pilot users can find previously available capabilities.

Phases 2 through 5 are substantial UI and integration work. Treat collaboration as the highest-uncertainty portion. Estimate delivery after Phase 1 resolves source mapping and draft migration; a simple label-change estimate would understate the scope.

## Migration and compatibility

Preserve project IDs, repository membership, run logs, board tasks, shared repository keys, account roles, automation records and managed mission history. Introduce browser preference versions and additive route aliases rather than rewriting durable execution history.

For legacy browser drafts, migrate once into a valid source/project destination when unambiguous. Otherwise retain them as a recoverable unassigned draft and ask for a destination when opened. Keep the original recovery data until migration is verified. A failed migration must not create a project or start work.

Keep the existing semantics for historical runs whose projects were deleted or whose membership was inferred. Show them under Unassigned and retain review/archive access allowed by current rules. New explicit selection behavior does not justify silently regrouping old runs or sharing previously private results.

Do not merge projects by name, repository basename, Git remote URL or matching IDs across computers. Those can describe related work without establishing common identity or access. Repository membership changes may affect shared access, so expose their real consequences in the project settings action.

The initial scope excludes a global project database, automatic synchronization of clones, a merged run/board-task data model, cross-server Inbox federation, new permission levels and changes to execution engines. Each would need its own design and validation.

## Validation plan

| Scenario | Required result |
| --- | --- |
| New local installation, one repository | Open repository leads to a named project and ready composer with no team/workspace configuration. |
| Returning user with an unsent draft | Navigation and reload preserve the draft, its attachments and destination. |
| One repository in multiple projects | An explicit project selection wins; ambiguous onboarding asks the user to choose. |
| Multiple repositories with delayed API responses | The last valid selection controls checks, defaults, tools and launch; old responses cannot win. |
| Empty project or removed repository | Helpful setup/recovery state; no launch using a stale repository. |
| Same project name and path on two computers | Requests, drafts, terminals and file recovery remain isolated. |
| Disconnected SSH computer | Reconnect the intended computer; never substitute local execution. |
| Local project with a delegated worker | The project computer and actual execution worker are both clear. |
| Multiple collaboration servers with colliding IDs | Correct board, task, membership and inbox scope for each connection. |
| Viewer, reviewer, contributor and maintainer | Only authorized projections and actions are available; server enforcement still rejects forged requests. |
| Revoked or expired shared access | Stale views/subscriptions cease exposing data and present a recoverable access state. |
| Shared board without a server clone | Board/review workflows work; local clone mapping appears when needed for execution. |
| Existing schedules and managed missions | Same scope, budgets, controls and result links; mission readiness/approval rules remain intact. |
| Old bookmarks, encoded branches and browser history | Correct destination and source context, or a clear recoverable invalid-link state. |
| Pinned side panel or selected run worktree | Actual panel/tool target stays visible and cannot be mistaken for the composer repository. |
| Deleted project and archived runs | Existing history remains discoverable with correct access and ownership semantics. |

Extend behavioral coverage around `test/projects.test.ts`, `test/repo-selection-ui.test.ts`, `test/workspace-routing.test.ts`, `test/team-connections.test.ts`, `test/team-connection-ui.test.ts` and `test/shared-access.test.ts`. Add focused route/context tests where existing tests do not exercise the new behavior. Retain checkout-namespace and workspace-activity regressions when touching tool targeting.

Exercise browser flows in the existing simplification, connections, SSH projects, shared projects, team, project missions, workspace, settings and accessibility suites. Check visible results and request destinations rather than snapshotting implementation strings. Run `npm run typecheck`, the relevant targeted suites and documentation checks as changes land; run the full repository-required test set before release.

For usability, pilot with a small mix of new solo users, remote users and collaborators. Ask them to start a run, switch repository, identify the execution computer, find a result, open a shared board and locate access settings. Record completion without assistance, wrong turns, time to start and incorrect destination assumptions. Compare the same tasks against the current UI.

Proposed pilot targets are at least four of five participants completing the primary start-and-review flow without assistance, and no incorrect computer or repository assumption at the launch checkpoint. These are initial decision thresholds, not statistical proof. Any wrong-target launch or lost draft blocks release regardless of the aggregate score.

## Principal risks and controls

| Risk | Control |
| --- | --- |
| Project becomes another mandatory setup burden | Open repository suggests and creates the project through a short flow. |
| Simplification hides execution location | Persistent computer context and a concrete pre-launch summary. |
| Renaming People leaves the board hard to find | Dedicated Board destination, contextual links and legacy search terms. |
| Shared and local projects look falsely unified | Qualified source identities and explicit relationships; retain connection-scoped access where needed. |
| Useful tools disappear into menus | Stable project destinations, searchable aliases and task-based discoverability tests. |
| Context refactoring loses drafts or misapplies defaults | Versioned migration, preserved recovery data and async-switch regression tests. |
| Shared views expose owner data | Reuse shared projections and enforce server permissions; do not rely on hidden controls. |
| A large rewrite delays the basic improvement | Ship the owner project flow after Phase 3, then integrate collaboration and automation. |

The recommended first implementation is the explicit context and owner project flow: one clear project destination, one composer path, predictable repository selection and visible computer scope. That creates the foundation the remaining simplification depends on.
