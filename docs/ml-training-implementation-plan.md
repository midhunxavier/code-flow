# Local and remote ML automation implementation plan

> Engineering proposal. Updated 23 October 2026 against repository revision `70fde3e`, following review of changes since `d82a2e1`. The roadmap below describes the full planned feature. Opt-in tabular training and single-device LoRA fine-tuning, bounded automatic experiments, scheduled data-driven retraining, a model registry, persistent/streaming inference, bounded model monitoring, guarded automatic promotion and common holdout evaluation are now implemented; see the implementation status and current user guide below.

Code Flow will let users train prediction models and fine-tune open language models using their own computer or a configured server. Agents will prepare experiments, diagnose failures and suggest improvements. A durable job runner will execute training and evaluation independently of agent sessions. Users will receive a model, reproducible training inputs, measured results and a clear way to use it.

Build this as an **ML workspace inside Code Flow**, backed by a separately running training worker. Default to user-owned compute. Save the preferred target per project, make cloud providers optional, and reuse existing projects, agent adapters, schedules, notifications and live updates.

## Implementation status — training, fine-tuning, improvement, scheduling, registry, inference, monitoring, promotion and common evaluation

The opt-in implementation now provides local tabular training, a standalone SSH worker adapter, computer discovery, private Python environment setup, immutable dataset preparation, random/group/time splits, held-out baseline comparison, logs, cancellation and verified model export in **Project → More → ML**. See [Model training](model-training.md) for current setup and limits.

The controller uses a bounded, serialized atomic state document for this milestone, and each job uses a detached supervisor with durable receipts. This is a deliberate smaller implementation than the journal, always-on worker service and full deployment lifecycle proposed below. Automatic searches now keep a durable iteration/training reservation ledger in the same atomic document. Jobs pin their selected target and bundle; ambiguous outcomes block another admission. Cancellation intent survives disconnected SSH and controller restarts.

Validation includes a real local AutoGluon classification run and fresh-process prediction from its downloaded export, worker lifecycle and SSH host-fixture tests, and browser checks. Verification on the user's standalone VM is deferred until they configure its alias. CPU training on an SSH server is implemented; real-VM P2 acceptance remains open.

The fine-tuning milestone provides a pinned TRL/PEFT LoRA recipe, immutable base-model snapshots, JSONL prompt/completion or conversation data, verified completion masking, explicit CPU/MPS/CUDA selection, memory estimates and a real accelerator smoke check, progress, base-versus-adapter held-out loss, and offline adapter exports. Both local and SSH workers use the same admission and receipt protocol. Idle workers can explicitly upgrade while old jobs retain their original bundle.

Validation now includes offline tiny-Llama fine-tuning on CPU and Apple GPU, matching held-out scores after fresh-process export reload, model/data scope checks, and SSH-fixture transfer/reconnect/cancellation. Real standalone NVIDIA VM verification remains deferred until the user configures the VM. QLoRA and multi-GPU execution are not claimed supported; P4’s real SSH CUDA acceptance gate is still open.

The bounded-improvement milestone implements P5 searches for both recipes on local/SSH workers: an offline adaptive search or optional text-only Claude CLI planner, durable iteration/time reservations, strict hyperparameter proposals, validation-only comparisons, patience, pause/stop/resume, and a single final test of the selected model without retraining. Training process deadlines and overall elapsed deadlines are enforced independently. Final test evidence never enters planner feedback. No improved candidate is a valid keep-baseline outcome.

Validation of the bounded-search milestone includes real local AutoGluon and tiny-Llama LoRA searches, a live text-only Claude planning turn, SSH-fixture searches, process deadline/cancellation tests, disconnect/restart accounting, invalid-proposal rejection, keep-baseline outcomes and rejection of a changed winning artifact. Browser checks cover starting a LoRA search, comparing configurations, final export download, stopping a search, mobile layout and accessibility.

The scheduling milestone adds saved interval/daily/weekday policies in **Project → More → ML**, using the existing timezone/DST calculations. Local files or files on an owned SSH server are content-hashed, observed for stability and snapshotted before a changed version can launch a bounded search. Policy occurrence records and searches are admitted atomically. Each policy pins compute, recipe, source, base model and search limits, with an additional finite lifetime run cap. Duplicate versions, missed schedules, manual-work contention and controller restarts do not reset budgets or produce a backlog. Users can check now, pause future runs, stop the current search, and resume within the remaining cap. Final models are available for explicit registry registration and review; schedules do not automatically promote or deploy results.

This smaller recurrence implementation deliberately uses the ML store and existing search runner, rather than ordinary automation prompts or managed coding-team triggers. The broader roadmap below still describes unified Automation controls, rolling budgets and notifications. Tests cover content no-ops, stability, restart claims, pause/admission races, schema drift, resource pins, lifetime caps, and local/SSH tabular and LoRA execution. Local acceptance also includes a real scheduled AutoGluon search through the browser, a controller restart that skips the already handled version, and fresh-process prediction from the downloaded export. Desktop/mobile checks cover schedule creation, pause/resume, check-now and accessible layout. Real SSH GPU acceptance remains deferred until the VM is configured.

The registry milestone adds named, project/repository-scoped models with immutable numbered versions for evaluated final exports. It retains verified local archives for both local and SSH results, compares only matching evaluation contracts, and provides revision-checked promotion, rollback to a previously selected version, explicit reasons and durable history. Incomparable data/evaluators or regressions require an explicit review acknowledgement. Selection does not deploy a model or change search/schedule limits. Restoring a missing export retrieves the original hash from the pinned worker. LoRA versions preserve their exact base-model requirement. Registry operations remain owner-only and respect filesystem policy checks. Retention is bounded to 32 models, 200 versions, 200 selection events per model and 2 GiB of registered exports.

The implemented registry API uses `POST /api/ml/registry` to register a version, `GET /api/ml/registry/:id?reference=:versionId` for a scoped comparison, `POST /api/ml/registry/:id/promote` or `/rollback` for revision-checked selection, and `GET /api/ml/versions/:id/export` or `POST /api/ml/versions/:id/restore` for retained exports. Registry models also appear in the project ML overview. The existing `/api/ml/models` preparation route still creates frozen base-model snapshots.

Registry validation covers duplicate operations, concurrent selections, stale revisions, quality-review requirements, receipt migration, damaged exports and offline SSH access. Local browser acceptance uses two real AutoGluon exports: registration, comparison, promotion, rollback, checksum-verified download and controller restart. Local/SSH tabular and LoRA fixtures also register and promote scheduled final results. Desktop/mobile accessibility and layout checks cover the registry controls.

The deployment milestone adds stable owner-authenticated inference routes, immutable serving releases, checksum-verified transfers from retained registry exports, exact base-model matching for LoRA, CPU/MPS/CUDA selection, and bounded on-demand execution on local or standalone SSH workers. Each candidate must load before a revision-checked switch; rollback uses an earlier deployment release. Stop prevents new dispatches. Existing requests retain their resolved version and deadline. Deployment selection stays independent of registry promotion and search budgets. The worker hands its control reservation to a detached inference supervisor before model loading, so disconnecting the local/SSH control process cannot release resources prematurely. User input and output travel through private pipes and are not saved as serving history.

Implemented routes are `POST /api/ml/deployments`, `POST /api/ml/deployments/:id/predict`, and `POST /api/ml/deployments/:id/{switch,rollback,stop,resume}`. The project overview includes deployments and their history. The on-demand mode loads per request and returns bounded JSON. It remains available alongside the persistent mode below. Zero-downtime replacement, scoped inference credentials, public endpoints, inference orchestration and cloud execution remain later work.

Deployment verification includes real local AutoGluon predictions, browser version switching and rollback, and offline tiny-Llama adapter generation from both prompts and chat messages. Tests cover local and SSH transport, local-to-SSH artifact transfer, failed preparation, concurrent stop/switch fencing, deadline termination of descendants, detached supervision after loss of the control connection, restart recovery, scope revocation, bounded payloads and storage capacity reserved for stopping. Serving probes check pinned dependencies and device availability without importing the training-only TRL trainer; candidate preparation still loads the actual model. Real NVIDIA GPU/SSH VM acceptance remains deferred.

The persistent-serving milestone adds an opt-in resident process for tabular models and LoRA, used by default for new UI deployments. `POST /api/ml/deployments/:id/stream` emits authenticated SSE metadata, decoded text deltas, heartbeats and a terminal result/error. `GET .../runtime` reports readiness and `POST .../warm` explicitly loads the selected version. The worker retains model weights across requests and controller restarts using a private local socket; SSH requests use the same worker protocol without a public inference port.

Each resident session has a memory budget, idle timeout and absolute lifetime, plus per-request deadlines, token/row/output caps and a client-loss watchdog. Process-group RSS is sampled; PyTorch CUDA/MPS allocator limits apply where selected. These are operational limits, not hard OS memory isolation or cumulative usage budgets. An enabled deployment reserves its worker until stopped, including after residency expires. Subsequent requests can warm a fresh session. Persistent stop durably fences old revisions, cancels active inference, confirms descendant cleanup and retains a cleanup-pending reservation during disconnects. Reconciliation retries stop delivery after restart. Version switching unloads the previous model before loading its candidate, commits only on success, and attempts to reload the previous release after failure. Zero-downtime switching remains future work; optional health-based rollback is provided by the monitoring policy below.

Verification covers persistent process reuse, local/SSH event streaming, cancellation, failed-load restoration, revision/session fencing, restart reconnection, idle/lifetime expiry, memory/deadline termination, orphan recovery, and disconnected stop reconciliation. HTTP tests verify early deltas, normal preflight errors, streamed terminal failures, fragmented UTF-8 parsing, bounded buffers and cancellation on disconnect. Real pilots confirm AutoGluon process reuse and version switching/rollback, plus CPU and Apple GPU LoRA generation with matching streamed and final text. Desktop/mobile serving controls pass scoped accessibility checks. The existing on-demand releases retain their serialized configuration and serving behavior. Real CUDA/server validation remains pending the user's VM configuration.

The monitoring milestone adds opt-in, revision-pinned policies for local and SSH deployments, with report-only defaults. Successful requests contribute private aggregate histograms; failure rates and end-to-end latency track operational health. Tabular numeric/category distributions and LLM length/token descriptors are compared against a user-reviewed traffic reference using Jensen–Shannon distance. No raw rows, prompts or generated text enter monitoring state. These signals do not establish predictive or semantic quality. Minimum traffic, repeated nonoverlapping windows, cooldown and finite lifetime actions bound automation; gaps and controller restart reset confirmation.

Health policies may roll back only to an explicitly approved previously deployed version. Drift policies reuse an existing paused retraining schedule and its exact planner, source, compute, iteration/time limits and lifetime run ledger. New stable data is mandatory. Same-worker retraining requires downtime authorization, confirmed serving cleanup and later restoration of the original release. New trained models require manual review or an independently authorized promotion policy with comparable evaluation evidence. Durable operation IDs and atomic admission/version guards make restart, pause and manual changes safe. Users can stop a search and leave serving stopped; failed restoration is capped at three attempts.

Implemented routes are `POST /api/ml/monitors` and `POST /api/ml/monitors/:id/{pause,resume,check,reference}`, with scoped monitoring state in the project overview. Tests cover numerical distance, privacy, traffic gaps, persistence, approved rollback, pause during preparation/admission, disconnected cleanup, restoration limits and existing training budgets. SSH fixtures verify telemetry, input-error classification and bounded retraining/restoration across the worker transport. Real local acceptance includes 30 AutoGluon requests across a reviewed reference and two shifted windows, and 20 LoRA responses used to capture a reference through the browser. Monitor creation, pause/resume and check-now pass desktop/mobile accessibility and overflow checks. External alerts, label/semantic quality checks and monitoring while the controller is offline remain later work. See the [monitoring guide](model-training.md#monitor-deployed-models-and-respond-to-drift) for operational limits.

The promotion milestone adds revision-pinned policies watching compatible final search results, one schedule or registered versions. Each candidate has immutable comparison evidence, an expiring owner approval or saved automatic authorization, a finite attempt budget and cooldown. Strict matching evaluation contracts and positive baseline/incumbent gain are hard gates. No agent or approval can override incomparable data or regression. Qualifying search exports register automatically; candidate loading precedes a single atomic registry/deployment/health-guard commit. The existing serving resource limits remain fixed. Restart, failed loading and manual changes cannot duplicate or overwrite a release.

Operational observation uses the existing aggregate monitor, with automatic rollback to the incumbent after repeated failure/latency breaches or insufficient healthy traffic by the observation deadline. Successful releases retain health monitoring. Rollback restores both deployment and registry selection, with bounded retries, audit history and manual recovery controls. Policies allow either per-release approval (default) or explicit automatic mode. Local and standalone SSH use the same path; cloud remains optional. Tests cover quality gates, LoRA metric direction, expired/rejected approval, pause/preparation races, restart recovery, damaged exports, capacity, attempt limits, manual overrides and real worker serving over the SSH fixture. Real local LoRA acceptance trains two candidates against matching held-out data (loss 4.4293 → 4.4206), then verifies owner approval, persistent deployment, inference, policy pause and rollback of both registry and endpoint through the browser. Desktop/mobile promotion controls pass scoped accessibility checks; the decision table scrolls within its card on small screens.

The common holdout milestone now compares candidates trained on different data by re-evaluating both fixed exports on a reserved immutable dataset. Local and standalone SSH use the same bounded worker job. Exports retain exclusion hashes for all original training, tuning and test inputs; checks cover normalized rows/prompts, group boundaries, time ordering, tokenized prompt overlap and identical LoRA evaluation populations. Legacy exports without evidence require retraining. A policy retains separate lifetime comparison and elapsed/memory limits, explicit serving-pause consent, default owner approval or authorized automatic deployment, evidence-bound decisions and existing rollback protection.

Admission and cleanup are durable. Evaluation pauses serving without advancing its revision, blocks competing compute work, and restores the incumbent before review. Restart adopts the same evaluator; pause, expiry, memory failure and manual stop cannot silently start another evaluation or undo owner intent. Serving restoration is capped at three attempts. Results never enter experiment-planner feedback. The host RSS limit is soft and does not constrain GPU VRAM separately. A finite comparison cap mitigates repeated reuse but does not establish statistical significance or prevent semantic leakage.

Validation includes real local AutoGluon models trained on different data (common accuracy 0.70 → 1.00; fixed baseline 0.50) and tiny LoRA adapters (common completion NLL 4.4311 → 4.4105; base 4.4342), followed by approval, inference, controller restart and rollback. These are controlled fixtures, not production-quality claims. Local/SSH worker coverage exercises durable evaluation and serving restoration; targeted cleanup checks cover cancellation, manual stop and memory failure. A changed-data search winner also registers and deploys automatically without changing its search budget. Browser acceptance covers holdout preparation, serving-pause consent, approval, streaming and rollback; promotion controls pass scoped desktop/mobile accessibility checks. See [common holdout evaluation](model-training.md#compare-models-trained-on-new-data) for supported controls and limits.

The broader lifecycle proposed below still includes production serving, retention and external registry synchronization. P0/P1 foundations and parts of P2/P4/P5 are implemented. Multi-metric/statistical gates, traffic-split canaries, external approvals, broader agent-provider routing, arbitrary recipe editing, automatic retention/upgrades, rolling budgets, notifications and unified Automation-page integration remain planned. Claude’s configured model string is retained; upstream aliases are not immutable model-version pins. Its dedicated planner uses verified CLI tool restrictions rather than the ordinary coding adapter’s file access. Real GPU/VM acceptance remains deferred until hardware is configured.

## Review of the updated application

The four upstream changes strengthen the integration points without replacing the need for a durable training worker. This revision incorporates the following changes, verified against the implementation:

| Upstream change | Consequence for the ML plan |
| --- | --- |
| `991c2f3` — workflow setup, retries and review evidence | Scope readiness to selected providers, preserve retry inputs, and invalidate comparison evidence when its inputs change. ML retries must retain the cycle's remaining allocation. |
| `0968718` — status, history and startup | Reuse bounded project summaries and evidence-based status presentation. Count ML outcomes separately from successful child agent turns. |
| `217a659` — project navigation and workflow context | Place ML under the project's progressive navigation, scope drafts to computer plus project, and require explicit repository membership at admission. |
| `70fde3e` — Auto model routing, templates and inherited permissions | Reuse agent catalog/assignment evidence and run permission checks; pin optional strategy templates. Keep trained-model compatibility and training-worker permissions as separate contracts. |

The first implementation remains local tabular training followed by owned SSH execution. The new agent features improve P5's bounded improvement loop; they do not justify moving GPU training into an agent turn or making cloud services mandatory.

## 1 Product decisions

| Decision | Planned behavior |
| --- | --- |
| Default compute | The current project's computer until the user saves another default. A configured CPU server or GPU server can become the project default. |
| Target selection | Explicit experiment choice, then saved project default, then installation default. Use the current computer only when no default has been configured. An unavailable selected target stays unavailable; it never silently changes. |
| Accounts | Local and SSH training require no cloud training account. Agent authentication follows the existing CLI setup. Private or gated model downloads can separately require credentials. |
| Product surface | Project → More → ML initially; retain an ML tab once configured. Provide **Train a prediction model**, **Fine-tune a language model**, and **Improve an existing model** entry points. |
| Execution | Python training recipes run through a persistent worker. Agent turns remain short planning, coding, diagnosis and review steps. |
| Automation | A saved policy bounds recipes, editable inputs, targets, trials, resource use and recurring work. Routine steps within that policy run without repeated confirmation. |
| Evaluation | A versioned evaluator measures candidates against a baseline. The search agent receives validation feedback; final test evidence is kept outside the optimization loop. |
| Model use | Export and local testing ship first. Marking a model as the selected version is separate from deploying it to a serving endpoint. |
| Tracking | Native experiment summaries work immediately. MLflow synchronization is an optional integration, including with a user-hosted MLflow server. |
| Release order | Local training, SSH training, fine-tuning, bounded improvement and recurring cycles form the initial product. Cloud execution follows as an optional adapter. |

Training compute and agent usage have separate accounting. “No cloud training bill” does not mean that owned hardware, electricity or agent usage is free.

## 2 User experience

### Connect a training computer once

In **Settings → Connections → Training computers**, show **This computer**, **Add server**, and a separate optional **Cloud providers** entry. The server flow accepts an existing SSH alias, a display name and a worker directory. It tests access, identifies available resources and shows which recipes can run.

For a new worker, offer a concrete setup action that installs the versioned Code Flow worker and a selected recipe environment in a user-owned directory. Show downloads, disk requirements and the destination before setup. Reuse a compatible environment on later runs. Do not require administrator access, install GPU drivers, or change the user's system Python. A server administrator can also provision the worker in advance.

Users can choose **Use by default for this project**. Every start screen displays the resolved computer, resource profile and data location. In an SSH project, “This computer” means that project's remote backend host; always include its name to avoid confusing it with the browser's computer.

### Train a prediction model

1. Select a CSV or Parquet dataset on the chosen computer, or choose a file to transfer there.
2. Describe the outcome and select the target column. Code Flow suggests the task and metric, then explains them in plain language.
3. Show data issues that affect the task: absent labels, duplicates, possible leakage, time ordering or groups that must remain together.
4. Select **Quick baseline** or **Improve within a budget**. Display the chosen computer, maximum trials and maximum execution time.
5. Run validation, a baseline and the bounded experiment loop. Present progress as Preparing data, Training, Evaluating and Comparing.
6. Show results against the baseline, the types of mistakes observed, resource usage and **Try predictions** / **Export model** actions.

Classification and regression are the first supported tasks. Time-dependent rows and grouped entities require appropriate splits even before dedicated forecasting recipes exist. Do not infer that a random split is valid merely because a dataset is tabular.

### Fine-tune a language model

1. Describe the intended behavior and supply example inputs and desired responses in JSONL or a supported mapped format.
2. Select an existing local base model or an explicitly requested model download. Recommend compatible models using actual worker capabilities and recipe compatibility records.
3. Check examples, chat templates, sequence lengths, training/evaluation separation and resource fit.
4. Evaluate the base model, run a small training test, and show a time/resource estimate before the full run begins under the saved budget.
5. Train an adapter, evaluate it and compare outputs on representative validation examples.
6. Export the adapter with its base-model revision, tokenizer, template, dependency information and a minimal loading example. Merging weights is a separate capability-dependent operation.

The first recipe uses supervised fine-tuning with LoRA. Offer QLoRA only for verified model, hardware and library combinations. Keep rank, optimizer, batch size and similar settings under **Advanced**. If the user's data does not support an appropriate evaluation, explain what examples or labels are missing before starting an optimization cycle.

### Improve and repeat

After the first run, **Improve this model** reuses its objective, data lineage and evaluation contract. The agent proposes a small number of changes, runs them within the remaining allocation, and explains which changes helped or failed.

**Keep improving** saves an automation policy: trigger, minimum new data, allowed changes, execution target, per-cycle limits, rolling limits and model-selection policy. Saving this policy authorizes subsequent eligible cycles. The default is to train and evaluate candidates, then notify the user when a meaningful result is ready. Automatic selection can be enabled with fixed acceptance rules; endpoint deployment remains a distinct policy.

### Simple presentation with useful detail

Use three ML views: **Overview**, **Experiments**, and **Models**. Put recurring-policy editing in the existing **Project → Automation** surface, with a **Keep improving** shortcut from ML. Both entry points edit the same workflow policy and managed trigger. Keep datasets and compute settings accessible from Overview rather than requiring a large platform setup before the first run. Show one experiment timeline with links to its agent turns and training jobs. Raw logs and training configuration are expandable details.

The overview answers: What are we improving? Which computer is working? Is the candidate better? What did it cost in time and resources? What can I do with the model? A successful process exit appears as **Training finished**; **Evaluation passed** and **Selected model** require their own evidence.

An ML workflow initially belongs to a Code Flow project and a recipe repository. Users can attach an existing repository or let setup create a small managed recipe repository under a selected workspace directory. They should not need to author training code before the first run. Store datasets and weights separately, and record the exact source commit for every experiment. Dirty source changes require an explicit snapshot; never sweep unrelated working-tree edits into a training revision.

Follow the current [project-context](../ui/project-context.ts) and [feature-discovery](../ui/project-features.ts) conventions. Save setup drafts under a separate ML namespace keyed by owning computer, project and workflow/draft ID. Store input references and form choices, not dataset bytes or credentials. Switching projects or computers preserves each draft; a late response from the previous scope cannot overwrite the current one. A missing project or removed repository blocks submission and retains the draft instead of silently placing it elsewhere. Show draft-save failures with a retry action.

Use **Agent model** for the model planning experiments and **Base model to fine-tune** for the weights being trained. The agent catalog and the ML model library have different purposes and compatibility evidence. Training or exporting a model does not automatically register it as a Code Flow agent provider.

## 3 Initial scope and compatibility

| Capability | Initial release | Follow-on work |
| --- | --- | --- |
| Tabular classification and regression | AutoGluon recipe on validated Linux/macOS CPU environments; GPU use only when the specific recipe supports it | Additional recipes and larger datasets |
| Language model SFT | TRL + PEFT, selected open causal language models, Linux with supported NVIDIA CUDA hardware | Broader model and modality coverage |
| Own remote computer | Standalone Linux CPU or GPU server over configured SSH | Additional remote operating systems |
| Apple Silicon | Native tabular CPU training and agent orchestration; configured GPU-server execution for LLM recipes | A separately tested MLX fine-tuning recipe for local Apple GPU execution |
| Windows | Document a validated WSL2 route when tested | Native worker packaging and process control |
| Compute size | One machine per job, one GPU per initial LLM recipe | Multi-GPU and distributed training |
| Cluster schedulers | Explicitly unsupported by the direct SSH adapter | Slurm adapter with scheduler-owned submission and cancellation |
| Data | Versioned local/worker files; explicit transfer | Object stores, database snapshots and streaming sources |
| Fine-tuning methods | SFT with LoRA; QLoRA for supported combinations | DPO, reward-based training and distillation |
| Model use | Local evaluation, prediction preview and export | Serving adapters, canary deployment and automatic rollback |
| Cloud | No requirement or automatic provisioning | Optional provider connections and job adapters |

Capability discovery must distinguish hardware presence from a working training environment. A visible GPU is insufficient: verify the driver/runtime, library import, a small allocation and the selected recipe's compatibility. If local LLM training is unsupported, offer a configured compatible target or explain setup requirements; do not silently start a costly CPU run.

Keep first-release work to trusted-owner execution. Shared accounts, remote phone control and multi-user GPU administration require separate authorization and isolation acceptance tests before enablement.

## 4 Existing foundations and necessary changes

| Existing component | Verified current behavior | Integration work |
| --- | --- | --- |
| [Projects](../src/projects.ts), [project context](../ui/project-context.ts) and [navigation](../ui/navigation.ts) | Explicit project selection, computer-scoped drafts and progressive project tools | Add separate ML configuration/drafts, explicit membership checks and ML routes. Do not mix training policy with last-used agent selections. |
| [Engine](../src/engine.ts) | Agent turns, deterministic workflow replay, checks, worktrees and Git artifacts | Launch bounded child runs for planning/diagnosis. Link their provenance to an ML cycle. Add typed model references separately from Git artifacts. |
| [Workflow patterns](../src/patterns/index.ts) | Registered agent workflows | Add a bounded ML planning/analysis workflow. The ML service owns the lifecycle across training jobs. |
| [Extensions](extensions.md) | Pinned provider and workflow bundles | Leave ordinary agent extension semantics intact; training recipes and compute adapters use explicit contracts. |
| [Automations](../src/automation.ts) | Schedules and a managed target specifically for project teams | Extend the target union and dispatch hooks for ML workflows. Preserve existing project-team behavior and strict persistence. |
| [Project team store](../src/project-team-store.ts) | Serialized writes, revisions and fsync before acknowledgement | Reuse its durability approach for ML state, with atomic admission records that include resource reservations. |
| [Deferred runs](../src/deferred-runs.ts) | Durable claims and explicit unknown launch outcomes | Reuse the receipt/reconciliation design, keeping training queues distinct from agent availability queues. |
| [SSH projects](ssh-projects.md) | Whole remote backend; persists across SSH disconnection | Reuse connection discovery and host identity where appropriate. Add training-worker setup without requiring a full remote project. |
| [Remote agent workers](remote-workers.md) | Agent-specific protocol, bounded Git transfers and 30-minute turns | Retain their existing semantics. Training gets a separate protocol and independently running supervisor. |
| [Provider eligibility](../src/provider-eligibility.ts) | Unattended, ACP, plugin and host restrictions | Apply eligibility to every automatic ML agent turn. Unsupported providers can remain available for eligible interactive use. |
| [Agent model catalog](../src/model-catalog.ts) | Environment-specific discovery, assignment provenance, pins and dispatch revalidation; dynamic routing is enabled for new Auto-team runs | Reuse these services for ML agent choices through explicit integration. Do not use inference-model discovery as evidence that base weights can be trained. |
| [Run permissions](../src/run-permissions.ts) and [environment inheritance](../src/run-environment.ts) | Run-owned authority, narrower child permissions, inherited execution boundaries and per-turn effective receipts | Apply to ML child agent runs and resumptions. Define independent, enforced training/evaluation profiles on the worker. |
| [Team templates](../src/team-templates.ts) and [template store](../src/team-template-store.ts) | Closed, versioned strategy definitions with immutable versions and no execution authority | Reuse optional planning/review strategies. Keep typed training recipe inputs, target bindings and budgets in ML records. |
| [Readiness](../src/readiness.ts), [run status](../src/run-status.ts) and [project reports](../src/project-report.ts) | Selected-provider readiness, evidence-aware results and bounded index projections | Add ML-specific preflight and outcome summaries. Git-check success cannot stand in for model evaluation. |
| [Slots](../src/slots.ts) | Limits concurrent agent/check processes | Add independent training resource reservations. A waiting GPU job must not occupy an agent slot. |
| [Stream broker](../src/stream.ts) | Multiplexed, scoped live updates | Add ML experiment/job topics through the existing connection. Use bounded snapshots and resumable log cursors. |
| [Review inbox](../src/review-inbox.ts) and [notifications](../src/notifications.ts) | Attention items and configured deliveries | Group ML results by cycle; notify on completion, failure, exhausted limits or required input. |
| [Shared access](../src/shared-access.ts), filesystem policy and [retention](../src/retention-policy.ts) | Central access checks and reviewed deletion | Add ML-specific scope checks, active-job protections, artifact retention and restore reconciliation. |

The current `Pattern` options support numeric and boolean values. Dataset, model and target inputs need a dedicated typed ML setup form/API; encoding them into a task prompt would lose validation and stable identity.

Current `TeamContext.artifact()` records a Git branch and diff. Model weights, dataset snapshots and checkpoints belong in a separate artifact system. Existing no-diff automation cleanup must not discard an ML result simply because training produced no source changes.

## 5 Architecture and ownership

| Layer | Responsibility | Lifetime |
| --- | --- | --- |
| ML workspace | Setup, live status, comparisons, model actions and saved defaults | Browser session, reconnectable |
| ML service on the project host | Workflow state, budgets, admission, agent coordination, evaluation decisions and recovery | Code Flow backend |
| Existing agent engine | Planning, data diagnosis, allowed code/configuration changes and result explanation | Short bounded child runs |
| Training worker on the selected computer | Durable job receipt, resource reservation, child process/container, logs, timeout and cancellation | Independent of the backend and SSH connection |
| Training recipe | Data preparation, fitting, checkpoints and candidate manifest | A job attempt |
| Evaluation recipe | Scoring under a pinned evaluation contract | A separate job with protected inputs |
| Artifact store | Datasets, weights, checkpoints, reports and their hashes | Independent of worktree cleanup |

The main flow is: create an immutable experiment specification; validate it; reserve resources; submit a job; reconcile its receipt; import candidate metadata; evaluate; compare; either finish or admit the next bounded experiment.

The backend does not keep an LLM conversation running while a GPU trains. A persisted completion event schedules the next agent or evaluation step. If the backend is unavailable, an already admitted job continues under its own limits. Further experiments and new scheduled cycles wait for the backend to return.

A training server needs the worker, the recipe environment, storage and compute. It does not need agent CLIs or agent credentials when orchestration runs on another computer. Users who already run a complete SSH project can use a worker on that project's host through the same interface.

Resolve three identities independently: the project/controller computer, the agent execution environment, and the training target. An SSH GPU target does not change the agent's `remoteWorker` setting or transfer agent credentials. Child agents retain their parent's execution boundary through the existing environment-inheritance contract; moving training to another authorized target does not grant permission to move those agents.

## 6 Compute targets and defaults

A compute target is a versioned connection to a worker, with explicitly configured resource and storage profiles. Its public projection contains a display name, availability and supported recipes. Private connection material remains outside run transcripts and project Git files.

Illustrative contract:

```ts
type ComputeTarget = {
  version: 1;
  id: string;
  revision: number;
  controllerHostId: string;
  kind: "local" | "ssh" | "cloud";
  displayName: string;
  connectionRef?: string;
  workerIdentity: string;
  resourceProfileIds: string[];
  storageMappingIds: string[];
  capabilitiesRef: string;
  enabled: boolean;
};
```

The `cloud` variant remains unavailable until a cloud adapter is installed and enabled. Target IDs are scoped to their controlling host; identical names on different computers are never interchangeable.

For new experiments, resolve the target once and pin its revision, worker identity, resource profile and storage mappings. Existing queued or running jobs never inherit a later default change. Disabling a target prevents new admissions while preserving inspection and cancellation of known jobs. Deleting a target with live or unresolved jobs is refused until the user resolves or archives those jobs with their recovery identity intact.

### Local worker

Start a versioned worker supervisor outside the agent process tree, using a private local control channel and an owner-only state directory. It must survive a browser close and backend restart. Packaging must ensure the application's existing orphan-process cleanup excludes registered training supervisors while still cleaning ordinary agent children.

Machine sleep pauses local computation. The worker detects an exceeded absolute deadline on wake and stops or finalizes the attempt before accepting more work. A reboot interrupts training; a recipe may resume from a verified checkpoint as a new attempt when the saved policy permits it. Do not claim uninterrupted execution across sleep, reboot or power loss.

### SSH worker

Reuse validated SSH aliases and strict known-host handling. Launch a fixed worker-control executable and pass a bounded structured request through standard input. Model names, data paths and agent text must not become shell fragments or SSH options. Keep control requests separate from large artifact transfers.

The remote supervisor persists independently of the control channel. Reconnection inspects the original job receipt using the pinned worker identity. Never rely on `nohup` alone as the job management protocol. Keep existing remote agent workers unchanged, including their behavior on disconnection.

A direct SSH target represents a user-owned standalone server. A cluster that requires Slurm must use a later scheduler adapter; connecting to its login node does not authorize direct GPU process launch.

### Resource profiles

Profiles specify maximum concurrent jobs, CPU threads, RAM, GPU device UUIDs, disk allowance and execution mode. Default to one active training job per selected GPU and one ML cycle per workflow. Resolve shared targets to the same worker identity so two project aliases cannot reserve the same device independently.

The worker is authoritative for resources on its machine. GPU inventory checks detect external usage but cannot reserve hardware against unrelated OS users. For shared servers, use OS/container controls or an administrator-provided allocation. Clearly distinguish enforced limits from observed usage: an environment without enforceable memory containment must not advertise a hard RAM guarantee.

## 7 Training recipes and environments

Recipes are versioned packages with an input schema, compatibility declaration, environment definition, entry point, progress schema and output-manifest schema. Keep training recipes independent of agent providers and compute transport. The same pinned recipe should run locally or on an SSH worker when both satisfy its requirements.

Initial recipes:

| Recipe | Inputs | Output | Important limits |
| --- | --- | --- | --- |
| `tabular-autogluon` | Dataset snapshot, target, task, split contract, metric, preset and time allowance | Predictor bundle, preprocessing metadata and training report | Single-machine classification/regression; validate CPU/GPU requirements per preset |
| `llm-sft-lora` | Base-model revision/path, tokenizer, chat template, training examples, adapter configuration and limits | Adapter, tokenizer/template references, training report and checkpoints where supported | Initial verified Linux/NVIDIA combinations; configurable maximum sequence length |
| `evaluate-tabular` | Candidate bundle, evaluation dataset and fixed scoring specification | Predictions where permitted, aggregate metrics and slice report | Isolated evaluation workspace; bounded output size |
| `evaluate-llm` | Candidate/base-model references, prompts, decoding configuration and rubric/metric versions | Quality and regression report with bounded example outputs | Identical evaluation contract for candidate and baseline |

Use pinned Python dependencies and versioned container digests or managed virtual environments. A virtual environment isolates dependencies, not hostile code or resources. Generated/custom Python training code requires the configured execution isolation; the first novice workflow uses reviewed recipe templates with validated configuration changes.

Preflight verifies interpreter/library compatibility, dataset readability, free storage, model availability, GPU runtime, estimated memory fit, output write access and cancellation support. Follow it with a tiny import/forward/backward test for LLM training. An out-of-memory diagnostic may suggest a smaller batch, shorter sequence or supported quantization change; applying a change creates a recorded new attempt and consumes the retry budget.

Prefer stock TRL + PEFT first. Treat Unsloth, MLX, additional AutoML engines and custom trainers as separately versioned recipes with their own compatibility tests. Do not install the newest upstream packages during every experiment. Updating a recipe creates a new environment identity and must pass its smoke tests before use.

All recipes implement structured progress and finalization. `checkpoint`, `resume`, `pause` and `exportMerged` are explicit capabilities. A recipe without checkpoint support can be stopped and rerun; its UI must not offer a misleading resume button.

## 8 Data and model handling

### Dataset snapshots

Store large data outside Git worktrees and agent context attachments. Register a source against an allowed storage mapping, then create an immutable snapshot or a manifest backed by an immutable provider version. Include content hashes, byte sizes, schema, row count, label/target description and creation provenance. Hash large inputs as a stream.

A path plus modification time is not a reproducible snapshot. Files that can still change must be copied into a managed snapshot or supplied by a storage system with immutable versions before training. Do not hard-link writable source data and call the result immutable.

The split contract records row/group identifiers, time cutoffs, seed and deduplication rules. Fit transformations on the training partition only. Keep related conversations, customers or documents together where required, and deduplicate before assigning partitions. A new objective, label definition or split policy creates a new evaluation lineage.

### Data movement

Prefer data already on the selected training computer. Otherwise, show the transfer destination and estimated size before the initial transfer authorization. Reuse verified cached objects on later experiments within the saved policy. Use resumable transfers, temporary destinations, checksums and atomic finalization. A failed or incomplete transfer cannot become a valid dataset reference.

Remote paths are interpreted against worker storage mappings, never against the controller's filesystem. Reject traversal and symlink escapes, special files and unexpected archive entries. Validate decompressed sizes and available disk. Large datasets and weights do not pass through the existing bounded agent Git-bundle protocol or the browser event stream.

### Model inputs and downloads

Support a local model directory from the first fine-tuning recipe. Record the base weights, configuration, tokenizer and template as a versioned input. If the user chooses a Hub model, resolve and pin the exact revision and download it to the selected worker's cache under the configured network policy. Public downloads may work without credentials; gated/private assets use worker-scoped credential references and the user's access rights.

Prefer declarative model loading. Arbitrary model loader code or unsafe serialization requires the corresponding trusted execution profile. Candidate models are loaded inside evaluation isolation so their loaders cannot modify the scoring contract or reach worker-control credentials.

### Agent visibility

By default, agents receive schema, aggregate diagnostics and training/evaluation summaries. Data samples are a separate setting with a bounded preview. Explain that allowing samples to an externally hosted agent provider can send those samples outside the training computer. Keeping compute on a private server alone does not establish that all agent context remains private.

Dataset text and model-generated outputs remain untrusted task data. They cannot alter resource limits, targets, evaluation rules or publication policy. Secrets remain outside dataset previews, Git commits, transcripts, event payloads and exported manifests.

## 9 Durable records and storage

| Record | Essential fields |
| --- | --- |
| ML workflow | Owning computer/project/repository identity, objective, recipe policy, default target, dataset source, evaluation contract, agent selection/permission policy, optional strategy template version, budgets and automation policy |
| Cycle | Workflow revision, occurrence ID, immutable input manifest, baseline, pinned policy/template evidence, remaining allocation, active steps and outcome |
| Experiment | Hypothesis, parent experiment, exact source/configuration, recipe/environment, input references and candidate reference |
| Agent invocation | Cycle/step/run IDs, durable allocation reservation, actual provider/model/effort, catalog environment/revision, effective permissions and outcome |
| Job attempt | Operation ID, intent hash, target identity, reservation, worker job ID, state, deadlines, logs cursor and terminal receipt |
| Dataset snapshot | Storage mapping, immutable revision/hash, schema and split references |
| Model artifact | Base model, adapter/weights manifests, producing attempt, recipe/environment, dependencies and storage ownership |
| Evaluation | Candidate and baseline hashes, evaluator version, dataset/split version, decoding settings, metrics, status and report reference |
| Selection event | Expected previous selected version, chosen artifact, exact accepted evaluation and policy revision |

Use a dedicated private directory under `CODEFLOW_HOME/ml/`. The initial storage design is a single serialized authoritative event journal per controlling backend, with atomic event batches and fsync before acknowledgement. One admission batch records the job intent, budget reservation and dispatch operation together. Per-cycle/job snapshots and indexes are rebuildable projections. Do not require a new database service.

The worker has its own authoritative job receipts and resource ledger under its configured state directory. The controller stores references and reconciled observations. Neither side infers terminal success from the other side disappearing. Two controllers cannot independently govern the same worker allocation; enroll the worker to one controller identity for the initial release.

Required persistence behavior:

- Revision-checked updates reject stale edits with a conflict response.
- Reusing an operation ID with identical content returns the existing outcome; different content is rejected.
- Failed authoritative writes prevent dependent execution. A broken journal is preserved for repair rather than overwritten.
- Recovery reconstructs active admissions and unresolved receipts before admitting new work. Replay itself launches nothing.
- Metrics and logs use bounded streaming files and summaries; checkpoints are artifact references, never embedded in journal events.
- Periodic snapshots, journal rotation and compaction preserve active reservations, operation deduplication, evaluation lineage and retained history. Compaction publishes only after replay equivalence is checked.

Proposed initial control limits: 32 configured targets, 100 active/queued job attempts, a 256 KiB maximum control request, and paginated experiment/history lists. Keep metric-event cardinality and transcript tails bounded. Dataset, model and checkpoint size limits belong to explicit storage profiles because realistic sizes differ substantially between recipes.

## 10 Job lifecycle and recovery

The controller adapter contract is `probe`, `prepare`, `submit`, `inspect`, `readLogs`, `cancel` and `listArtifacts`. Submission receives an operation ID and an immutable intent hash. Checkpoint resume creates a new attempt with a parent checkpoint reference. The worker implements a version-negotiated protocol independently of `AgentAdapter`.

| State | Meaning and permitted next action |
| --- | --- |
| `queued` | Intent recorded; waiting for data, resources or target availability |
| `preparing` | Preparing verified inputs/environment under reserved limits |
| `submitted` | Worker durably accepted this exact operation; execution identity is being reconciled |
| `running` | Worker confirms a live attempt with an owned execution identity |
| `finalizing` | Process exited; manifests, checksums and terminal receipt are being committed |
| `succeeded` | Training outputs passed structural validation; evaluation is still a separate step |
| `failed` | Worker confirms a terminal error, including an exceeded deadline or validated OOM failure |
| `cancel_requested` | Cancellation recorded; termination has not yet been confirmed |
| `cancelled` | Worker confirms the attempt and its descendants stopped |
| `unknown` | Execution outcome cannot be established; retain authority and reservation until reconciliation |

Resource exhaustion and an unavailable target remain reasons attached to `queued`; they are not evidence that a submitted job failed. A timed-out network request after submission becomes unresolved/unknown, not an automatic new attempt.

### Admission and launch

1. Validate current project scope, workflow policy, target identity, inputs and budgets.
2. Commit a controller admission record with the operation ID, intent hash, reservation and deadlines.
3. Ask the worker to accept that operation. It must atomically reserve its resources and persist its receipt before starting training.
4. Repeated submission of the same intent returns the existing receipt. A launch crash window is reconciled against the original execution identity; it cannot authorize another launch.
5. Record the worker receipt and reconcile progress independently of agent turns.
6. Commit final artifact manifests and terminal state before releasing resources and scheduling dependent evaluation.

Persist boot identity, process start identity and owned container/process-group identity as appropriate. A numeric PID alone is insufficient because it can be reused. Worker launch code needs explicit fault tests before and after process creation and receipt persistence; any unresolved launch remains fenced from automatic retry.

### Disconnection and restarts

| Event | Required behavior |
| --- | --- |
| Browser closes | Jobs continue; a new browser session reads durable state |
| SSH disconnects | Remote supervisor continues under its saved limits; reconnect inspects the same receipt |
| Code Flow restarts | Supervisor continues; controller reconciles existing jobs before advancing cycles |
| Agent quota exhausted | Already admitted jobs continue; further agent analysis waits without cancelling useful compute |
| Worker restarts | Recover and inspect owned processes/containers; adopt only verified identities, otherwise mark unknown |
| Training machine reboots | Detect the boot change; mark the attempt interrupted/failed once termination is established; optionally create a checkpoint-based attempt within policy |
| Inputs change | Running attempts retain their pinned snapshot; new cycles see the new version |
| Remote host identity changes | Refuse to send old private capabilities or resume authority to the new host |
| Backup restored elsewhere | Recover records for inspection, keep schedules disabled, and re-enroll/reconcile targets before execution |

Cancellation is idempotent and scoped to the job identity. Stop the process group or owned container, allow a bounded grace period, then escalate according to the profile. Confirm termination before releasing the reservation. If the host cannot be reached, show **Cancellation pending** and keep inspection/cancellation available.

Stopping an ML cycle prevents new steps and requests cancellation of its active compute jobs. Pausing an automation prevents future cycles; it leaves an active cycle running unless the user also chooses Stop. Pausing a training process is offered only when the recipe/worker can implement it correctly.

### Retry, resume and readiness

Expose **Inspect existing job**, **Resume analysis**, **Retry failed training**, and **Start another experiment** as distinct actions. Inspection cannot create work. Resume reuses the cycle and its remaining allocation; retry creates a new attempt only after the old one is confirmed terminal. Preserve input snapshots, target identity, model assignments, source restrictions and evaluation lineage unless the user explicitly starts a changed experiment. A change invalidates affected comparison evidence rather than keeping a previous passing badge.

Ordinary Auto-team Resume can grant a fresh bounded agent allocation. ML child runs must instead return through the ML service for admission. Add server-assigned ML provenance and guards to direct resume, rerun, follow-up and child-launch paths, using the existing managed project-team admission pattern as a reference. Otherwise an ordinary run action could bypass the cycle-wide budget or detach a child from its policy. Recheck project membership, eligible agent execution, recipe support, inputs and remaining resources immediately before dispatch. An unrelated unavailable CLI must not block a fixed-recipe training job that needs no agent.

## 11 Agent loop and authority

Use the existing eligible coding agents. A small workflow is sufficient: a planner/analyst proposes a typed experiment, a builder handles allowed code changes when necessary, and an independent reviewer examines changes and evidence. A fixed recipe can skip the builder. The deterministic evaluator remains authoritative for measured model quality.

The loop is:

1. Inspect the objective, capability report, schema and permitted data summaries.
2. Produce an experiment specification containing the hypothesis, allowed changes, chosen recipe, expected resource use and reason for the change.
3. Validate the proposal against the saved policy and remaining allocation on the server.
4. Prepare and execute the experiment; classify failures using structured diagnostics.
5. Evaluate against the fixed baseline and validation contract.
6. Record the outcome and concise experiment memory; stop or propose one next experiment.

Initial automated changes are bounded recipe parameters and supported preprocessing choices. Arbitrary feature/model code generation is an advanced policy with explicit editable paths, isolation and independent code review. Dataset transformations create new versioned outputs; original data remains recoverable.

Permit a small, declared retry count for confirmed recoverable failures. Unknown outcomes never enter that retry path. The agent cannot enlarge its budget, switch compute providers, alter the success metric, access the final test set, enable downloads or publish a model outside the saved policy.

Expose typed tools such as `ml.describe_inputs`, `ml.propose_experiment`, `ml.get_job`, `ml.get_validation`, and `ml.compare_experiments`. The service derives project, cycle, target and remaining budget from the capability scope. A model-supplied ID is not authority to read or control another project's job. Proposal tools do not directly spawn processes.

Existing provider eligibility and resolved run permissions both apply. Treat automatically dispatched ML turns as unattended, including those following a manual **Start** click. Carry that context through an explicit server-owned execution marker; the current engine derives it primarily from a trigger or lockdown, so ML metadata alone would not enforce it. Do not bypass restrictions by describing a background cycle as an interactive run. An unavailable eligible provider pauses the analysis stage and produces one actionable inbox item.

### Agent model selection

Reuse `ModelCatalogStore`, `resolveModelAssignment` and dispatch constraint checks for agent planning/analysis. Preserve user-selected coordinator settings and explicit worker model/effort pins. Automatic choices use the actual agent host/container's catalog; discovery on the project host cannot prove availability on a remote agent worker. Record the chosen model, effort, rationale, catalog revision/environment and stale state. Resume reuses the recorded choice and revalidates it; a replacement is an explicit, budgeted decision within the permitted pool.

The current engine enables `modelRouting` for `auto-team` and journals assignments for member turns. A new ML pattern will not receive that behavior automatically. Prefer bounded existing Auto-team child runs where appropriate, or explicitly integrate the catalog/assignment contract into the ML agent adapter. Neither approach makes a team task the owner of a training process. Fixed-recipe jobs remain usable without an agent catalog or model call.

Catalog observations measure agent invocation outcomes, not predictive accuracy or fine-tuning compatibility. Keep the training recipe's hardware/base-model matrix separate. Respect the existing opt-in documentation research setting. Its offline discovery switch does not disable agent inference or external tools and must not be presented as an offline/private training guarantee.

### Permissions and execution profiles

Persist the agent permission policy with the cycle. At every dispatch, retry and recovery, intersect it with current run/workspace restrictions and resolve effective permissions through the existing engine. Record the receipt; provider replacement, templates and user messages cannot broaden it. Reuse `inheritRunEnvironment` for agent continuations. Derive training-worker authority separately from the saved ML policy and registered resource/storage profile.

The current [permission verification report](worker-permission-verification.md) establishes specific boundaries, not universal isolation. Worktrees do not prevent external reads; terminal network restrictions do not necessarily cover browser/MCP access; setup and check commands have their own execution environment. The managed Antigravity executor is local macOS and file-only, so use structured proposals instead of requiring live ML tools there. Its unrestricted mode is ineligible for unattended ML cycles. Other providers/environments must satisfy the requested boundaries through their actual capability checks.

This permission layer does not replace the independent training/evaluation isolation required in section 12. Fixed recipes accept validated parameters through the service. Generated training code remains unavailable until both agent and worker profiles demonstrably protect evaluation inputs and worker-control credentials.

### Reusable strategies

Where helpful, reference an immutable team-template version for data diagnosis, experiment planning or independent review. Reuse the existing library and validation rather than building a second agent-strategy store. Templates supply instructions and task structure; they cannot supply credentials, host bindings, spending authority or permission upgrades. Pin the resolved version in the cycle so later template edits do not change running work. A template task requesting training can only propose an experiment through the ML service. Recipe schemas and the ML workflow retain typed dataset/model/target inputs and the final admission decision. Strategy reuse is optional in P5 and does not delay the first local training slice.

Use AutoML or an optional numerical tuner for hyperparameter search inside a bounded experiment. Account for its internal fits and runtime as part of the experiment; a nominal single trial cannot conceal an unbounded search. Tree search and ablation-guided refinement are later strategies behind the same proposal and budget contracts.

## 12 Evaluation and model selection

Freeze the primary metric, its direction, minimum useful improvement, required slices, resource constraints and split contract before an improvement cycle begins. Pin an evaluator implementation/environment and a dataset version for every report. Changing these creates a new comparison lineage, not a retroactive improvement claim.

For tabular models, compare the candidate and baseline on identical validation partitions, use time/group-aware splitting where required, and report relevant class/slice behavior. For LLMs, compare the original or currently selected model with the candidate using the same prompts, decoding settings and task metrics. Include general-behavior regression checks where the use case requires them.

Small observed improvements need repeat evaluation or uncertainty estimates appropriate to the task. Model-training seeds, evaluator randomness and model-judge configuration must be recorded. An LLM judge can provide a rubric score, but it is not a substitute for objective checks when correctness can be computed.

Keep the final test set and its labels outside agent and training mounts. Candidate code, model loaders and generated predictions execute with access limited to their required inputs; evaluator output and final acceptance are committed by the trusted evaluation path. Logical file separation alone is insufficient if the training process has the same unrestricted filesystem authority.

For automatic code changes, require an execution profile that actually prevents both the coding agent and training code from reaching protected evaluation storage and worker credentials. Full-host agent access does not satisfy this requirement. Keep the fixed-recipe path available when generated-code isolation is unsupported, and report the unavailable advanced capability. Prediction workers receive evaluation inputs without labels; a separate trusted scoring step joins predictions with labels and writes the evaluation receipt.

For the first tabular experiment, include a simple constant/majority baseline appropriate to the task. Later cycles compare with the selected incumbent on the same current evaluation data. For first-time LLM tuning, the base model is the baseline. An absent or unloadable baseline is an evaluation blocker rather than an assumed improvement.

Use validation results for iteration. Run final test evaluation for the chosen candidate at the end of a cycle; do not feed final-test errors back to the agent as another tuning signal. Repeated continuous releases can also overfit a fixed test set, so define holdout refresh/rotation and label-maturity rules in the recurring workflow policy.

Selection requires all of the following:

- Candidate artifact and evaluation hashes match the exact proposed version.
- Primary improvement and required regression/slice checks pass.
- Latency, model size and inference-resource requirements pass when specified.
- Required evaluation data is present and sufficiently representative; missing evidence yields **Needs evaluation**.
- The expected current selected-model revision still matches. Concurrent selection changes require a fresh comparison.

Store each selection as an immutable event. **Select model** changes a project reference; **Deploy model** invokes a separately configured serving operation. Keep the prior artifact and its evidence so the user can revert the reference. The first release makes no claim of automatically rolling back an external serving system.

## 13 Budgets and recurring automation

Enforce resource and trial limits in the service and worker, independent of agent instructions. Reserve enough allocation for evaluation before admitting a training job. Count preprocessing, retries, numerical search, training and evaluation; report agent usage separately.

Proposed starting defaults, to be adjusted after the execution pilot:

| Setting | Default |
| --- | --- |
| Training computer | Resolved saved default; cloud disabled |
| Concurrent cycles | One per ML workflow |
| GPU concurrency | One active job per selected device |
| Quick baseline | One training experiment plus its required evaluation |
| Improve within a budget | At most three candidate experiments |
| Recoverable retry allowance | One extra training attempt across the cycle, within the same time allowance |
| Agent allocation | At most 12 invocations and 30 active agent minutes per cycle |
| Compute allocation | At most four cumulative active job hours across preparation, training and evaluation |
| Single job deadline | At most two hours, with shorter recipe-specific limits where appropriate |
| Cycle expiry | 24 elapsed hours including waits; expiry stops new admissions and cancels active work |
| Recurring cadence | Off until saved; weekly is the initial suggestion |
| Rolling allowance | Two cycles and eight cumulative active job hours per seven days |
| Model selection | Notify for review; automatic selection is a saved policy option |

Allocation is a ceiling, not a promise to exhaust it. Users can choose smaller limits or save explicit larger limits. If a selected model cannot fit the allowance, offer a smaller model/recipe or explain the required change before submission. Reopening the UI, reconnecting, internally retrying or replaying the journal never resets allocation. Unresolved jobs retain their reservations; actual measured consumption replaces estimates only after reconciliation.

For owned compute, report wall time, device time, peak memory and storage use. An optional owner-supplied hourly rate can provide a labelled estimate. Do not fabricate monetary cost from hardware names. Future cloud adapters add current pricing, currency, startup/billing rules, estimated reservations, provider timeouts and cancellation. Show whether a monetary limit is provider-enforced or a conservative estimate; delayed billing prevents promising an exact universal dollar ceiling.

### Managed schedules

Extend `Trigger.target` with an ML-workflow variant and introduce typed dispatch/preview hooks while preserving project-team targets. Automations owns the clock, timezone and missed-run behavior. The ML service owns cycle admission, overlap detection and total allocation across all child jobs/runs.

Integrate policy editing into the existing project Automation view and show managed ML schedules in the current computer's global Scheduling view. Scope links and actions to the owning computer/project. Do not create a second trigger when the same policy is opened from ML's **Keep improving** shortcut. A background child run must require explicit project/repository membership even though ordinary triggered runs can use lenient project placement; deleting its project must stop new ML admission rather than reassign the workflow.

Use a stable occurrence ID for scheduled/manual events and a source-version/event ID for dataset changes. Repeated delivery resolves to the same cycle. A manual start and a scheduled start contend for the same active-cycle slot. Coalesce pending source updates into a bounded latest-version notification rather than building an unbounded training backlog.

Initial triggers are a saved schedule, **Run now**, and an explicit versioned dataset-ready event. Add filesystem watching and external data connectors only after their snapshot-completion semantics are defined. A file being copied is not a dataset-ready event.

Before training, compare the input manifest with the last completed cycle. Identical data, recipe, objective and evaluation policy produce a no-op unless an explicit exploration policy or manual rerun requests another experiment. Require minimum usable new examples and label maturity. Distribution drift can trigger investigation; it cannot by itself prove a candidate is better.

The backend hosting the ML workflow must be running to start new cycles. An always-on SSH project host can own the schedule when unattended operation is needed while a laptop is off. A training worker alone continues admitted jobs but does not silently become a second workflow scheduler. Migrating schedule ownership must disable the old owner and reconcile active cycles before enabling the new one.

Notifications reuse the existing delivery service and deduplicate by cycle/outcome revision. Stay quiet for unchanged inputs and routine progress. Notify for a meaningful completed comparison, a failure, an exhausted allocation or a decision that needs the user.

## 14 APIs and UI integration

Proposed route families:

| API | Purpose |
| --- | --- |
| `GET /api/ml/capabilities` | Feature availability, supported recipes and eligible agent providers |
| `GET/POST /api/ml/targets` | List or register owner-managed targets |
| `POST /api/ml/targets/:id/probe` | Validate host/worker/environment capabilities |
| `POST /api/ml/targets/:id/setup` | Execute the specific prepared worker/environment setup plan |
| `GET/POST /api/ml/workflows` | List or create project-scoped ML workflows |
| `PATCH /api/ml/workflows/:id` | Revision-checked changes to defaults and saved policy |
| `POST /api/ml/datasets/prepare` | Prepare a snapshot/transfer plan from authorized storage mappings |
| `POST /api/ml/datasets/:id/materialize` | Create or verify the planned snapshot under its operation ID |
| `POST /api/ml/workflows/:id/preview` | Resolve target, inputs, expected resources and blockers without launching training |
| `POST /api/ml/workflows/:id/start` | Admit an immutable cycle with a client operation ID |
| `GET /api/ml/cycles/:id` | Cycle status, child runs/jobs, results and remaining allocation |
| `GET /api/ml/jobs/:id/logs` | Bounded, cursor-based log access |
| `POST /api/ml/jobs/:id/inspect` | Reconcile the exact existing receipt |
| `POST /api/ml/jobs/:id/cancel` | Request cancellation without falsely confirming termination |
| `POST /api/ml/cycles/:id/stop` | Stop cycle progression and cancel active jobs |
| `POST /api/ml/cycles/:id/resume` | Reconcile and resume eligible analysis within the original remaining allocation |
| `POST /api/ml/experiments/:id/retry` | Create a budgeted new attempt after confirmed failure |
| `POST /api/ml/models/:id/select` | Compare-and-swap the selected model using pinned evaluation evidence |
| `POST /api/ml/models/:id/export` | Produce an export manifest/package within permitted storage |
| `POST /api/ml/workflows/:id/automation` | Save/enable/pause a managed schedule under a versioned policy |

All mutation schemas reject unknown fields and enforce project membership, target ownership, current filesystem policy, expected revisions and operation identity. Return `202` with durable IDs for asynchronous work, `409` for stale/conflicting operations and explicit preparation blockers. Scope every log, artifact and stream read just as strictly as submission.

Keep target enrollment, credentials and setup owner-only. Initial ML child runs inherit owner-only ML visibility; ordinary run-list projections must not accidentally expose private data or remote storage paths through repository membership. Extend shared-account behavior only with dedicated tests. Recheck permissions when a queued job becomes ready, not only when the form was saved.

Add `ml` to the typed project sections and route parser, with validated workflow/experiment/model subroutes. Preserve the owning computer's URL prefix through `workspaceUrl` and the existing `apiPath` request scoping. Extend project feature discovery with a bounded ML-summary request so the tab becomes visible when configured. Server projections enforce ownership independently of whether the tab is visible.

Use an ML-specific outcome projection with separate process, evaluation and selection states. Align its presentation with `run-status.ts`, but do not pass model quality through Git-check helpers. In project Overview, history, Inbox and notifications, group child activity under the ML cycle and avoid counting a successful planning turn as a successful trained model. Reuse bounded summaries, pagination and stream reconciliation rather than loading training logs into the global run index. Include explicit fixtures for training finished/evaluation pending, evaluated/no improvement, and unknown remote outcome.

Add stream topics such as `ml:<workflowId>` and `ml-job:<jobId>` to the current broker. On reconnect, fetch a current authoritative snapshot plus bounded missed updates. The UI displays a clear unknown state when a remote outcome cannot be confirmed. Server restarts invalidate transient stream cursors without invalidating job identities.

## 15 Proposed code organization

Keep the new domain in a bounded module tree; extract shared helpers only when two implementations actually need them.

```text
src/ml/
  model.ts                 Versioned records, limits and strict validators
  store.ts                 Durable journal, admission batches and projections
  service.ts               Cycle orchestration and state transitions
  policy.ts                Scope, budgets, proposal and selection checks
  targets.ts               Target registration, defaults and capabilities
  jobs.ts                  Submission, reconciliation and cancellation
  datasets.ts              Snapshot and transfer manifests
  artifacts.ts             Candidate/checkpoint/export references
  evaluation.ts            Fixed contracts, comparisons and acceptance
  recipes.ts               Versioned recipe metadata and compatibility
  agents.ts                Managed child admission, routing and permission integration
  automation.ts            Managed trigger adapter and no-op detection
  api.ts                   HTTP routes and public projections
  tools.ts                 Scoped agent-facing ML tools
  adapters/local.ts        Local supervisor control
  adapters/ssh.ts          Remote supervisor control and transfers
src/training-worker/
  main.ts                  Worker/control entry points
  protocol.ts              Versioned request/response contracts
  supervisor.ts            Resource ledger and process/container ownership
  store.ts                 Worker receipts and recovery
  execution.ts             Enforced deadlines, logs and cancellation
training/recipes/
  tabular-autogluon/        Python implementation and locked environment
  llm-sft-lora/             Python implementation and locked environment
  evaluation/              Independent scoring implementations
ui/ml/
  workspace.tsx            Project overview and model actions
  setup.tsx                Guided task/data/model/target setup
  targets.tsx              Training computers and capability display
  experiment.tsx           Timeline, metrics and comparisons
  automation.tsx           Saved recurring policy
  state.ts                 Typed API and shared stream integration
scripts/build-training-worker.mjs
```

Integrate narrowly with `src/server.ts`, `src/automation.ts`, `src/engine.ts`, `src/provider-eligibility.ts`, `src/model-catalog.ts`, `src/run-permissions.ts`, `src/run-environment.ts`, and the shared-access/retention modules. Reuse `src/team-template-store.ts` only for optional agent strategies. Add minimal ML provenance to child agent runs so admission, cleanup, inbox and notifications can identify them without embedding large ML records in every run snapshot.

UI integration includes `ui/navigation.ts`, `ui/project.tsx`, `ui/project-features.ts`, `ui/project-context.ts`, `ui/automations.tsx`, `ui/scheduling.tsx`, connections settings and the existing stream. Keep ML status projections separate from agent-run status while sharing presentation conventions. Avoid a broad engine refactor to support the first recipe.

The worker bundle uses the existing Node runtime baseline. Python and accelerator dependencies live on the training target. The application backend and documentation build must continue working without Python, Docker, a GPU or any cloud account.

## 16 Implementation phases and acceptance gates

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| P0 Contracts and admission | Feature flag, target/workflow/job schemas, computer/project scope, store, operation deduplication, resource/budget admission, internal child-run provenance and fake worker | Failed writes, duplicate operations and ordinary run continuation APIs cannot bypass ML admission; existing application remains usable with ML disabled |
| P1 Local vertical slice | Persistent local supervisor, one tabular recipe, immutable file snapshot, separate evaluator, project-scoped setup/drafts/status/export UI | A real CPU dataset completes without an agent requirement; app restart reconnects to the same job; cancellation terminates descendants; project switching preserves the correct draft |
| P2 Own server execution | SSH enrollment/setup, pinned worker identity, worker-local datasets, explicit resumable transfers and project target default | Real SSH disconnection/reconnection retains one job; transferred data hashes match; changing defaults cannot redirect queued/running jobs |
| P3 Experiment and model workspace | Full comparison UI, native metrics, model manifests, baseline/selection evidence, artifact retention and prediction preview | A user can compare and use a trained model; no-diff results survive normal run cleanup; private ML evidence stays scoped |
| P4 LLM fine-tuning | TRL/PEFT recipe, supported CUDA matrix, local model inputs, smoke checks, LoRA/validated QLoRA, base/candidate evaluation and adapter export | Real small-model runs succeed on owned local and SSH CUDA targets; adapter reload reproduces evaluation within declared tolerance; no cloud training account is needed |
| P5 Agent improvement and recurrence | Typed proposals, catalog-backed assignments, inherited permissions, bounded repairs, optional strategy reuse, managed triggers in existing Automation UI, rolling limits and notifications | Auto cycles respect saved policy; provider replacement, resume, duplicate triggers and controller restart cannot broaden authority, duplicate jobs or reset budgets |
| P6 Release validation | Capability-specific real pilots, failure recovery matrix, documentation, onboarding fixes, packaging and opt-in rollout | Published evidence distinguishes tested hardware/recipes from unsupported combinations; usability and operational gates below pass |
| P7 Optional extensions | Apple GPU/MLX recipe, additional trainers, MLflow export, cloud adapters, Slurm/distributed execution, advanced tuning and serving adapters | Each extension has independent compatibility, budget, cancellation and evaluation tests before enablement |

P0–P6 define the initial feature. P1 is the first demonstrable slice. P2 is required before presenting the feature as supporting user-owned servers, and P4/P5 are required before presenting it as automated fine-tuning. Cloud integration does not block these releases. Prioritize the Apple GPU recipe within P7 if the initial user cohort primarily has Macs without separate GPU servers.

Dependencies are P0 → P1 → P2/P3 → P4 → P5 → P6. P2 and P3 can be implemented independently once P1's contracts are stable. Keep each phase reviewable as focused changes; refactor existing automation dispatch separately from adding ML policy behavior so project-team regressions are easy to isolate.

### Initial delivery backlog

| Work package | Completion condition |
| --- | --- |
| ML record schemas and default resolution | Computer/project/repository scope is explicit; unavailable targets never fall back; stale drafts cannot launch elsewhere |
| Journal and admission ledger | Atomic reservation plus intent; deterministic recovery and operation deduplication |
| Worker packaging and lifecycle | Local/SSH supervisor installation, compatible version handshake and documented stop/recovery |
| Resource scheduling | Worker-owned GPU/CPU reservations, fair waiting and separate agent/training slots |
| Dataset/model staging | Immutable manifests, resumable transfer, verified cache and bounded disk behavior |
| Tabular recipe and evaluator | Baseline, fit, comparison, prediction and export on real CPU fixtures |
| Training-computer setup | Saved project default, understandable diagnostics and one-time managed environment setup |
| Experiment/model UI | Accessible timeline, quality evidence, unknown state, cancellation and export |
| LLM recipe and evaluator | Supported model/hardware preflight, real training, independent scoring and adapter reload |
| Agent tools and workflow | Typed proposals, pinned catalog/template evidence, inherited permission receipts, bounded changes/repairs and service-owned continuation |
| Recurring workflow | Stable occurrences, overlap prevention, unchanged-input no-op and rolling reservations |
| Operations and rollout | Restore, retention, disk pressure, release evidence and user-facing guides |

## 17 Verification and pilot

Use fake workers and tiny fixtures for deterministic mechanics. Real hardware/provider runs establish training compatibility and useful results separately. Do not claim model improvement from fake-agent outputs.

| Area | Required evidence |
| --- | --- |
| Persistence | Faults before/after admission write, worker acceptance, process start, final receipt and projection update |
| Identity | Duplicate operation, changed intent, two target aliases, stale configuration, changed host key and restored backup |
| Recovery | Browser close, SSH drop, controller kill/restart, worker crash, host reboot, lost output and ambiguous cancellation |
| Resource limits | Concurrent admissions, GPU contention, deadline, disk exhaustion, failed checkpoint and retry accounting |
| Data | Mutable source detection, transfer corruption/interruption, path/symlink/archive escapes, split leakage and repeated conversation/group rows |
| Evaluation | Missing/nonfinite metrics, wrong metric direction, stale baseline, changed evaluator, candidate/hash mismatch and train-code attempts to alter test evidence |
| Access | Cross-project IDs, shared projections, logs/artifacts/streams, revoked access and expired agent capabilities |
| Agent integration | Catalog changes, unavailable pinned models, stale/offline discovery, replacement permission intersection, inherited environments, file-only structured proposals and template edits during a cycle |
| Continuations | Ordinary child Resume/rerun/follow-up cannot bypass ML admission; allocation persists; changed inputs invalidate evidence; no-agent recipes ignore unrelated provider failures |
| User experience | CPU-only setup, SSH default selection, unsupported GPU diagnosis, computer/project switching, late-response rejection, removed repository, draft-save failure, resume, cancellation pending and export |
| Status projections | Training completion is distinct from evaluated improvement; child turns do not inflate model success; bounded history and private evidence remain correctly scoped |
| Automation | Timezone/missed occurrence behavior, duplicate delivery, manual/scheduled race, source no-op, rolling limits and notification deduplication |
| Model usability | Exported predictor or adapter loads in a fresh compatible environment and produces expected outputs |

The pilot uses a small classification dataset, a regression dataset, and an open small language model with a local instruction dataset. Run tabular jobs locally and over real SSH. Run fine-tuning on at least one supported local NVIDIA environment and one SSH NVIDIA server. Include one complete cycle with genuine agent proposals and one scheduled retraining cycle with new data.

Measure time to first usable model, setup failures, manual interventions, completion rate, quality relative to the fixed baseline, resource use, repeated-seed variability and successful recovery/cancellation. Review both improved and unimproved results: reporting that a baseline remains best is a valid outcome.

Release gates:

1. No unresolved duplicate-launch, scope, evaluation-tampering or termination defects in the required failure tests.
2. Both initial training journeys complete on their advertised compute matrix and export reloadable artifacts.
3. Real SSH and controller-restart tests preserve the original job and resource accounting.
4. The default user journey needs a goal, dataset, compatible target and budget; low-level parameters remain optional.
5. Automatic cycles respect the saved limits and can produce an evidence-backed no-op or keep-baseline result.
6. Every advertised capability has recorded evidence, environment versions and known operating limits.

For implementation changes, run `npm run typecheck`, relevant unit/workflow tests and relevant browser acceptance tests. Package the worker and exercise a real isolated CPU/SSH smoke test before enabling remote execution. GPU tests run in explicitly configured hardware CI or the pilot; they are not replaced by passing unit tests.

For documentation changes, run `npm run build:docs` and `npm run test:docs` as required by the repository's [documentation guide](documentation.md).

## 18 Operations and lifecycle

Keep current selected models, active candidates, live checkpoints, unresolved job receipts and their required datasets protected from automatic retention. Exports and user-owned source data have explicit ownership; cleaning a run must never delete external source folders or a shared model cache by inference.

Expose storage use and a retention preview. Delete only enumerated managed artifacts whose references and fingerprints still match the preview. Preserve enough metadata to explain a removed artifact's origin. Stop admissions on disk-pressure thresholds before training exhausts the volume; do not silently delete checkpoints needed for recovery.

Backups include workflow policy, metadata, selection history and artifact manifests. Large datasets/weights can be excluded with a visible list of references needed for restore. Worker-control secrets and cloud credentials are not portable backup authority. Restores require reconciliation before activating schedules.

Disabling the feature stops new ML work but leaves inspection and cancellation for existing jobs available. Updating the app must not replace a busy worker with an incompatible protocol. Keep active jobs pinned to their worker/recipe versions; upgrade idle targets or install a compatible version alongside the old one.

A worker status page should show enrolled controller, active/unknown jobs, resource reservations, free disk, environment versions and last successful contact. Error messages should give the next useful action: fix SSH access, complete model access, choose a supported recipe, free managed storage, inspect an unknown job or increase a deliberately chosen budget.

## 19 Research informing the design

| Source | Design implication |
| --- | --- |
| [Hugging Face agent skills](https://huggingface.co/docs/hub/agents-skills) and [training example](https://huggingface.co/blog/hf-skills-training) | Existing coding agents can prepare training configurations and control jobs. Use this as a workflow reference while retaining owned-compute execution. |
| [AutoGluon](https://github.com/autogluon/autogluon) and [MLZero](https://github.com/autogluon/autogluon-assistant) | Use established AutoML recipes for the first predictive path. MLZero offers additional research strategies and interfaces; its research-only status makes it an optional experiment rather than a required runtime. |
| [TRL SFT](https://huggingface.co/docs/trl/sft_trainer) | A configurable supervised fine-tuning recipe can use an existing trainer and PEFT integration. |
| [Unsloth Studio](https://unsloth.ai/docs/new/studio) | Local training and export can have an approachable UI; add optimized recipes only after compatibility validation. |
| [FT-Agent implementation](https://github.com/microsoft/RD-Agent/blob/main/rdagent/app/finetune/llm/README.md) | Adopt preflight validation and feedback-driven changes to data/training, with validation separated from final tests. |
| [AIDE](https://github.com/WecoAI/aideml), [autoresearch](https://github.com/karpathy/autoresearch) and [MLE-STAR](https://research.google/blog/mle-star-a-state-of-the-art-machine-learning-engineering-agents/) | Bounded code experiments, solution-tree exploration and targeted component refinement can improve the advanced workflow. Their experimental setups do not establish production reliability for arbitrary user tasks. |
| [Optuna](https://optuna.readthedocs.io/en/stable/tutorial/10_key_features/003_efficient_optimization_algorithms.html) | Numerical search and early stopping can operate inside bounded experiments without requiring an LLM decision for every parameter value. |
| [Evidently reference dataset guidance](https://learn.evidentlyai.com/ml-observability-course/module-4-designing-effective-ml-monitoring/how-to-choose-reference-dataset-ml-monitoring) and [SciPy Jensen–Shannon distance](https://scipy.github.io/devdocs/reference/generated/scipy.spatial.distance.jensenshannon.html) | Require a representative reviewed reference, distinguish distribution shift from quality loss, and compare normalized histogram counts with bounded base-2 distance. |
| [MLflow tracking](https://www.mlflow.org/docs/latest/tracking/) and [registry](https://www.mlflow.org/docs/latest/registry/) | Offer integration for teams already using an experiment/registry service; keep it optional for the first local run. |
| [Hugging Face Jobs billing](https://huggingface.co/docs/hub/jobs-pricing) | A future cloud adapter needs explicit credentials, compute-credit/cost handling and provider controls. Local execution must remain independent of this account requirement. |
| [AutoTrain maintenance notice](https://huggingface.co/docs/autotrain/main/index) | Exclude AutoTrain from the new foundation because its current documentation says it is no longer maintained. |

## 20 First implementation milestone

Deliver one complete, restart-safe local tabular workflow before expanding the trainer catalog: select a dataset and target column, validate and snapshot it, train through the persistent worker, score with the fixed evaluator, display the comparison and export a usable predictor. Use the same contracts to add a configured SSH server next.

The milestone is complete when the result remains inspectable after a backend restart, a cancelled job has no remaining owned children, repeated start requests resolve to one attempt, and the exported predictor loads outside the training process. This establishes the execution foundation needed for automated fine-tuning and continuous improvement.

[Documentation library](README.md) · [Architecture](architecture.md) · [SSH projects](ssh-projects.md) · [Automations](automations.md)
