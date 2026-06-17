#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const selectorPath = path.join(
  repoRoot,
  "src",
  "components",
  "ui",
  "ModelSelector.tsx",
);
const source = fs.readFileSync(selectorPath, "utf8");

const failures = [];

const requiredPatterns = [
  {
    name: "trigger button has explicit light and dark text/background colors",
    pattern:
      /bg-white\/95 text-slate-950[\s\S]*dark:bg-\[#15171c\]\/95 dark:text-white/,
  },
  {
    name: "dropdown surface has explicit light and dark text/background colors",
    pattern:
      /bg-white text-slate-950[\s\S]*dark:bg-\[#15171c\] dark:text-slate-50/,
  },
  {
    name: "dropdown is portaled to body so fixed positioning is not trapped by transformed overlay parents",
    pattern:
      /import \{ createPortal \} from 'react-dom';[\s\S]*createPortal\([\s\S]*document\.body/,
  },
  {
    name: "tabs have explicit selected colors and preserve idle-tab visibility rules when tabs are available",
    pattern:
      /border-t-emerald-500 bg-white[\s\S]*text-emerald-600[\s\S]*dark:bg-\[#1d2027\][\s\S]*dark:text-emerald-300[\s\S]*(?:text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white|Cloud)/,
  },
  {
    name: "model names remain visible in light and dark modes",
    pattern:
      /text-slate-950 dark:text-slate-50[\s\S]*text-slate-500 dark:text-slate-400/,
  },
  {
    name: "selected option has explicit visible check color",
    pattern: /text-emerald-600 dark:text-emerald-300/,
  },
];

for (const check of requiredPatterns) {
  if (!check.pattern.test(source)) failures.push(check.name);
}

const ambiguousThemeTokens = [
  "bg-bg-input",
  "bg-bg-item-surface",
  "bg-bg-elevated",
  "text-text-primary",
  "text-text-secondary",
  "text-text-tertiary",
  "text-accent-primary",
  "bg-accent-primary",
  "border-border-subtle",
];

for (const token of ambiguousThemeTokens) {
  if (source.includes(token)) {
    failures.push(`ambiguous theme token still used: ${token}`);
  }
}

if (failures.length > 0) {
  console.error("Model selector visibility guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Model selector visibility guard passed (${requiredPatterns.length} checks).`,
);
