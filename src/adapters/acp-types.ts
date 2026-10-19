/** Saved executable invocation. Arguments are passed directly, never through a shell. */
export interface AcpConnection {
  id: `acp:${string}`;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}
export interface AcpConnectionDocument { version: 1; revision: number; connections: AcpConnection[] }
export interface AcpBinding { id: string; fingerprint: string }
export interface AcpProbe {
  protocolVersion: 1;
  agent: string;
  version?: string;
  sessionResume: boolean;
  catalog: import("./types.js").ModelCatalog;
}
