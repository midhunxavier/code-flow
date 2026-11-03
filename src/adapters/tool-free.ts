/** The same capability contract is checked at discussion admission and each native launch. */
export const TOOL_FREE_FLAGS = ["--tools", "--settings", "--setting-sources", "--mcp-config", "--strict-mcp-config", "--no-chrome"];
export function supportsToolFreeDiscussion(provider: string, help: string) {
  return provider === "claude" && TOOL_FREE_FLAGS.every(flag => help.includes(flag));
}
