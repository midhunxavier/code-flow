/** Trust explicit catalog labels/IDs only; absence of pricing does not mean free. */
export const isFreeModel = (model: { id: string; label: string }) => /(?:^|[\s:/(_-])free(?:$|[\s:)\]_-])/i.test(`${model.id} ${model.label}`);
export function freeModelsFirst<T extends { id: string; label: string }>(models: readonly T[]): T[] {
  return [...models].sort((a, b) => Number(isFreeModel(b)) - Number(isFreeModel(a)));
}
