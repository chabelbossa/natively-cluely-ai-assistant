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
const windowHelperPath = path.join(repoRoot, "electron", "WindowHelper.ts");

const source = fs.readFileSync(interfacePath, "utf8");
const windowHelperSource = fs.readFileSync(windowHelperPath, "utf8");

const checks = [
  {
    name: "overlay height is a fixed preferred target instead of self-locking to the current compact viewport",
    pattern: /style=\{\{ height: preferredOverlayHeight \}\}/,
  },
  {
    name: "preferred overlay height uses screen height before current window height",
    pattern:
      /const screenHeight =[\s\S]*window\.screen\?\.availHeight[\s\S]*document\.documentElement\.clientHeight[\s\S]*window\.innerHeight/,
  },
  {
    name: "top transcript area is bounded in action mode",
    pattern:
      /const topSectionMaxHeight = isConversationFocusMode[\s\S]*"min\(12vh, 96px\)"[\s\S]*copilotSuggestion[\s\S]*"min\(15vh, 144px\)"/,
  },
  {
    name: "corrupt compact context rail has been removed",
    pattern:
      /data-testid="natively-live-transcript-panel"[\s\S]*data-testid="natively-chat-scroll"/,
  },
  {
    name: "rolling transcript, including reconnect status, is hidden while an action conversation is active",
    pattern:
      /const shouldShowRollingTranscript =[\s\S]*!hasActionConversation[\s\S]*\(\(showTranscript && rollingTranscript\) \|\| hasSttConnectionIssue\)/,
  },
  {
    name: "live transcript uses compact paging while chatting",
    pattern:
      /const transcriptPageSize = hasActionConversation[\s\S]*isTranscriptExpanded[\s\S]*\? 2[\s\S]*: 1/,
  },
  {
    name: "live transcript viewport is capped tightly while chatting",
    pattern:
      /const transcriptViewportMaxHeight = hasActionConversation[\s\S]*isTranscriptExpanded[\s\S]*\? "min\(8vh, 72px\)"[\s\S]*: "34px"/,
  },
  {
    name: "conversation focus keeps the live transcript panel available",
    pattern:
      /\{hasLiveTranscript && \([\s\S]*data-testid="natively-live-transcript-panel"/,
  },
  {
    name: "full transcript is no longer hidden behind the compact rail",
    pattern: /\{hasLiveTranscript && \(/,
  },
  {
    name: "action messages force latest response into view",
    pattern:
      /const shouldKeepLatestVisible =[\s\S]*lastMessage\?\.role === "user"[\s\S]*Boolean\(lastMessage\?\.intent\)[\s\S]*scrollMessagesToBottom\([\s\S]*shouldKeepLatestVisible \? "auto" : "smooth"[\s\S]*shouldKeepLatestVisible/,
  },
  {
    name: "main assist layout uses fixed rows so the command dock cannot be pushed away",
    pattern:
      /data-testid="natively-assist-layout"[\s\S]*className="flex-1 min-h-0 no-drag grid grid-rows-\[auto_minmax\(0,1fr\)_auto\] overflow-hidden"/,
  },
  {
    name: "conversation pane owns the remaining scrollable space",
    pattern:
      /data-testid="natively-chat-scroll"[\s\S]*className="min-h-0 h-full max-h-full overflow-y-auto overscroll-contain no-drag px-4 py-2 scroll-pb-28"/,
  },
  {
    name: "conversation messages start at the top to avoid artificial blank space",
    pattern: /className="min-h-full flex flex-col justify-start gap-1\.5 pb-3 no-drag"/,
  },
  {
    name: "bottom action dock remains capped, minimum-sized, and visible",
    pattern:
      /data-testid="natively-command-dock"[\s\S]*className="sticky bottom-0 shrink-0 min-h-\[88px\] max-h-\[148px\] overflow-y-auto border-t no-drag overlay-shell-surface z-20"/,
  },
  {
    name: "input is rendered before quick actions in the command dock",
    pattern: /\{\/\* Input Area \*\/\}[\s\S]*\{\/\* Quick Actions - pinned below input so typing never disappears \*\/\}/,
  },
  {
    name: "send button is embedded in the input so secondary controls can collapse",
    pattern:
      /data-testid="natively-command-send"[\s\S]*onClick=\{handleManualSubmit\}[\s\S]*title="Send"[\s\S]*<ArrowRight className="w-3\.5 h-3\.5" \/>/,
  },
  {
    name: "attached screenshot strip stays compact so the text input remains visible",
    pattern:
      /data-testid="natively-attached-screenshot-strip"[\s\S]*min-h-\[34px\][\s\S]*className=\{`h-7 w-auto rounded border/,
  },
  {
    name: "screenshot attachment keeps command input focus for typing",
    pattern:
      /const handleScreenshotAttach[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*textInputRef\.current\?\.focus\(\)/,
  },
  {
    name: "send button accepts image-only or image-plus-text submissions",
    pattern:
      /data-testid="natively-command-send"[\s\S]*disabled=\{!inputValue\.trim\(\) && attachedContext\.length === 0\}[\s\S]*inputValue\.trim\(\) \|\| attachedContext\.length > 0/,
  },
  {
    name: "AI answer cards scroll internally instead of pushing the dock",
    pattern: /maxHeight: "min\(20vh, 190px\)"[\s\S]*overflowY: "auto"/,
  },
  {
    name: "quick action buttons scroll horizontally instead of wrapping",
    pattern: /flex flex-nowrap justify-start items-center gap-1\.5 overflow-x-auto/,
  },
  {
    name: "secondary model and settings controls collapse during conversation focus",
    pattern:
      /\{\(!isConversationFocusMode \|\| isCommandToolsOpen\) && \([\s\S]*data-testid="natively-secondary-controls"/,
  },
  {
    name: "conversation focus exposes tools only behind an explicit toggle",
    pattern:
      /isConversationFocusMode && \([\s\S]*data-testid="natively-action-tools"[\s\S]*setIsCommandToolsOpen[\s\S]*Show model and settings controls/,
  },
  {
    name: "critical overlay regions have stable DOM test hooks",
    pattern:
      /data-testid="natively-overlay-panel"[\s\S]*data-testid="natively-context-section"[\s\S]*data-testid="natively-command-input"[\s\S]*data-testid="natively-action-what-to-answer"[\s\S]*data-testid="natively-action-clarify"[\s\S]*data-testid="natively-action-follow-up"[\s\S]*data-testid="natively-action-answer"/,
  },
  {
    name: "proactive copilot suggestion does not steal space during active conversations",
    pattern:
      /\{copilotSuggestion\?\.suggestion && !isConversationFocusMode && \(/,
  },
  {
    name: "autopilot quality card is hidden once conversation mode is active",
    pattern: /\{copilotQuality && !hasActionConversation && \(/,
  },
  {
    name: "free-form text questions use the meeting context action pipeline",
    pattern:
      /const useMeetingContextAnswer = currentAttachments\.length === 0[\s\S]*window\.electronAPI\.submitManualQuestion/,
  },
  {
    name: "manual meeting answers settle the existing input card instead of appending duplicates",
    pattern:
      /onIntelligenceManualResult[\s\S]*settleActionMessage\(prev, "manual", data\.answer/,
  },
  {
    name: "intelligence listeners survive hide/show while actions are in flight",
    pattern:
      /These listeners must survive Hide\/Show while an action is in flight[\s\S]*}, \[\]\);/,
  },
];

const failures = checks.filter((check) => !check.pattern.test(source));

const forbiddenChecks = [
  {
    name: "corrupt compact meeting health strip must stay removed",
    pattern: /CompactMeetingHealthStrip|meetingHealth|setMeetingHealth|getMeetingHealth/,
  },
];

for (const check of forbiddenChecks) {
  if (check.pattern.test(source)) {
    failures.push(check);
  }
}

const windowHelperChecks = [
  {
    name: "overlay main process has a useful visible-height floor",
    pattern:
      /private getOverlayVisibleHeight\(workArea: Electron\.Rectangle\): number \{[\s\S]*OVERLAY_MIN_USEFUL_HEIGHT[\s\S]*OVERLAY_TARGET_MAX_HEIGHT/,
  },
  {
    name: "overlay resize requests cannot shrink the visible meeting surface",
    pattern:
      /const minVisibleHeight = this\.getOverlayVisibleHeight\(workArea\)[\s\S]*const newHeight = Math\.min\(Math\.max\(height, minVisibleHeight\), maxAllowedHeight\)/,
  },
  {
    name: "switching back to overlay refuses compact restored bounds",
    pattern:
      /const minVisibleHeight = this\.getOverlayVisibleHeight\(workArea\)[\s\S]*height: Math\.min\(Math\.max\(savedBounds\.height, minVisibleHeight\), maxAllowedHeight\)/,
  },
];

failures.push(
  ...windowHelperChecks.filter((check) => !check.pattern.test(windowHelperSource)),
);

if (failures.length > 0) {
  console.error("Overlay layout guard failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(
  `Overlay layout guard passed (${checks.length + windowHelperChecks.length} checks).`,
);
