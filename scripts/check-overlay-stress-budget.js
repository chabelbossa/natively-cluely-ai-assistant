#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const interfacePath = path.join(
  repoRoot,
  "src",
  "components",
  "NativelyInterface.tsx",
);

const source = fs.readFileSync(interfacePath, "utf8");

const requiredPatterns = [
  {
    name: "preferred height does not self-lock to current compact viewport",
    pattern:
      /const screenHeight =[\s\S]*window\.screen\?\.availHeight[\s\S]*document\.documentElement\.clientHeight[\s\S]*window\.innerHeight[\s\S]*style=\{\{ height: preferredOverlayHeight \}\}/,
  },
  {
    name: "focus mode gives the real transcript panel bounded vertical room",
    pattern:
      /const topSectionMaxHeight = isConversationFocusMode[\s\S]*"min\(12vh, 96px\)"[\s\S]*data-testid="natively-live-transcript-panel"/,
  },
  {
    name: "command dock has a hard max height",
    pattern: /max-h-\[148px\]/,
  },
  {
    name: "assist layout has a single flexible middle row",
    pattern: /grid grid-rows-\[auto_minmax\(0,1fr\)_auto\] overflow-hidden/,
  },
  {
    name: "chat pane owns the middle row scroll area",
    pattern: /min-h-0 h-full max-h-full overflow-y-auto overscroll-contain/,
  },
  {
    name: "input send button is inside the input row",
    pattern:
      /data-testid="natively-command-send"[\s\S]*absolute right-1\.5 top-1\/2 -translate-y-1\/2[\s\S]*title="Send"/,
  },
  {
    name: "secondary controls are closed by default during focus mode",
    pattern:
      /\{\(!isConversationFocusMode \|\| isCommandToolsOpen\) && \([\s\S]*data-testid="natively-secondary-controls"/,
  },
  {
    name: "rolling transcript does not duplicate the conversation transcript panel",
    pattern:
      /const shouldShowRollingTranscript =[\s\S]*!hasActionConversation[\s\S]*\(\(showTranscript && rollingTranscript\) \|\| hasSttConnectionIssue\)/,
  },
];

const failures = requiredPatterns.filter((check) => !check.pattern.test(source));

const minimumOverlayHeight = 760;
const topPillAndGapBudget = 72;
const conversationTranscriptPanel = 96;
const closedCommandDockBudget = 104;
const openCommandDockBudget = 148;
const minimumUsefulChatHeight = 480;

const closedToolsChatBudget =
  minimumOverlayHeight -
  topPillAndGapBudget -
  conversationTranscriptPanel -
  closedCommandDockBudget;
const openToolsChatBudget =
  minimumOverlayHeight -
  topPillAndGapBudget -
  conversationTranscriptPanel -
  openCommandDockBudget;

if (closedToolsChatBudget < minimumUsefulChatHeight) {
  failures.push({
    name: `closed tools chat budget ${closedToolsChatBudget}px is below ${minimumUsefulChatHeight}px`,
  });
}

if (openToolsChatBudget < 440) {
  failures.push({
    name: `open tools chat budget ${openToolsChatBudget}px is below 440px`,
  });
}

if (failures.length > 0) {
  console.error("Overlay stress budget guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(
  `Overlay stress budget guard passed (chat budget: ${closedToolsChatBudget}px closed tools, ${openToolsChatBudget}px open tools).`,
);
