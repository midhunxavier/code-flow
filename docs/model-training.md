# Train a model on your computer or server

The ML preview offers tabular prediction with AutoGluon and language-model fine-tuning with TRL and PEFT LoRA. Both use immutable inputs, durable jobs, held-out evaluation, and verified exports on your own computer or standalone SSH server.

Training runs on your own computer by default. You can add a standalone server through SSH and make it the default for a project. No cloud training account or agent subscription is needed. Fine-tuning reads model weights already available on the selected computer; obtaining gated weights may separately require the model provider’s token and license acceptance. Installing Python packages requires access to PyPI. Cloud providers are optional future integrations; there is no cloud fallback.

## Enable the preview

Open **Settings → General → Model training** and select **Enable model training**. This feature is off by default. The saved choice applies to all projects on the current workspace’s computer and survives restarts. Enabling does not install packages or launch training. Use a Linux or macOS backend with Node.js 22.13 or newer and Python 3.12 available for training.

Open a project, then its **ML** tab (also available under **More → ML**). New projects show ML only while the feature is enabled. Projects with existing ML data keep the tab for history and recovery when disabled. Select **Training recipe** to choose tabular prediction or LoRA fine-tuning. Tabular training uses CPU. Fine-tuning supports explicit CPU, Apple GPU (MPS), or single NVIDIA GPU (CUDA) selection. Bounded automatic experiments are available for both recipes. Scheduled retraining checks for new data with the same search limits. Deployment monitors can trigger those bounded searches on persistent drift or roll back repeated inference failures to an approved version. Promotion policies can compare models trained on new data using a frozen common holdout, with approval controls and rollback. Cloud adapters remain a later milestone.

“This computer” is the computer running the project's Code Flow backend. For a project opened through an SSH connection, it is that remote computer. A second SSH training server is resolved from that backend's SSH configuration.

## Automatically compare and improve models

After preparing the computer, dataset and (for LoRA) base model, use **Improve within limits** below the training settings. Select an experiment planner, maximum iterations, total training minutes, elapsed minutes, early-stop patience and minimum metric improvement. The per-trial training cap comes from the training settings above. Start the search and leave the Code Flow backend running to dispatch later trials; the browser can close.

- **Built-in search** works fully offline. It tries bounded forest sizes/depths for tabular models, or learning rates/ranks around the best LoRA validation result. It uses fixed recipes and does not write training code.
- **Claude CLI** proposes bounded hyperparameters using your existing login on the Code Flow host. This is optional and uses your Claude subscription/API allowance. The supplied objective, hyperparameters and aggregate validation scores go to Claude; dataset examples, paths, worker logs and test metrics are excluded. Keep sensitive data out of the objective. Use a full model ID when you need a fixed planner version; aliases such as `sonnet` may change upstream.

The optional Claude planner requires a CLI supporting `--safe-mode`, `--restricted`, disabled tools/MCP, structured output and no session persistence. Each turn runs in an empty private directory, lasts at most two minutes and has no file/shell tools. Unsupported controls, authentication failures, repeated configurations and malformed proposals pause the search. There is no automatic provider/model fallback. These controls follow the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference); they are CLI restrictions, not an OS sandbox. Other agent providers and arbitrary recipe edits are future work.

Every iteration uses the same immutable data, split seed, recipe bundle, compute target and base model. LoRA trials start from the original base weights; the planner may change learning rate, rank, accumulation and step count up to the user's original step cap. Sequence length and device remain fixed. Tabular trials may change tree count and depth. All proposals are validated before launch.

The search compares **validation** scores against the baseline and current winner. The minimum improvement is an absolute metric difference (for example, `0.01` accuracy means one percentage point); ties keep the earlier winner. Patience stops after the configured number of unsuccessful iterations. When search ends with a validation winner, a separate job copies its checksum-verified model, regenerates the same split and evaluates the test partition once, without fitting again. Its export is available for review even if the final comparison recommends keeping the baseline. No winner means no final model export. Reusing the same data across manually started searches can still overfit the test set; use fresh evaluation data for independent confirmation.

Budgets survive restarts and SSH disconnects. An iteration is consumed before planning; its full training allowance is reserved atomically before worker dispatch. Failed, cancelled or unresolved trials never refund training reservations. Up to eight iterations, eight total training hours and 24 elapsed hours are supported. The worker enforces the per-trial training-process deadline, including model loading/saving in that process, with a short termination grace period. Recipes leave headroom to save before that deadline. Preparation, planning, evaluation, export and time while the controller is closed count toward the overall elapsed limit. Some elapsed time is reserved for final evaluation, so fewer trials may fit than requested.

**Stop search** persists cancellation and remains pending until owned work terminates. Unknown worker outcomes block new jobs. **Resume with remaining budget** requires reconciliation and keeps the original deadline and all consumed iterations/reservations. A controller restart during planning consumes that iteration and pauses; it does not repeat the agent call. An interrupted final test is not retried automatically. Disabling ML pauses new planning/dispatch, while inspection and cancellation remain available. Searches reserve their project/computer even between trials; finish or stop them before changing worker settings.

One search runs at a time per project/computer. This preview has bounded local history (100 searches and 200 total jobs); automatic cleanup remains future work. On-demand deployment and inference are described below. The model registry below keeps reviewed final results and their selection history.

## Retrain when new data arrives

Prepare the current dataset and choose your training or LoRA settings, planner, iteration count, training budget and elapsed limit. In **Retrain when data changes**, save an interval (5 minutes to one week), daily time, or weekday time. Calendar schedules use an explicit IANA time zone and the same daylight-saving handling as Code Flow automations: repeated local times run once and missing local times shift forward. The schedule stores the selected local/SSH computer, Python/worker version, recipe, split, base model and resource limits. Later edits to the form or project default do not change a saved policy.

The prepared file is the starting version; saving a schedule does not train it again. Checks hash the full source content, so merely touching a file or replacing it with identical bytes starts no work. For a dataset on an SSH server, hashing happens there; unchanged data is not downloaded. A file on the Code Flow host can instead be uploaded to the selected SSH worker only when it changes.

New content must have the same hash on two observations at least one stability window apart (1–60 minutes). The second check can happen before the next regular calendar time. Code Flow then prepares an immutable snapshot and verifies that it still matches the observed content. Changed columns, JSONL schema, inaccessible data, unavailable compute or changed worker settings pause the policy for review. Publish complete files, preferably by atomic replacement. The existing dataset size and row limits apply to every version.

Each admitted version starts one normal bounded search. Every search keeps its own saved iteration, training-time, elapsed-time and patience limits; failed attempts retain reservations. **Maximum scheduled runs** (1–100, default 10) also caps lifetime work: at most `maximum runs × training budget per search` training seconds can be reserved. Exhausted policies cannot be resumed to reset this count. A version already admitted, including a failed or stopped search, is not automatically retried. Returning to the starting version is also a no-op.

The Code Flow backend must be running for data checks and additional trials. An admitted worker job continues under its original deadline if the backend closes. Restart coalesces missed checks into one check of current data, resets unfinished stability observations and preserves admitted versions, reservations and run counts. An active or unresolved job/search defers the next data check; updates are coalesced rather than queued as a training backlog. A paused search needs attention in **Improve within limits**.

Use **Check data now** to bring the next check forward; it still observes stability and resource limits. **Pause future runs** leaves the current search running. **Pause and stop current search** also requests cancellation of that search's work; SSH cancellation can remain pending until reconnection. **Resume schedule** retains its history and cap. Pause policies before changing Python, upgrading a worker or tightening filesystem policy; changed compute settings require a new reviewed schedule.

The schedule list shows next/last checks, errors, consumed runs and links to each search. Each version is evaluated against its own fixed baseline and split; scores from different dataset versions are not directly comparable. LoRA runs always begin from the saved base-model snapshot, not the previous adapter. A separately authorized promotion policy can evaluate both exports on a common holdout before promoting a model trained on changed data. Original test scores from different data versions remain incomparable. This preview supports 32 saved schedules and retains the existing bounded experiment/dataset history; reaching those storage caps pauses admission. Rolling daily budgets, webhook ingestion, schedule editing and unified Automation-page controls remain future work.

## Compare, promote and roll back model versions

In **Model registry**, choose **Register a trained model version** after a successful training job or a search’s final test. Create a named model, or add the result to an existing compatible model. Registration retains a checksummed export on the Code Flow host and assigns a permanent version number. Validation trials and prepared base-model snapshots cannot be registered. Manual, automatic and scheduled final results use the same process; registration and promotion are explicit actions unless delegated to a saved promotion policy.

A named model belongs to one project and repository. Tabular versions share the recipe, task, label and feature columns; LoRA versions share the recipe and exact frozen base-model hash. Versions may come from different local or SSH computers. Each version pins the original dataset, split, training configuration, source commit, worker bundle, compute target, evaluation and artifact hashes. Inspect these under **Version provenance and recovery** or **View training result**.

Choose **Compare against version** to see the scores side by side. Rankings include only versions with matching dataset, split/seed, evaluator bundle, recipe, metric, baseline and evaluation population. LoRA comparisons also require matching base weights, sequence length and evaluated token count. Different data versions remain visible with an explanation; a higher accuracy or lower loss on different data does not establish improvement. Use a common holdout promotion policy below to re-evaluate both exports on independent data; the registry’s original-evaluation comparison remains unchanged.

Enter a reason and use **Promote v…** to select a version. A candidate that does not exceed its baseline or comparable incumbent by the required margin needs an explicit review acknowledgement, as does an incomparable candidate. For search results, the saved search’s minimum-improvement margin applies. The acknowledgement and comparison concerns remain in the history. Promotion uses the current registry revision, so another browser’s change cannot be silently overwritten.

To undo a selection, choose a previously selected version, enter a reason and use **Roll back to v…**. This updates the selected version and records another history event without retraining or resetting any search/schedule budget. **Download selected v…** returns that version’s retained export. Manual registry selection does not change a deployment. Use the separate deployment controls below to change what an endpoint serves.

Local archives let promotion, rollback and downloads work while an SSH training computer is offline. Missing or changed archives block those actions. **Restore archive from training computer** retrieves the exact original export, checks its hash and leaves the version and selection unchanged; the original worker must be reachable and retain its artifact. A LoRA export includes the adapter, not its base weights: preserve the exact base model separately for inference.

The preview retains up to 32 named models, 200 total versions (within the existing 200-job limit), 200 selection events per model and 2 GiB of registered exports. Each export is limited to 512 MiB. Automatic pruning, model deletion and registry synchronization to MLflow are future work. Back up `CODEFLOW_HOME/ml/state.json` together with `CODEFLOW_HOME/ml/exports/` and the worker’s data. Registry records are validated against their immutable training receipts on restart. Disabling the ML preview prevents new registrations and promotions; existing registry reads, downloads, restoration and rollback remain available to the authorized owner.

## Deploy and use a trained model

Under **Deploy and use a model**, choose a registered version, a deployment name and an inference computer. Use **Check inference computer**; an older worker needs **Update training worker** in the training controls before its first deployment. Prepare the matching recipe environment on that computer. The registry’s retained export is transferred automatically, so a tabular model can be deployed on a different computer from the one that trained it. For LoRA, first prepare the exact same frozen base weights on the destination computer; base weights are not included in the transferred adapter.

Choose CPU for tabular inference, or CPU/MPS/an explicit NVIDIA GPU for LoRA. Set CPU threads, a 5–90 second request timeout, and either a batch cap of 1–100 rows or input/output token caps (up to 4,096 input and 512 generated tokens, within the base model’s context). In on-demand mode, loading, integrity checks and execution share the timeout. Persistent mode has a separate load deadline and request deadline, each using this value; a cold request can therefore take roughly twice the configured timeout. Termination has a short grace period. Limits are fixed for that deployment. To use different compute or limits, create another deployment.

Enter a reason and click **Create deployment**. Code Flow verifies the export and dependency lock, checks the model’s identity and loads it before enabling the endpoint. LoRA also performs a device forward pass. A result below its baseline needs an explicit review acknowledgement. Creating a deployment does not change registry promotion or training/schedule budgets.

Choose **Persistent · keep the model loaded** (the default for new deployments) to reuse one loaded predictor or base model plus adapter across requests. The detached worker survives Code Flow restarts and SSH disconnects; reopening the app reconnects to its existing session. **On demand · load for each request** remains available, and existing deployments keep that behavior.

Persistent deployments require three additional limits:

| Setting | Range and behavior |
| --- | --- |
| Serving memory | 256–262,144 MiB; the supervisor samples combined process-group RSS every 500 ms and terminates the group when it exceeds the limit. CUDA/MPS PyTorch allocator limits use the same budget. |
| Idle timeout | 10–3,600 seconds without a running or completed request; unloads the model. Status polling does not keep it warm. |
| Maximum lifetime | 30–86,400 seconds from process startup, including loading; unloads the model even during generation. Idle timeout cannot exceed this limit. |

These controls bound a serving session, not cumulative usage or cost. They are not an OS memory sandbox: brief memory overshoot is possible, CPU settings limit library threads, and accelerator caps apply to PyTorch allocations. An expired model stays unloaded until **Warm selected model** or the next request starts a new session. Warm status displays readiness and sampled memory; a cold load can fail if the timeout or memory limit is too small.

There is one resident model and one request at a time per worker. An enabled persistent deployment reserves that worker even after its idle or lifetime expiry. **Stop deployment** before training, changing Python settings, upgrading the worker, or starting a different deployment on that computer. A training search retains its reservation between trials. Busy requests are rejected; this preview has no request queue, batching across clients or autoscaling.

Use **Run prediction** or **Generate response** to try the endpoint in the UI. For tabular models, supply a JSON `rows` array containing exactly the feature columns shown. For LoRA, send a `prompt` or `messages` ending with a user message, plus an optional `maxNewTokens` within the saved cap. Generation is deterministic (no sampling). The payload is limited to 64 KiB; results are bounded to 256 KiB. The serving runtime passes inputs through private pipes and does not persist input rows, prompts or generated output.

The endpoint appears as `POST /api/ml/deployments/<id>/predict`. It uses the existing Code Flow **owner** authentication and is unavailable to shared accounts, runners or phone listeners. For an application backend using the owner token:

```sh
curl --fail-with-body "$CODEFLOW_URL/api/ml/deployments/$DEPLOYMENT_ID/predict" \
  -H "Authorization: Bearer $CODEFLOW_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"rows":[{"feature_name":12}]}'
```

Keep owner credentials on your application backend. Deployment-specific credentials and public serving endpoints are not implemented. The Code Flow backend must remain available for API calls; an SSH worker opens no public inference port and needs no cloud account. Each response identifies the exact deployment revision, registry version, release and worker used. A timeout or lost connection does not automatically retry the request. A detached supervisor enforces deadlines independently of the controller. Persistent requests are cancelled when the HTTP client disconnects; if the controller disappears, the worker releases an unfinished generation after 15 seconds without polling, or sooner at its request deadline. Cancellation unloads the resident model to confirm termination of the entire process group. The next request may warm it again. On-demand requests retain their original deadline after a disconnect.

Under **Switch version, roll back or stop**, choose a version and enter a reason. **Deploy v…** loads and verifies that candidate before atomically changing the endpoint; a failed preparation leaves the previous selection unchanged. Incomparable evaluations, tied scores or regressions require explicit review. **Roll deployment back to v…** selects a previously deployed version after the same loading checks. Stale requests cannot overwrite a newer deployment change. Manual registry selection remains independent.

**Stop deployment** saves a durable stop revision and prevents new dispatches. In persistent mode it also cancels active inference and releases the resident process group. **Cleanup pending** means delivery or process termination is still unconfirmed; the controller retries after reconnection/restart and keeps training blocked until cleanup is confirmed. A delayed older stop cannot terminate a later resumed revision. In on-demand mode, an already dispatched request finishes within its original limits.

**Resume deployment** verifies and loads the same release again. Persistent switching requires the current request to finish first, then unloads the old model and loads the candidate without doubling residency. The endpoint changes only after loading succeeds. If loading fails, Code Flow attempts to restore the previous model; if restoration also fails, that version remains selected with an explicit recovery error. Inspect the worker and use **Warm selected model** to retry. This preview does not provide zero-downtime replacement. A missing server or changed artifact never triggers local/cloud fallback. Prepared releases retain their worker bundle and Python settings across restarts and later training-worker upgrades.

Controller state retains up to 32 deployments and 200 events per deployment, reserving the final event and storage headroom for stopping requests. Workers retain up to 200 serving archives, with 2 GiB compressed and 4 GiB expanded storage limits; each expanded export is limited to 512 MiB. Back up the controller records and worker directories. Artifact cleanup and deployment deletion are not implemented yet. **Disable model training** in Settings → General blocks deployment creation, switching, resume and inference; stopping deployments remains available. `CODEFLOW_ML_ENABLED` is only a startup default until Settings saves a choice; removing it later does not override that choice. Each worker also retains up to 200 deployment stop fences. Deleting receipts manually can break recovery guarantees. OpenAI-compatible APIs, deployment-specific credentials, public endpoints, automatic failover and cloud adapters remain future work.

### Stream an LLM response

For persistent LLM deployments, **Stream the response as it is generated** is selected by default. The UI shows decoded text as it arrives and a final result containing the exact version and token counts. **Cancel request** aborts the request and releases an active resident generation. Partial text followed by an error is not a completed result.

Use the same owner authentication and input schema with `POST /api/ml/deployments/<id>/stream`:

```sh
curl --no-buffer --fail-with-body "$CODEFLOW_URL/api/ml/deployments/$DEPLOYMENT_ID/stream" \
  -H "Authorization: Bearer $CODEFLOW_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Explain this model briefly.","maxNewTokens":32}'
```

The response is Server-Sent Events over a POST request. Consume it with streaming `fetch` or an HTTP client rather than browser `EventSource`, which uses GET. Events are:

- `meta`: admitted deployment revision, registry version, release and resident session.
- `delta`: incremental decoded `text`; chunks may contain several tokens or words.
- `heartbeat`: progress heartbeat while the worker is generating without new decoded text.
- `done`: the complete prediction envelope, including final text and token counts.
- `error`: generation failed after streaming began; do not treat partial text as success.

Preflight failures return normal HTTP JSON errors. After streaming begins, completion is confirmed only by `done`; a dropped connection or `error` must not be silently retried. Streams have bounded buffers and output, and slow consumers are cancelled. Inputs and generation remain on the chosen local or SSH computer; the private resident socket listens only on that computer and no cloud service is required.

`GET /api/ml/deployments/<id>/runtime` returns resident readiness, session identity, memory and expiry when available. `POST /api/ml/deployments/<id>/warm` with `{}` explicitly loads the selected version. Both routes retain the same owner and project authorization as inference. A lost supervisor with surviving children reports unknown status and keeps the worker reserved; **Stop deployment** checks process identities and reaps the owned process group before allowing reuse.

## Automatically promote evaluated models

Use **Promote evaluated models** below the deployment controls. First select the currently deployed version in the model registry, so the endpoint and registry agree on the incumbent. Choose the deployment, candidate source and one of two approval modes:

- **Approve each qualifying candidate** (default): evaluation produces a pending decision. Review its exact candidate/incumbent scores, enter a reason and click **Approve and deploy**, or reject it. Approval expires after the saved interval and cannot be reused after a version, evidence or policy change.
- **Automatically deploy qualifying candidates**: explicitly authorize the policy once. The controller may deploy only candidates passing its saved evaluation and resource rules. Agent proposals cannot change the policy or approve a blocked comparison.

Sources are completed compatible searches in the same project/repository, final results from one saved schedule, or versions registered in this named model. The default considers future results; **Consider existing evaluated candidates** includes retained results. Only successful final held-out evaluations with verified exports qualify. Validation trials, failed jobs and base snapshots never qualify. Search exports are registered automatically only after their release is authorized. Searches and schedules retain their original compute and training budgets.

A candidate must exceed the baseline and deployed model by more than the larger of the policy’s absolute improvement margin and its search’s saved margin. Higher-is-better and lower-is-better metrics use the corresponding direction; ties and regressions are blocked. **Compare original matching evaluations** retains the strict checks for matching model contracts, datasets, splits, seeds, evaluators, base models, evaluation populations, baseline scores and, for LoRA, token populations and sequence lengths. It considers the largest comparable gain first. For models trained on different data, choose **Evaluate both models on a frozen common holdout**, described below. Neither owner approval nor automatic mode bypasses the selected evaluation method’s quality gates.

Set a finite lifetime deployment-attempt cap (1–20), cooldown (one minute to one week), approval expiry (up to one week), and operational health observation period (up to 24 hours). Attempts are charged before artifact verification/loading, including failed attempts, and are never refunded by pause or restart. Cooldown is measured from the attempt's start. A candidate already considered by a policy is not automatically retried; new review requires a new policy. Retention is bounded to 32 policies and 100 candidate decisions each, also subject to existing controller, registry, deployment and monitoring limits.

Promotion checks the retained incumbent archive for rollback, verifies the candidate archive and loads it using the deployment's existing local/SSH target, device and resource limits. It switches the full endpoint, with a possible interruption in persistent mode. Registry selection, deployment selection, the release decision and a new health guard are saved together. A pause, manual stop/version change, lost access or stale approval during preparation prevents the commit. Failed loading leaves the previous selection intact and persistent serving attempts to reload it. Previous-version monitors pause when the new guard is installed. This is a guarded full deployment, not traffic splitting or a zero-downtime canary.

The observation policy requires minimum traffic and consecutive healthy windows for failure rate and mean end-to-end latency. Repeated unhealthy windows restore the prior deployed version through the health guard. At the observation deadline, insufficient recent healthy traffic, or a disabled/failed health guard, also requests rollback. Configure these thresholds for cold loading, SSH latency and expected request volume. Successful observation marks the release promoted; its health guard remains active for later failures. The promotion controller synchronizes the registry with a health-triggered deployment rollback, including after restart. Later manual changes are preserved and require review.

**Pause promotion** cancels pending approvals and prevents new deployments. An already deployed release retains its observation deadline and rollback protection. **Roll back this promotion** explicitly restores its prior deployed and selected version with an audit reason. Rollback loading is capped at three automatic attempts; failure pauses the policy and leaves an actionable error for worker inspection and manual recovery. New promotions pause when ML is disabled; an already deployed rollout cannot load a rollback while ML is disabled and resumes its checks when enabled. Code Flow must run to make promotion/health decisions; workers continue enforcing their own resource deadlines while it is closed. No cloud provider is required or selected as a fallback.

A monitoring-owned stop/resume for bounded retraining can advance a policy's deployment revision when the serving version and registry selection stay unchanged; it cancels prior approvals and waits for restoration before considering results. Manual version changes require a newly reviewed policy. Health-triggered or owner-requested rollback pauses the policy and retains its attempt ledger, preventing repeated deployment of the same rejected release.

The owner-only API provides `POST /api/ml/promotions` and `POST /api/ml/promotions/:id/{pause,resume,check,approve,reject,rollback}`. Creation needs an operation ID and explicit policy authorization. Updates require the latest policy revision; candidate actions also require the decision ID and reason. The ML overview includes policy configuration, exact comparison evidence, approval provenance, deadlines and outcomes. Shared users, runners and phone listeners cannot authorize these actions.

## Compare models trained on new data

Common holdout policies re-evaluate the incumbent and candidate exports on one immutable labeled dataset using the deployment’s local or standalone SSH worker. They support tabular classification/regression and single-device LoRA models. No cloud service, account or API key is required.

1. Update the worker before training the exports. Both exports need exclusion evidence generated by the current recipes. Older exports remain usable for their existing workflows; common evaluation rejects them with a retraining message. An older pinned deployment may need to be recreated on the updated worker.
2. Set **Dataset purpose → Common holdout — evaluation only**, select the appropriate tabular/LLM recipe and prepare 30–10,000 independent labeled examples on that worker. Stop persistent serving while preparing the snapshot, then resume it. SSH can use a file already on the server or a file transferred from the controller. The snapshot’s hash is reserved against future training submissions.
3. In **Promote evaluated models**, select the deployment, candidate source and **Evaluate both models on a frozen common holdout**. Choose the prepared snapshot. Set a lifetime comparison cap (1–20), elapsed limit per comparison (1–30 minutes), memory limit (256–262,144 MiB, no larger than the endpoint’s limit) and, for LoRA, one common sequence length (32–2,048 tokens, within the base model’s context).
4. Authorize the temporary inference pause and choose per-candidate approval or explicitly authorized automatic deployment. The policy uses the endpoint’s device, selected GPU and CPU-thread limit. Existing search/schedule training and iteration limits remain unchanged.

Each attempt reserves its budget before uploads or model loading. The controller suspends resident serving without changing the selected version or deployment revision, verifies both archives, and starts one durable evaluation job. The worker loads the models sequentially and scores every holdout row without fitting or tuning. Tabular accuracy/RMSE uses the incumbent’s training-derived constant as a fixed baseline. LoRA uses completion-token negative log likelihood and the base model with its adapter disabled; both adapters must use the same exact base, tokenized population and completion-token count. Input/output and split contracts must still match across model versions.

Before loading, tabular checks reject overlapping normalized feature rows, overlapping groups, missing labels, duplicate inputs and incompatible schemas. A time-based holdout must be strictly later than both original datasets. LoRA checks normalized conversation contexts, conversation groups and tokenized prompt identities, including distinct text that collapses to the same tokens. Exclusions cover every original training, tuning and test row. Exact reserved snapshots cannot be submitted for training. Export exclusion hashes are provenance data, not a guarantee of anonymization; treat exported models and evidence as private project artifacts.

Inference requests and new work on the same computer wait or return busy during evaluation. Intentional evaluation downtime resets monitoring windows and does not accumulate failure streaks. After confirmed evaluator cleanup, the controller reloads the unchanged incumbent before creating a promotion decision. A manually stopped or changed endpoint is left as the owner requested. Reload failures pause the policy after at most three attempts. Evaluation time excludes these separately bounded serving reloads and subsequent deployment/health observation.

Results retain the holdout hash, both artifact hashes, evaluator bundle, population hash, row/token counts and baseline/incumbent/candidate scores. Approvals bind to this evidence and the current registry/deployment revisions. Qualifying candidates use the same atomic deployment, registry update, health observation and rollback controls as original-evaluation policies. Common candidates are evaluated in source order; original test scores from different datasets do not rank them. A policy considers each candidate once and does not search all candidates for a global winner before deploying.

Rejected, cancelled, failed and interrupted comparisons consume the lifetime evaluation cap. Pausing cancels active evaluation and waits for confirmed cleanup before restoration. Controller restart adopts the same job and ledger without duplicate evaluation. Unknown worker outcomes keep the computer reserved until reconciled. The worker enforces its elapsed deadline and polls process-group RSS for the memory limit even if the controller disconnects; this is a soft host limit, not a container/cgroup quota or a dedicated GPU-VRAM limit. Keep Code Flow running for restoration, approvals and promotion decisions. When ML is disabled, cancellation remains available and loading waits until ML is enabled again.

Common holdout scores are not sent to the experiment planner. Repeated promotion decisions can nevertheless overfit a fixed holdout. The cap limits this reuse but does not provide statistical significance, semantic equivalence detection or protection against data access outside this trusted-owner workflow. Keep a separately curated, untouched assessment set for final review. Rotate evaluation data under a newly reviewed policy when appropriate.

API clients prepare a dataset with `purpose: "holdout"` on `POST /api/ml/datasets`, then add `holdout: { datasetId, maxEvaluations, seconds, memoryMiB, maxLength, allowServingPause: true }` to `POST /api/ml/promotions`. Policy responses include the durable `evaluations` ledger; successful evaluation jobs expose `status.holdout`, and decisions identify `holdoutJobId`. Omitting `holdout` preserves original-evaluation behavior.

## Monitor deployed models and respond to drift

In **Monitor models and respond to drift**, select an enabled local or SSH deployment and create a monitor. Default actions are **Report only**. Set the window length, minimum traffic, failure/mean-latency thresholds, drift threshold, consecutive failing windows, cooldown and lifetime action cap. Each monitor belongs to the reviewed deployment revision; manually switching or stopping that deployment pauses its automation.

Send representative requests through the prediction or streaming API, then click **Capture reviewed traffic reference**. Review that traffic before accepting it. Drift checks compare subsequent complete windows against this saved reference; health checks can run before a reference exists. Replacing the reference clears confirmation streaks. Insufficient traffic, missing windows and controller restarts also clear confirmation; restarting preserves the reference, policy, completed reports and action journal. Code Flow must be running to collect metrics and check triggers.

Monitoring retains aggregate counts, latency totals and feature histograms in the private controller store, without saving rows, category values, prompts or generated text. Successful tabular requests contribute one sample per row for up to 16 selected features (the UI selects the first 16). Numeric values use coarse signed logarithmic bins; categorical values use 16 salted hash buckets. LLMs contribute prompt character length, input/output token counts and empty-output frequency. Coarse bins can miss shifts and category hashes can collide. These descriptors do not measure semantic drift, correctness or accuracy.

Drift is the largest per-feature Jensen–Shannon distance, using base 2, between normalized reference and current histograms: zero means matching distributions and one means disjoint distributions. Calibrate the default UI threshold of 0.3 on your traffic. Automated drift action requires at least 10 completed requests, 20 successful samples and two failing windows. Health checks require the minimum requests but can act without successful samples. Mean latency includes cold loading and SSH transport. Invalid inputs classified by the current worker, busy rejections and client-cancelled requests are excluded. Older workers may not classify input failures; update an idle worker before relying on this distinction.

Two automatic actions require explicit authorization:

- **Unhealthy inference → approved rollback version:** choose a different version previously served by this deployment. Repeated failure-rate or latency breaches load that version and commit a revision-checked rollback. The monitor then pauses for review. Failed loading, revoked access or a concurrent pause/version change cannot commit a stale rollback. Drift alone does not authorize rollback.
- **Persistent input drift → bounded retraining:** select an existing paused retraining schedule for the same project, repository and recipe. The action polls its source at most once a minute and requires a new stable content hash with the original schema. Original and previously handled data versions are skipped. It consumes the schedule's existing lifetime run ledger and preserves its planner, iteration, training-time and elapsed-time limits. The planner receives only aggregate drift evidence. Results require evaluation and review, or an independently authorized promotion policy that passes the same strict comparison gates.

Training on the serving worker requires **Allow serving to stop during retraining**. Code Flow saves a stop and confirms cleanup before admitting the search, then restores the original release when the search terminates unless the deployment changed manually. A separate configured training worker can train while serving continues. Worker resource deadlines remain in force; cloud accounts are unnecessary.

**Pause monitor** prevents new actions but lets an admitted search finish. **Pause and stop retraining** also requests cancellation. **Stop retraining and keep serving stopped** prevents automatic restoration; otherwise restoration of a monitor-owned stop continues after monitoring is paused. Disabling ML or losing repository access prevents restoration until access is available again. Restoration is capped at three attempts, after which manual inspection and deployment resume are required. Monitoring pause/stop controls remain available when new ML work is disabled.

Durable operation IDs prevent duplicate rollback and training admission after restart. Waiting for data and failed actions count toward the lifetime cap. Retraining actions expire after the saved stability allowance plus search elapsed limit and five minutes; rollback admission has a five-minute deadline. Existing worker deadlines bound in-flight calls. Limits are 20 actions per monitor, 32 retained monitors and 20 recent reports per monitor, also subject to controller storage limits. Missing windows never trigger catch-up actions.

The owner-only API provides `POST /api/ml/monitors` and `POST /api/ml/monitors/:id/{pause,resume,check,reference}`. Mutations require the current monitor revision; creation uses an idempotent operation ID. The project overview includes policies, reference/window counts, reports and action outcomes. External alerts, label-based quality monitoring and semantic monitoring remain future work.

## Prepare the training computer

1. Select a recipe, explicit project repository and training computer, then click **Check computer**. For a previously enrolled worker, use **Update training worker** while it is idle to enable newer recipes.
2. If necessary, open **Python settings** and enter the absolute path to a Python 3.12 executable. `python3` is the default. `CODEFLOW_ML_PYTHON` can initialize this setting when ML storage is first created.
3. Click **Install training environment** if the pinned packages are missing. This creates a private virtual environment under the worker directory and installs a hash-locked dependency set. Follow the setup job in **Experiments and models**, then check the computer again.

Setup does not install Python, Node.js or GPU drivers. It has a 60-minute deadline and supports cancellation. An existing Python environment is usable if its versions match the recipe lock. Each recipe has a separate environment and hash-locked dependencies, installed from binary wheels. Tabular training pins AutoGluon 1.6.1. Fine-tuning pins PyTorch 2.14.1, Transformers 5.20.2, TRL 1.16.0, PEFT 0.21.2, Accelerate 1.15.0 and Datasets 5.1.0. For CUDA, install a compatible NVIDIA driver yourself before checking the computer. Fine-tuning does not automatically select another device when the requested one is unavailable.

## Train and export a tabular model

1. Enter an absolute dataset path and click **Prepare dataset**. Preparation reports the row count, columns, duplicate count and snapshot hash. Later edits to the original file do not change that snapshot.
2. Name the experiment and choose classification or regression and its target column. Missing target labels must be corrected in the source before preparing a new snapshot.
3. Choose the split strategy. Use random splitting only for independent rows. Group splitting keeps each entity entirely within one partition. Time splitting trains on earlier rows and tests on later rows. Group/time columns are excluded from model features.
4. Optionally adjust **Time and CPU limits**, then click **Train model**. The default is two minutes of training and two CPU threads. Preparation, evaluation and export have an additional ten-minute allowance. A computer with one CPU thread needs the CPU setting changed to one.
5. Select the experiment to inspect its state and logs. A successful job shows the candidate and baseline scores on the held-out test partition. Click **Download model** to export it.

The recipe removes identical rows before splitting. Random splitting uses 60% training, 20% tuning and 20% test data. Group and time splits use the same approximate proportions while preserving boundaries. Classification compares accuracy with a majority-class baseline; regression compares RMSE with a mean-value baseline. The recipe trains bounded Random Forest and Extra Trees candidates and chooses using tuning data. Test data is evaluated separately after training. A single held-out comparison is not evidence of production performance.

Extract a trusted export into a fresh directory. It includes the model, dependency lock, evaluation, provenance manifest, training configuration and `predict.py`:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes --only-binary=:all: -r requirements.txt
.venv/bin/python predict.py inputs.csv predictions.csv
```

Model serialization can execute Python when loaded; use exports you trust. The manifest records the worker bundle, repository commit, dataset hash, split hash, model file hashes and installed package versions. The export does not include input dataset snapshots or partition files.

## Fine-tune a language model

1. Select **Language model fine-tuning — LoRA** and prepare its environment.
2. Enter an absolute **Base model folder** on the selected training computer. Use an unquantized Hugging Face model folder with configuration, tokenizer and safetensors weights. Built-in Llama, Qwen2, Qwen3 and GPT-2 architectures are supported. Custom Python model/tokenizer code, pickle weights and quantized models are rejected. If your Hub cache uses symlinks, first materialize a regular-file copy into a separate folder.
3. Click **Prepare base model**. A cancellable job copies, hashes and validates the model into private worker storage. Select the completed snapshot. Source edits after preparation do not change the snapshot. The model stays on its training computer; provision the folder on the SSH server yourself.
4. Prepare a JSONL file with 30–10,000 examples, up to 32 MiB. Choose either prompt/completion or messages format throughout the file. A string `group` is optional:

```jsonl
{"prompt":"Classify this message: Great service!\nAnswer:","completion":"positive","group":"customer-1"}
{"prompt":"Classify this message: The item never arrived.\nAnswer:","completion":"negative","group":"customer-2"}
```

For conversations, use one complete conversation per line:

```jsonl
{"messages":[{"role":"system","content":"Answer clearly."},{"role":"user","content":"What is LoRA?"},{"role":"assistant","content":"A way to train small adapters while keeping the base weights frozen."}],"group":"topic-1"}
```

Messages alternate user and assistant turns and end in an assistant answer, with an optional initial system message. The base tokenizer must supply a compatible chat template. Only the final answer is supervised; earlier conversation turns supply context. Prompts are masked from the loss. Examples over the configured sequence length are rejected instead of silently truncated.

5. Choose **Training device**. CPU is intended for models up to 150M parameters. Apple GPU uses float32; NVIDIA uses bfloat16 where supported, otherwise float32. Select a specific NVIDIA GPU after checking the computer. This release uses single-device LoRA, batch size one and gradient accumulation; QLoRA, multi-GPU and checkpoint resume are not implemented.
6. Adjust **Training settings and limits** if needed. Defaults are 100 steps, rank 8, learning rate 0.0002, accumulation 4 and 512 tokens. Training stops at its step or time allocation; preparation and evaluation receive an additional 30 minutes. Resource preflight and a real forward/backward smoke check run before fitting. Available-memory estimates are approximate and allocation failures are reported in the job log.
7. Click **Fine-tune model**. Inspect step progress, training loss and logs under **Experiments and models**. Completion loss (NLL) compares the untouched base with the adapter on exactly the same held-out answer tokens; lower is better. This is reference-answer likelihood, not a general quality, factuality or safety assessment. Review generated answers before deployment.
8. Click **Download adapter**. The export contains safetensors adapter weights, tokenizer, dependency lock, configuration, provenance, evaluation and a loader. It excludes base weights and training examples. Reuse the exact original base folder when loading:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install --require-hashes --only-binary=:all: -r requirements.txt
.venv/bin/python predict.py --base-model /absolute/path/base-model --prompt "Your prompt"
# For conversations, messages.json contains the prompt's message array:
.venv/bin/python predict.py --base-model /absolute/path/base-model --device mps --messages messages.json
```

The loader verifies base, adapter and tokenizer hashes and never downloads weights. Use `--device cuda` for NVIDIA inference. Retain model licenses and access permissions when distributing an adapter.

Identical examples are removed. Normalized identical prompts and explicit groups are joined before a deterministic approximately 60/20/20 train/tuning/test split. Each partition needs at least five unique examples. Related conversation turns remain together. The tuning partition is reserved for future selection; this fixed recipe performs no hyperparameter search or test-based model selection.

## Add a standalone server over SSH

Use **Add SSH server** in the ML workspace. Provide an existing SSH host alias, display name, worker directory and Python executable. Confirm that the server permits direct training without a scheduler, then save and check it. The server needs Node.js 22.13+ and Python 3.12 on its login environment. OpenSSH must already authenticate noninteractively and have a verified host key for the alias.

The default worker directory is `~/.codeflow/training-worker`. Enrollment installs a versioned worker bundle there and pins its identity to this Code Flow backend. No agent CLI or cloud credentials are copied. Each worker directory belongs to one controlling backend; use distinct directories for independent installations.

Choose where the dataset lives:

- **Training server** reads an absolute path already present on that server.
- **Project computer — copy to training server** freezes the source on the project's backend and transfers bounded, checksummed chunks over SSH. Repeating preparation of unchanged input can resume a partial transfer.

Click **Use by default for this project** to save the server. An unavailable server produces an error; Code Flow does not switch to local or cloud execution. Existing jobs retain their original computer and worker bundle when the project default changes.

SSH workflow tests cover an isolated host fixture, including fine-tuning submissions, JSONL transfer, reconnection, cancellation and export. Real offline LoRA runs have been verified on local CPU and Apple GPU using a tiny generated Llama fixture, including conversation masking and exact held-out score reproduction after export reload. Persistent serving has also been checked with real AutoGluon predictions, CPU and Apple GPU LoRA generation, browser streaming/cancellation, and tabular version switching and rollback. Automatic promotion has been verified with real local LoRA improvement, browser approval, inference and rollback, plus persistent serving over the isolated SSH fixture. Common holdout acceptance also trains real AutoGluon and LoRA exports on different data, evaluates an independent frozen population, approves deployment and rolls both registry and endpoint back. Browser acceptance covers holdout preparation, serving-pause consent, approval, streamed inference and rollback, with desktop/mobile accessibility checks. Local/SSH worker tests cover restart without duplicate evaluation; cancellation, manual stop and memory-limit tests cover cleanup and serving restoration. NVIDIA CUDA remains unverified on a real GPU server. Validation against your actual VM is still required after you configure it. Slurm and other cluster schedulers are unsupported in this preview.

## Jobs, restarts and limits

Each admitted job has a detached supervisor on the selected computer. Closing a browser, restarting Code Flow or disconnecting SSH leaves admitted training running. Reopening Code Flow reconnects to its receipt; it does not submit another attempt. Repeated start requests with the same operation ID return the same experiment.

Cancellation is durable. **Cancellation pending** means Code Flow has recorded the request and is retrying delivery or waiting for process termination. **Cancelled** means the supervisor confirmed that its process group, including descendants, stopped. The supervisor also enforces the job deadline without an active controller connection.

If the supervisor itself crashes or the machine reboots before a terminal receipt is saved, the job can show **Outcome unknown**. It retains its admission slot. Inspect the worker's `jobs/<job-id>/intent.json`, `status.json` and process identities before recovery; do not delete records or retry blindly while any owned process might remain. This preview has no automatic repair or force-release action for ambiguous receipts.

| Limit | Preview behavior |
| --- | --- |
| Supported operating systems | Linux and macOS |
| Tabular dataset | 128 MiB, 30–250,000 rows, 2–256 columns |
| Fine-tuning dataset | 32 MiB, 30–10,000 examples, 128 KiB per line, up to ten million tokenized tokens |
| Base model | 16 GiB, up to 8B stored parameters, 128 files; CPU limit 150M parameters; actual capacity depends on available memory |
| LoRA | 32–2,048 tokens, 1–2,000 steps, rank 4–64, accumulation 1–16, learning rate 0.000001–0.001 |
| Classification | 2–100 classes, at least five distinct examples per class; every test/tuning class must appear in training |
| Concurrent jobs | One active or unresolved job per worker and per project, including environment setup and model preparation |
| Training allocation | 10–3,600 seconds through the API; 1–60 minutes in the UI; 1–32 CPU threads, at most the detected capacity |
| Logs / export | 4 MiB per job / 512 MiB model export |
| Registry | 32 named models, 200 versions, 200 selection events per model and 2 GiB of registered archives |
| History | 200 experiments and 200 dataset records per controller; 200 jobs per worker; 32 training computers; new records also stop at 6 MiB, reserving space for final receipts |
| Isolation | Dedicated environment and process group; no hard RAM, disk or network sandbox |

History and prepared datasets are retained in private storage, outside Git. Automatic retention, target removal and history archival are not implemented yet. **Update training worker** installs the current bundled recipes only while that worker is idle; existing experiments retain their original bundle and environment. New jobs may require installation of the newer bundle’s private environment. The preview stops admitting new work at its history limits instead of silently deleting evidence. Keep adequate free disk space and back up worker data together with controller records. Treat the worker account as trusted.

**Disable model training** in Settings blocks new training, inference and automatic actions. Jobs already admitted keep their time limits, and resident models remain loaded until **Stop serving**, idle expiry or lifetime expiry. Existing history, job inspection, cancellation, exports and stopping serving stay available. Re-enabling allows saved schedules and policies to operate within their remaining limits; paused searches require explicit resume. This toggle does not delete datasets or model versions. For existing deployments, `CODEFLOW_ML_ENABLED=true` remains a startup fallback only until Settings saves a choice; an explicitly saved disabled setting overrides the environment flag. ML endpoints require the local owner context and are unavailable to shared accounts, runner credentials and phone listeners. Custom filesystem restrictions pause ML access because this host-process backend cannot enforce a per-project filesystem sandbox. Active or unresolved training, registry operations, export transfers, enabled monitoring/promotion policies or pending monitoring/rollout actions, and enabled or cleanup-pending persistent deployments block changes to filesystem policies.

Controller state is a serialized, atomically replaced and fsynced `CODEFLOW_HOME/ml/state.json` document. Workers retain immutable intents, status receipts, cancellation requests, snapshots and artifacts in their own directory. Malformed or missing authority never triggers automatic resubmission.

## Development checks

Source development (`npm run dev`) builds the training worker once at startup. When running `tsx src/server.ts` directly, first run `npm run build:training-worker`.

`npm test` includes the worker lifecycle and isolated SSH fixture tests without Python or model downloads. To exercise the actual pinned recipe, provision its Python environment and run:

```sh
CODEFLOW_TEST_ML_PYTHON=/absolute/path/to/pinned-env/bin/python node --import tsx --test test/ml-recipe.test.ts
```

This checks split boundaries and duplicate removal, trains a regression model, restarts its controller, verifies its export and loads that export in a separate prediction process. Package changes require rebuilding the worker with `npm run build:training-worker` or `npm run build`. Existing enrolled targets retain their pinned bundle until explicitly updated.

To run the offline LoRA integration test, install its locked requirements in a Python 3.12 environment and run:

```sh
CODEFLOW_TEST_LLM_PYTHON=/absolute/path/to/llm-env/bin/python node --import tsx --test test/ml-llm-recipe.test.ts
CODEFLOW_TEST_LLM_PYTHON=/absolute/path/to/llm-env/bin/python CODEFLOW_TEST_LLM_DEVICE=mps node --import tsx --test test/ml-llm-recipe.test.ts
```

The test generates tiny random Llama weights and a tokenizer locally. It tests the training machinery and export contract without downloading a pretrained model. It does not establish quality on a real task. CUDA acceptance still requires an owned NVIDIA server.

[Documentation library](README.md) · [ML implementation plan](ml-training-implementation-plan.md) · [SSH projects](ssh-projects.md)
