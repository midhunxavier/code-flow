import { lazyView } from "./lazy-view.js";

// Template editing is optional; load it only when its panel is opened.
export const TeamTemplateLibrary = lazyView(() => import("./team-template-library-view.js").then(module => module.TeamTemplateLibrary));
