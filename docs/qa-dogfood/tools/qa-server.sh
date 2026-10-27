#!/bin/bash
# Isolated code-flow QA servers. NEVER touches the user's live server (4317/4318) or ~/.codeflow runs.
#   qa-server.sh start <name> <port> [real|fake] [srcdir]   # port must be odd 4331..4699 (remote port = port+1)
#   qa-server.sh stop <name>
#   qa-server.sh restart <name>                             # same port/mode/src as the last start
#   qa-server.sh status <name>
#   qa-server.sh snapshot <name>                            # rsync the dogfood worktree into builds/<name> and build its UI
# Token for every server: qa-<name>-token   (open http://127.0.0.1:<port>/?token=qa-<name>-token — use 127.0.0.1, never localhost)
set -euo pipefail
QA=/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa
DOGFOOD=/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa
cmd=${1:?command}; name=${2:?name}
home="$QA/homes/$name"
token="qa-$name-token"

case "$cmd" in
  snapshot)
    dest="$QA/builds/$name"; mkdir -p "$dest"
    rsync -a --delete --exclude node_modules --exclude .git --exclude public --exclude dist "$DOGFOOD/" "$dest/"
    ln -sfn "$DOGFOOD/node_modules" "$dest/node_modules"
    (cd "$dest" && node scripts/build-ui.mjs >/dev/null 2>&1) && echo "snapshot ready: $dest"
    ;;
  start)
    port=${3:?port}; mode=${4:-real}; src=${5:-$DOGFOOD}
    if [[ "$port" == 4317 || "$port" == 4318 || "$port" -lt 4331 || "$port" -gt 4699 ]]; then echo "refusing port $port"; exit 1; fi
    if lsof -ti tcp:"$port" >/dev/null 2>&1; then echo "port $port busy"; exit 1; fi
    mkdir -p "$home"
    # New homes start with NO projects (register scratch repos only). QA_COPY_PROJECTS=1 copies the user's project
    # list (it points at the user's real repos — never start runs on those).
    if [[ ! -f "$home/.initialized" ]]; then
      if [[ "${QA_COPY_PROJECTS:-0}" == 1 ]]; then
        cp ~/.codeflow/projects.json "$home/projects.json"
        [[ -d ~/.codeflow/project-teams ]] && cp -R ~/.codeflow/project-teams "$home/project-teams"
      fi
      [[ -f ~/.codeflow/model-catalog-settings.json ]] && cp ~/.codeflow/model-catalog-settings.json "$home/"
      touch "$home/.initialized"
    fi
    [[ -f "$src/public/index.html" ]] || (cd "$src" && node scripts/build-ui.mjs >/dev/null 2>&1)
    echo "$port $mode $src" > "$home/server.conf"
    path="$PATH"
    if [[ "$mode" == fake ]]; then path="$src/test/fake-bin:$PATH"; export FAKE_GH_STATE="$home/fake-gh.json"; [[ -f "$FAKE_GH_STATE" ]] || echo '{"issues":[],"prs":{}}' > "$FAKE_GH_STATE"; fi
    cd "$src"
    PORT="$port" CODEFLOW_HOME="$home" CODEFLOW_TOKEN="$token" PATH="$path" nohup node --import tsx src/server.ts >> "$home/server.out" 2>&1 &
    echo $! > "$home/server.pid"
    for i in $(seq 1 120); do
      if curl -sf -m 2 -H "authorization: Bearer $token" "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
        echo "started $name pid=$(cat "$home/server.pid") mode=$mode src=$src url=http://127.0.0.1:$port/?token=$token home=$home"; exit 0; fi
      sleep 0.5
    done
    echo "server did not become healthy; tail of log:"; tail -30 "$home/server.out"; exit 1
    ;;
  stop)
    pid=$(cat "$home/server.pid" 2>/dev/null || true)
    if [[ -z "$pid" ]] && [[ -f "$home/server.conf" ]]; then read -r port _ < "$home/server.conf"; pid=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true); fi
    [[ -n "$pid" ]] || { echo "not running"; exit 0; }
    if ps eww -o command= -p "$pid" 2>/dev/null | grep -q "CODEFLOW_HOME=$home"; then
      kill -TERM "$pid"; for i in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" || true
      echo "stopped $name ($pid)"
    else echo "pid $pid is not $name's server; not killing"; fi
    rm -f "$home/server.pid"
    ;;
  restart)
    read -r port mode src < "$home/server.conf"
    "$0" stop "$name"; sleep 1; "$0" start "$name" "$port" "$mode" "$src"
    ;;
  status)
    [[ -f "$home/server.conf" ]] && cat "$home/server.conf"
    [[ -f "$home/server.pid" ]] && ps -o pid,etime,command= -p "$(cat "$home/server.pid")" || echo "not running"
    ;;
  *) echo "unknown command $cmd"; exit 1;;
esac
