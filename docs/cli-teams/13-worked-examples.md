# Worked examples and implementation fixtures

Status: proposed. [Index](README.md)

These examples define reproducible input fixtures for the schema/compiler tests. The model IDs are deliberately fake. Tests provide a catalog advertising them; actual installations must resolve available models and supported efforts. The JSON represents proposed configuration, not files to install into a user's project before implementation.

## Reusable profiles

The following four profiles are reused across teams. Capabilities are required adapter-reported/tested features; `structured_output` does not by itself grant file access.

```json
[
  {
    "schemaVersion": 1,
    "id": "codex-deep",
    "version": 1,
    "provider": "codex",
    "model": {
      "kind": "explicit",
      "value": "fixture-codex-reasoning"
    },
    "effort": {
      "kind": "explicit",
      "value": "high"
    },
    "requiredCapabilities": [
      "structured_output"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "codex-standard",
    "version": 1,
    "provider": "codex",
    "model": {
      "kind": "explicit",
      "value": "fixture-codex-fast"
    },
    "effort": {
      "kind": "explicit",
      "value": "medium"
    },
    "requiredCapabilities": [
      "structured_output"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "claude-deep",
    "version": 1,
    "provider": "claude",
    "model": {
      "kind": "explicit",
      "value": "fixture-claude-reasoning"
    },
    "effort": {
      "kind": "explicit",
      "value": "high"
    },
    "requiredCapabilities": [
      "structured_output"
    ]
  },
  {
    "schemaVersion": 1,
    "id": "claude-standard",
    "version": 1,
    "provider": "claude",
    "model": {
      "kind": "explicit",
      "value": "fixture-claude-reasoning"
    },
    "effort": {
      "kind": "explicit",
      "value": "medium"
    },
    "requiredCapabilities": [
      "structured_output"
    ]
  }
]
```

## Three independent planners and one synthesizer

User: “Have two Codex models and one Claude model propose independently. Cross-review, combine the proposals, and keep revising until all three approve the same final plan.”

```json
{
  "schemaVersion": 1,
  "id": "architecture",
  "version": 1,
  "name": "Architecture team",
  "workflowRef": {
    "id": "plan-agreement",
    "version": 1
  },
  "participants": [
    {
      "id": "planner-a",
      "profileRef": {
        "id": "codex-deep",
        "version": 1
      },
      "bindingPreference": "managed"
    },
    {
      "id": "planner-b",
      "profileRef": {
        "id": "claude-deep",
        "version": 1
      },
      "bindingPreference": "managed"
    },
    {
      "id": "planner-c",
      "profileRef": {
        "id": "codex-standard",
        "version": 1
      },
      "bindingPreference": "managed"
    },
    {
      "id": "synthesizer",
      "profileRef": {
        "id": "claude-deep",
        "version": 1
      },
      "bindingPreference": "managed"
    }
  ],
  "roles": {
    "planners": [
      "planner-a",
      "planner-b",
      "planner-c"
    ],
    "synthesizer": [
      "synthesizer"
    ],
    "plan_reviewers": [
      "planner-a",
      "planner-b",
      "planner-c"
    ]
  }
}
```

A participant holding both planner and reviewer roles gets role-specific context. The synthesizer is a distinct participant even though it shares Claude Deep with planner B. No private session is reused merely because profile/provider IDs match.

## Complete plan agreement workflow

In this serialization, `roles` declares graph role contracts, `nodes` declare executable structure, and `edges` declare readiness dependencies. Role operation templates supply the bounded instructions for each registered operation. Input references resolve local node scope first and then enclosing earlier nodes; shadowing an enclosing node ID is rejected. `state` is the prior loop iteration's immutable exported state.

`revise_proposal` receives the original proposal collection and the server-derived participant identity. It identifies that participant's own proposal, critiques the other proposals, and emits a revised proposal with rationale and references. It is not a final approval vote. A one-planner template may omit this node as a deterministic proposal-generation optimization.

```json
{
  "schemaVersion": 1,
  "id": "plan-agreement",
  "version": 1,
  "inputs": {
    "requirements": {
      "kind": "requirements"
    },
    "repository": {
      "kind": "code_snapshot"
    }
  },
  "roles": {
    "planners": {
      "minParticipants": 1,
      "maxParticipants": 4,
      "access": "read",
      "outputKind": "proposal"
    },
    "synthesizer": {
      "minParticipants": 1,
      "maxParticipants": 1,
      "access": "read",
      "outputKind": "plan"
    },
    "plan_reviewers": {
      "minParticipants": 1,
      "maxParticipants": 4,
      "access": "read",
      "outputKind": "review"
    }
  },
  "nodes": [
    {
      "id": "proposals",
      "type": "parallel",
      "forEachRole": "planners",
      "joinPolicy": "all",
      "task": {
        "id": "propose",
        "type": "task",
        "executor": "participant",
        "role": "planners",
        "operation": "propose",
        "inputs": {
          "requirements": {
            "from": "input",
            "name": "requirements"
          },
          "repository": {
            "from": "input",
            "name": "repository"
          }
        },
        "output": {
          "name": "proposal",
          "kind": "proposal"
        }
      },
      "output": {
        "name": "proposals",
        "kind": "proposal",
        "collection": true
      }
    },
    {
      "id": "cross_review",
      "type": "parallel",
      "forEachRole": "planners",
      "joinPolicy": "all",
      "task": {
        "id": "revise",
        "type": "task",
        "executor": "participant",
        "role": "planners",
        "operation": "revise_proposal",
        "inputs": {
          "requirements": {
            "from": "input",
            "name": "requirements"
          },
          "repository": {
            "from": "input",
            "name": "repository"
          },
          "proposals": {
            "from": "node",
            "node": "proposals",
            "output": "proposals"
          }
        },
        "output": {
          "name": "proposal",
          "kind": "proposal"
        }
      },
      "output": {
        "name": "proposals",
        "kind": "proposal",
        "collection": true
      }
    },
    {
      "id": "agree_plan",
      "type": "loop",
      "maxIterations": 3,
      "initial": {
        "plan": null,
        "decision": null
      },
      "body": {
        "nodes": [
          {
            "id": "synthesize",
            "type": "task",
            "executor": "participant",
            "role": "synthesizer",
            "operation": "synthesize",
            "inputs": {
              "requirements": {
                "from": "input",
                "name": "requirements"
              },
              "repository": {
                "from": "input",
                "name": "repository"
              },
              "proposals": {
                "from": "node",
                "node": "cross_review",
                "output": "proposals"
              },
              "previousPlan": {
                "from": "state",
                "name": "plan"
              },
              "previousDecision": {
                "from": "state",
                "name": "decision"
              }
            },
            "output": {
              "name": "plan",
              "kind": "plan"
            }
          },
          {
            "id": "reviews",
            "type": "parallel",
            "forEachRole": "plan_reviewers",
            "joinPolicy": "all",
            "task": {
              "id": "review",
              "type": "task",
              "executor": "participant",
              "role": "plan_reviewers",
              "operation": "review_plan",
              "inputs": {
                "requirements": {
                  "from": "input",
                  "name": "requirements"
                },
                "repository": {
                  "from": "input",
                  "name": "repository"
                },
                "target": {
                  "from": "node",
                  "node": "synthesize",
                  "output": "plan"
                }
              },
              "output": {
                "name": "review",
                "kind": "review"
              }
            },
            "output": {
              "name": "reviews",
              "kind": "review",
              "collection": true
            }
          },
          {
            "id": "agreement",
            "type": "gate",
            "policy": "all_required_approve",
            "requiredRole": "plan_reviewers",
            "target": {
              "from": "node",
              "node": "synthesize",
              "output": "plan"
            },
            "reviews": {
              "from": "node",
              "node": "reviews",
              "output": "reviews"
            },
            "output": {
              "name": "decision",
              "kind": "decision"
            }
          }
        ],
        "edges": [
          {
            "from": "synthesize",
            "to": "reviews"
          },
          {
            "from": "reviews",
            "to": "agreement"
          }
        ]
      },
      "gate": "agreement",
      "next": {
        "plan": {
          "node": "synthesize",
          "output": "plan"
        },
        "decision": {
          "node": "agreement",
          "output": "decision"
        }
      },
      "exports": {
        "plan": {
          "node": "synthesize",
          "output": "plan"
        },
        "decision": {
          "node": "agreement",
          "output": "decision"
        }
      },
      "onLimit": "wait_for_user"
    },
    {
      "id": "deliver",
      "type": "finish",
      "outcome": "agreed_plan",
      "inputs": {
        "plan": {
          "from": "node",
          "node": "agree_plan",
          "output": "plan"
        },
        "decision": {
          "from": "node",
          "node": "agree_plan",
          "output": "decision"
        }
      }
    }
  ],
  "edges": [
    {
      "from": "proposals",
      "to": "cross_review"
    },
    {
      "from": "cross_review",
      "to": "agree_plan"
    },
    {
      "from": "agree_plan",
      "to": "deliver"
    }
  ]
}
```

Expected behavior: three proposal calls and three cross-review calls precede synthesis/review iterations. Each review iteration is one synthesis plus three required reviews. With a three-iteration limit, at most 18 managed inference turns are needed before retries; reserve any configured output-repair allowance separately. If the first iteration approves, stop after ten turns. These counts are fixture expectations, not estimates for a different team or workflow.

The final gate includes all three required reviewers on the synthesized plan. It cannot mix planner A's approval of v1 with planner B's approval of v2. At the limit, retain the latest reviewed plan and remaining findings.

## Feature team and implementation loop

User: “Codex plans, Claude reviews until agreement, Claude implements, and Codex reviews the changes until checks and review pass.”

```json
{
  "schemaVersion": 1,
  "id": "feature",
  "version": 1,
  "name": "Feature team",
  "workflowRef": {
    "id": "feature",
    "version": 1
  },
  "participants": [
    {
      "id": "planner",
      "profileRef": {
        "id": "codex-deep",
        "version": 1
      },
      "bindingPreference": "managed"
    },
    {
      "id": "plan-reviewer",
      "profileRef": {
        "id": "claude-deep",
        "version": 1
      },
      "bindingPreference": "managed"
    },
    {
      "id": "builder",
      "profileRef": {
        "id": "claude-standard",
        "version": 1
      },
      "bindingPreference": "managed"
    },
    {
      "id": "code-reviewer",
      "profileRef": {
        "id": "codex-deep",
        "version": 1
      },
      "bindingPreference": "managed"
    }
  ],
  "roles": {
    "planners": [
      "planner"
    ],
    "synthesizer": [
      "planner"
    ],
    "plan_reviewers": [
      "plan-reviewer"
    ],
    "builder": [
      "builder"
    ],
    "code_reviewers": [
      "code-reviewer"
    ]
  }
}
```

Construct the `feature` workflow deterministically from the plan workflow above:

1. Change the workflow ID to `feature`; retain version 1 and its requirement/repository inputs.
2. Add `builder` with cardinality exactly one, write access, and output kind `code_snapshot`.
3. Add `code_reviewers` with cardinality one to four, read access, output kind `review`, and independence from the builder participant. The proposal defaults to a different provider for builder and code reviewer; if a strict different-provider rule is selected, validate it.
4. Retain `proposals`, `cross_review`, and `agree_plan` with their original edges.
5. Replace `deliver` with the loop below followed by a finish node whose outcome is `verified_changes`. Its inputs are the approved plan plus the loop's code, verification, reviews, and decision exports.
6. Replace the old edge to `deliver` with `agree_plan -> build_review -> deliver`.

This is a build-time template constructor, not an `extends` or arbitrary-code feature in runtime graph JSON. Store and validate the fully expanded definition.

```json
{
  "id": "build_review",
  "type": "loop",
  "maxIterations": 3,
  "initial": {
    "code": null,
    "decision": null
  },
  "body": {
    "nodes": [
      {
        "id": "build",
        "type": "task",
        "executor": "participant",
        "role": "builder",
        "operation": "implement",
        "inputs": {
          "requirements": {
            "from": "input",
            "name": "requirements"
          },
          "repository": {
            "from": "input",
            "name": "repository"
          },
          "plan": {
            "from": "node",
            "node": "agree_plan",
            "output": "plan"
          },
          "previousCode": {
            "from": "state",
            "name": "code"
          },
          "previousDecision": {
            "from": "state",
            "name": "decision"
          }
        },
        "output": {
          "name": "code",
          "kind": "code_snapshot"
        }
      },
      {
        "id": "verify",
        "type": "task",
        "executor": "engine",
        "operation": "verify",
        "profile": "accepted",
        "inputs": {
          "code": {
            "from": "node",
            "node": "build",
            "output": "code"
          }
        },
        "output": {
          "name": "verification",
          "kind": "verification"
        }
      },
      {
        "id": "reviews",
        "type": "parallel",
        "forEachRole": "code_reviewers",
        "joinPolicy": "all",
        "task": {
          "id": "review",
          "type": "task",
          "executor": "participant",
          "role": "code_reviewers",
          "operation": "review_code",
          "inputs": {
            "requirements": {
              "from": "input",
              "name": "requirements"
            },
            "plan": {
              "from": "node",
              "node": "agree_plan",
              "output": "plan"
            },
            "target": {
              "from": "node",
              "node": "build",
              "output": "code"
            },
            "verification": {
              "from": "node",
              "node": "verify",
              "output": "verification"
            }
          },
          "output": {
            "name": "review",
            "kind": "review"
          }
        },
        "output": {
          "name": "reviews",
          "kind": "review",
          "collection": true
        }
      },
      {
        "id": "completion",
        "type": "gate",
        "policy": "build_complete",
        "requiredRole": "code_reviewers",
        "target": {
          "from": "node",
          "node": "build",
          "output": "code"
        },
        "reviews": {
          "from": "node",
          "node": "reviews",
          "output": "reviews"
        },
        "verification": {
          "from": "node",
          "node": "verify",
          "output": "verification"
        },
        "output": {
          "name": "decision",
          "kind": "decision"
        }
      }
    ],
    "edges": [
      {
        "from": "build",
        "to": "verify"
      },
      {
        "from": "verify",
        "to": "reviews"
      },
      {
        "from": "reviews",
        "to": "completion"
      }
    ]
  },
  "gate": "completion",
  "next": {
    "code": {
      "node": "build",
      "output": "code"
    },
    "decision": {
      "node": "completion",
      "output": "decision"
    }
  },
  "exports": {
    "code": {
      "node": "build",
      "output": "code"
    },
    "verification": {
      "node": "verify",
      "output": "verification"
    },
    "reviews": {
      "node": "reviews",
      "output": "reviews"
    },
    "decision": {
      "node": "completion",
      "output": "decision"
    }
  },
  "onLimit": "wait_for_user"
}
```

On the first iteration, `implement` creates the implementation from the approved plan. On later iterations it receives the prior code and completion decision, repairs findings, and publishes a new snapshot. Verification consumes that exact snapshot. Reviewers receive verification evidence, including failures; they cannot mark failed required checks green. An unavailable required check yields a blocked gate, not another blind repair iteration.

The builder submits a typed implementation report and owned-workspace reference. The engine computes the actual code snapshot; it does not accept a model-authored hash as proof of filesystem state. Engine task `verify` uses the accepted check-profile snapshot and effective permissions. The engine's output is a verification artifact, not an agent claim.

The Codex planner and Codex code reviewer are separate participants and sessions. Reusing a profile does not reuse the planner's private context for final code review.

## Review existing changes, optionally fix

For review-only, construct a workflow with these precise stages:

| Node | Execution | Inputs | Outputs |
| --- | --- | --- | --- |
| `capture` | Engine `capture_snapshot` | Accepted working-change selection | Immutable code snapshot |
| `reviews` | Parallel `review_code` over required reviewers | Requirements and captured code | Review collection |
| `deliver` | Finish with `review_complete` | Code and review collection | Report with findings and verification gaps |

Edges are `capture -> reviews -> deliver`. Review-only completion means the requested review was delivered; it does not imply approval of the code or passing tests. No builder role is assigned. Checks may be added only as an explicitly accepted engine stage/profile.

For `allowFixes: true`, first collect reviews on the existing snapshot. Then enter a bounded repair/check/review loop analogous to `build_review`, using `repair` rather than first-time `implement`, with the captured code and initial findings as loop state. If the initial review has no blocking findings, produce the requested result without launching a writer. This skip is a gate outcome edge, not an agent deciding to run an undeclared stage. Required verification still runs before claiming verified changes.

## Current Claude host with a managed Codex planner

1. Host submits the task and a candidate team through `codeflow_propose_team`.
2. Proposal binds plan review to the current connection only if its settings/capabilities fit; otherwise it selects a managed Claude reviewer and explains why.
3. User accepts the previewed revision through the supported confirmation path.
4. `codeflow_start_run` returns the durable run ID.
5. Codex produces a plan; `get_run` returns a ready host assignment.
6. Host claims the step and receives the plan reference, requirements, and token.
7. Host reads the plan artifact and submits structured findings or approval.
8. Code Flow either dispatches Codex revision or advances according to the gate.
9. Host retrieves and displays the agreed plan/result artifact.

If the host disconnects after step 6, the run waits. On explicit reattachment, the server reissues/reconciles the claim. A stale token cannot submit against a newer plan revision.

## Saving and reusing

“Save this as my Architecture team” stores portable profiles/team/workflow versions and policy defaults suitable for preview. It excludes task wording, captured files, host connection IDs, provider sessions, acceptance receipts, and completed artifacts.

“Use Architecture, but only two planners” creates a proposal override. It does not mutate the saved template. The proposal must resolve a valid reviewer roster and show the changed workflow cost/limits before acceptance.

“Build the plan we agreed yesterday” references the exact stored plan artifact. Recheck repository identity and relevant baseline changes. If the plan is stale, propose a review/update stage instead of silently implementing an outdated design.

## Nonconvergence example

Claude requires a migration strategy. Codex argues migration is outside the task. After the configured iterations, return both rationales, the affected requirement, and the latest plan. Ask the user whether migration is in scope. Record that answer as a requirement/decision revision, then resume only the affected work. Never fabricate unanimous approval because the loop ran out.
