const { isAbsolute, relative } = require('node:path');

function serverOrigin(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Choose a loopback HTTP(S) server without a path, token or credentials in its URL. Use an SSH tunnel for another machine.');
  return url.origin;
}
function localContextPath(folder, file) {
  const path = relative(folder, file).replaceAll('\\', '/');
  if (!path || isAbsolute(path) || path.split('/').includes('..') || path.split('/').some((part) => part.toLowerCase() === '.git') || /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key))$/i.test(path)) return;
  return path;
}
class CodeFlowClient {
  #token;
  #transport;
  constructor(origin, token, transport = fetch) { this.origin = serverOrigin(origin); this.#token = token; this.#transport = transport; }
  async request(path, body, method) {
    if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('\0')) throw new Error('Invalid Code Flow API path');
    const response = await this.#transport(this.origin + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const length = Number(response.headers.get('content-length'));
    if (length > 4 * 1024 * 1024) throw new Error('Code Flow returned too much data');
    let size = 0; const chunks = [];
    for await (const chunk of response.body || []) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('Code Flow returned too much data'); chunks.push(chunk); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!response.ok) throw new Error(response.status === 401 ? 'Reconnect to Code Flow with a current server token.' : String(value.error || `Code Flow returned ${response.status}`));
    return value;
  }
  async compatibility() { const report = await this.request('/api/v1/capabilities'); if (report.version !== 1) throw new Error('This server uses an unsupported Code Flow API version'); return report; }
  async runs(repo) { const page = await this.request('/api/v1/runs?limit=100'); return page.runs.filter((run) => !repo || run.repo === repo || run.worktrees?.some((tree) => tree.path === repo)); }
  async start(repo, task, paths = [], beforeDispatch = () => {}) {
    if (typeof repo !== 'string' || !isAbsolute(repo) || typeof task !== 'string' || !task.trim() || task.length > 24000) throw new Error('Choose a local repository and a task under 24,000 characters');
    await this.compatibility();
    const detected = await this.request(`/api/v1/check?repo=${encodeURIComponent(repo)}`);
    beforeDispatch(); // The connection can change during compatibility/check requests.
    return this.request('/api/v1/runs', { repo, task: task.trim(), pattern: 'solo', roles: { agent: ['auto'] }, options: {}, trust: 'safe', approvals: { tools: true }, context: { paths: paths.map((path) => ({ path })) }, loop: { check: detected.command || '', maxSteps: 20, maxMinutes: 30, copy: [] } });
  }
}
module.exports = { CodeFlowClient, serverOrigin, localContextPath };
