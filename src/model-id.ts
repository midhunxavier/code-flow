/** Same model identity rules at the editor and dispatch boundary. Empty means provider default. */
export function validModelId(provider: string, value: string): boolean {
  const model = value.trim();
  return !model || (provider.startsWith("acp:") ? model.length <= 256 && !/[\x00-\x1f\x7f]/.test(model) : /^[A-Za-z0-9][\w.:/[\]@-]{0,99}$/.test(model));
}

export function modelIdProblem(provider: string, value = ""): string {
  return validModelId(provider, value) ? "" : provider.startsWith("acp:") ? "Use a model ID of at most 256 characters, without control characters." : "Use a model ID of at most 100 characters: start with a letter or digit; use letters, digits or . _ : / [ ] @ - without spaces.";
}
