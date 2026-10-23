import { lazyView } from "./lazy-view.js";

export const ProjectInvitations = lazyView(() => import("./project-invitations-view.js").then(module => module.ProjectInvitations));
