import { lazyView } from "./lazy-view.js";

export const IntegrationsScreen = lazyView(() => import("./integration-connections-view.js").then(module => module.IntegrationsScreen));
