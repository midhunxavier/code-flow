// Leave room for the 7 MiB proposal contract and its JSON-RPC/HTTP envelope.
// Per-file and aggregate decoded attachment limits are enforced by chatAttachments.
export const CLI_MESSAGE_BYTES = 8 * 1024 * 1024;
