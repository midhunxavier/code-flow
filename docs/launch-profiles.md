# Service launch profiles

Open Project → Repository tools → Services to define a named launch profile. Check dependencies and readiness before starting the profile, then use its logs and stop controls to manage the services.

## Start the services you need

Create `.codeflow/launch.json` in the repository. Project → Repository tools → Services reads the selected run's worktree configuration. It does not execute anything until you click **Start launch profile**. Review commands first: they execute repository code on your computer with your ordinary development environment. Runs from an untrusted external source require an additional explicit confirmation.

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "development",
      "name": "API and web app",
      "services": [
        {
          "id": "api",
          "command": "npm run dev",
          "cwd": "packages/api",
          "health": { "path": "/health", "timeoutMs": 30000 }
        },
        {
          "id": "web",
          "command": "npm run dev -- --host 127.0.0.1 --port $PORT",
          "cwd": "packages/web",
          "dependsOn": ["api"],
          "env": { "VITE_API_URL": "${API_URL}" },
          "health": { "path": "/", "timeoutMs": 30000 }
        }
      ]
    }
  ]
}
```

Each profile has a unique lowercase ID, a display name, and one to six services. The file supports up to twelve profiles and is limited to 128 KiB. Every service needs a unique lowercase ID and a shell command. `cwd` defaults to `.` and must be a regular directory beneath the worktree; absolute paths, `..`, `.git`, and symbolic links are rejected. Dependencies must name existing services and form an acyclic graph. Commands are launched in dependency order; each dependency must pass its readiness check before dependent commands start.

Before starting any service, code-flow allocates distinct ports and generates `PORT`, `HOST=127.0.0.1`, and `SERVICE_NAME` for each service, plus `<SERVICE_ID>_URL` and `<SERVICE_ID>_PORT` for every peer. IDs use uppercase environment names with hyphens replaced by underscores. For example `user-api` produces `USER_API_URL=http://127.0.0.1:<allocated port>`. A command must honor `PORT` to use the assigned port; code-flow does not rewrite a command or its configuration. Services should bind to `HOST` to remain on this computer.

Optional `env` values can substitute these generated variables using `${NAME}`. Unknown substitutions and attempts to replace reserved variables are rejected before any command executes. Service environment entries are limited to forty bounded strings. Code-flow's server session and registered integration credentials are excluded from child environments. Ordinary credentials you exported for development remain available to the repository commands.

The default readiness check requests `/` on the service's assigned `127.0.0.1` port and waits up to 15 seconds for a 2xx response. Custom paths must be local paths; redirects are not followed. Each check is bounded to 100–120,000 ms, and the complete stack has a three-minute startup deadline. Set `health: false` for a background worker without HTTP. This only checks that its process remains running and is displayed as **HTTP readiness not confirmed**; it does not prove application health.

The panel exposes each service's status, local URL, and its last 100 bounded log lines. **Stop services** cancels pending startup and terminates all process groups in the stack. Failed health checks or process exits stop the other services and preserve recent logs for diagnosis. Only one stack per run/worktree may run at a time; stop it before choosing a different profile. Service state is ephemeral and profiles do not restart automatically after code-flow restarts.

The API uses `GET /api/runs/:id/launch-profiles?worktree=NAME` for `{profiles,found,error?,session}`, `POST` with `{worktree,profile,allowUntrusted?}` to explicitly start, and `DELETE` with the worktree query to stop. The backend resolves run-owned worktrees; callers cannot supply an arbitrary filesystem root. A start returns a `LaunchSession` after readiness succeeds. Errors retain session logs, retrievable through `GET`.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
