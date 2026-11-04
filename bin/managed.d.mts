export const PACKAGE: string;
export function managedLauncher(home: string): Promise<string | undefined>;
export function updateState(home: string): Promise<any>;
export function updateStatus(home: string): Promise<any>;
export function enableUpdates(home: string, source: string, channel?: string): Promise<any>;
export function configureUpdates(home: string, enabled: boolean): Promise<any>;
export function checkUpdates(home: string, force?: boolean, options?: any): Promise<any>;
export function retireManagedOwner(home: string, root: string, idleStop: (nextRoot: string) => Promise<boolean>): Promise<boolean>;
export function runManaged(args: string[], home: string): Promise<void>;
