# Code Flow plugin for Claude Code

Adds the Code Flow connection and its skill to Claude Code. It needs the Code Flow launcher on your PATH first:

```sh
npm install -g @midhunxavier/code-flow@preview
```

Then, in Claude Code:

```
/plugin marketplace add midhunxavier/code-flow
/plugin install codeflow@code-flow
```

Use either this plugin or `codeflow init`, not both. If `codeflow init` already registered a user-level `codeflow` connection with the same command, Claude Code keeps that one and drops the plugin's copy.

The skill here is a copy of `integrations/cli-teams/SKILL.md`; a test keeps the two identical.
