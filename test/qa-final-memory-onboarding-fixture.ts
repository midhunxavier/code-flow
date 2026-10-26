export const onboardingExamples = [
  { title: "A Notify outside the condition", body: "Use this notification example:\n\n```python\nif ready:\n    deploy()\nnotify()\n```" },
  { title: "B Notify inside the condition", body: "Use this notification example:\n\n```python\nif ready:\n    deploy()\n    notify()\n```" },
  { title: "C Single space literal", body: 'The exact fixture payload is `"left right"`.' },
  { title: "D Double space literal", body: 'The exact fixture payload is `"left  right"`.' },
];

export const onboardingScopeExamples = [
  { title: "E Current branch guidance", body: "Keep deployment notes accurate.", applicability: { kind: "branch", branch: "main" } },
  { title: "F Repository wide guidance", body: "Keep deployment notes accurate.", applicability: { kind: "repository" } },
  { title: "G Readme guidance", body: "Include the fixture name in examples.", paths: ["README.md"] },
  { title: "H Config guidance", body: "Include the fixture name in examples.", paths: ["config.txt"] },
];

export const literalMemoryPaths = ["[config](notes).txt", "`ticks`.txt", "```triple```.txt", "line\n```fence\nend.txt"];
