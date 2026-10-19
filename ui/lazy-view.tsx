import { Component, type ComponentType, type ComponentChildren } from "preact";
import { lazy, Suspense } from "preact/compat";

class LoadBoundary extends Component<{ children: ComponentChildren }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    return this.state.error ? <div role="alert" class="msg err">This view could not load. <button class="btn" onClick={() => location.reload()}>Reload app</button></div> : this.props.children;
  }
}
export function lazyView<P extends object>(load: () => Promise<ComponentType<P>>) {
  const View = lazy(() => load().then((component) => ({ default: component })));
  return (props: P) => <LoadBoundary><Suspense fallback={<div role="status" class="help">Loading view…</div>}><View {...props} /></Suspense></LoadBoundary>;
}
