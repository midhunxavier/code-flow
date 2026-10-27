/** Free of Node imports, so the browser can apply the same credential-path rule. */
/** Git-internal and credential-store folders. The credential file-name pattern applies to files only, so a folder such as `secrets/` is not itself sensitive. */
export function sensitiveDirectoryPath(path: string): boolean {
  return path.replace(/\\/g, "/").toLowerCase().split("/").some((part) => [".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube"].includes(part));
}
export function sensitiveContextPath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").toLowerCase().split("/");
  return sensitiveDirectoryPath(path) || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx))$/.test(parts.at(-1) ?? "");
}
