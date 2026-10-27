/** Filtered task lifecycle rules shared by the service and its browser panel. */
export const FILTERED_TASK_BYTES = 24 * 1024;
interface Lifecycle { status: string; containerStopped: boolean; importCommit?: string }
/** Preparing, running and importing work, or a daemon container not yet confirmed stopped, blocks another task. */
export const filteredTaskActive = (job: Lifecycle) => ["preparing", "running", "importing"].includes(job.status) || !job.containerStopped;
/**
 * Cancel stops preparation or the provider turn, or confirms an unknown daemon receipt stopped.
 * A finished task whose container is confirmed stopped has nothing to cancel: cancelling would only
 * discard its result or failure reason. An interrupted import needs its receipt inspected instead.
 */
export const filteredTaskCancellable = (job: Lifecycle) => job.status !== "importing" && !(job.status === "unknown" && job.importCommit) && (["preparing", "running", "unknown"].includes(job.status) || !job.containerStopped);
