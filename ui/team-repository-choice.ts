/** A shared key is portable; the selected host's absolute path is never published. */
export function repositoryChoice(path: string, usedKeys: string[]) {
  const label = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "Repository";
  let base = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  if (!/^[a-z]/.test(base)) base = `repo-${base}`;
  base = base.slice(0, 64).replace(/-+$/, "");
  let key = base;
  for (let index = 2; usedKeys.includes(key); index++) {
    const suffix = `-${index}`;
    key = base.slice(0, 64 - suffix.length).replace(/-+$/, "") + suffix;
  }
  return { key, label: label.slice(0, 80) };
}
