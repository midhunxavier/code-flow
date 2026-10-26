import { useState } from "preact/hooks";
import { useDialog } from "./app.js";
import { templateParameters, fillTemplate, taskWithCriteria, type TaskTemplate } from "./composer-tools.js";

export function FillTemplateDialog({ template, onClose, onApply }: { template: TaskTemplate; onClose: () => void; onApply: (values: Record<string, string>) => void }) {
  const ref = useDialog(true, onClose);
  const [values, setValues] = useState<Record<string, string>>({});
  const names = templateParameters(template);
  let preview = "";
  try { const filled = fillTemplate(template, values); preview = taskWithCriteria(filled.task, filled.criteria); } catch { /* incomplete parameters */ }
  return <dialog class="picker" ref={ref} aria-labelledby="fill-template-title"><div class="picker-inner"><div class="picker-head"><h3 id="fill-template-title">Apply {template.name}</h3></div><div class="dialog-body">{names.map((name) => <div key={name}><label class="lbl" for={`parameter-${name}`}>{name}</label><input class="field" id={`parameter-${name}`} value={values[name] ?? ""} maxLength={4000} onInput={(e) => setValues({ ...values, [name]: e.currentTarget.value })} /></div>)}{preview ? <details><summary>Preview task</summary><pre class="template-preview" tabIndex={0}>{preview}</pre></details> : null}</div><div class="picker-foot"><span class="ps" /><button class="btn" onClick={onClose}>Cancel</button><button class="btn primary" disabled={!preview} onClick={() => onApply(values)}>Use template</button></div></div></dialog>;
}
