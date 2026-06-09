#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");

const repoRoot = path.resolve(__dirname, "..");
const interfacePath = path.join(
  repoRoot,
  "src",
  "components",
  "NativelyInterface.tsx",
);
const source = fs.readFileSync(interfacePath, "utf8");

const requiredTestIds = [
  "natively-overlay-panel",
  "natively-assist-layout",
  "natively-context-section",
  "natively-live-transcript-panel",
  "natively-chat-scroll",
  "natively-command-dock",
  "natively-attached-screenshot-strip",
  "natively-command-input",
  "natively-command-send",
  "natively-action-what-to-answer",
  "natively-action-clarify",
  "natively-action-dynamic",
  "natively-action-follow-up",
  "natively-action-answer",
  "natively-action-tools",
  "natively-secondary-controls",
];

const missingTestIds = requiredTestIds.filter(
  (id) => !source.includes(`data-testid="${id}"`),
);

if (missingTestIds.length > 0) {
  console.error("Overlay DOM stress guard failed: missing test ids");
  for (const id of missingTestIds) {
    console.error(`- ${id}`);
  }
  process.exit(1);
}

if (!/const shouldShowRollingTranscript =[\s\S]*!hasActionConversation[\s\S]*\(\(showTranscript && rollingTranscript\) \|\| hasSttConnectionIssue\)/.test(source)) {
  console.error(
    "Overlay DOM stress guard failed: rolling transcript and reconnect status must not duplicate the conversation transcript panel.",
  );
  process.exit(1);
}

const messageHtml = Array.from({ length: 42 }, (_, index) => {
  const role = index % 4 === 0 ? "user" : "system";
  const text =
    role === "user"
      ? `Question utilisateur ${index + 1} avec un texte long pour tester le scroll.`
      : `Réponse IA ${index + 1}. Cette réponse contient assez de contenu pour occuper la zone de chat sans pousser l'input hors de l'écran.`;
  return `<div class="message ${role}">${text}</div>`;
}).join("");

const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1f2937;
      }
      body {
        display: flex;
        justify-content: center;
        align-items: stretch;
        background: #dbeafe;
      }
      [data-testid="natively-root"] {
        width: 760px;
        height: 680px;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .top-pill {
        height: 56px;
        flex: 0 0 auto;
      }
      [data-testid="natively-overlay-panel"] {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        border: 1px solid rgba(96, 165, 250, 0.4);
        border-radius: 24px;
        background: rgba(219, 234, 254, 0.9);
      }
      [data-testid="natively-assist-layout"] {
        min-height: 0;
        height: 100%;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        overflow: hidden;
      }
      [data-testid="natively-context-section"] {
        min-height: 0;
        max-height: 96px;
        overflow: hidden;
        padding-top: 4px;
      }
      [data-testid="natively-live-transcript-panel"] {
        margin: 4px 16px 4px;
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 12px;
        background: rgba(248, 250, 252, 0.72);
        padding: 8px 12px;
        line-height: 1.25;
        max-height: 84px;
      }
      [data-testid="natively-secondary-controls"] {
        display: none;
      }
      [data-testid="natively-chat-scroll"] {
        min-height: 0;
        height: 100%;
        max-height: 100%;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 8px 16px;
        scroll-padding-bottom: 112px;
      }
      .message {
        margin: 0 0 8px;
        padding: 10px 12px;
        line-height: 1.38;
        font-size: 14px;
      }
      .message.system {
        width: 100%;
        border-radius: 12px;
        background: rgba(248, 250, 252, 0.76);
      }
      .message.user {
        width: max-content;
        max-width: 72%;
        margin-left: auto;
        border-radius: 18px 4px 18px 18px;
        background: rgba(59, 130, 246, 0.12);
      }
      .answer-card {
        width: 100%;
        max-height: min(20vh, 190px);
        overflow-y: auto;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 12px;
        background: rgba(248, 250, 252, 0.86);
        padding: 14px 16px;
      }
      [data-testid="natively-command-dock"] {
        position: sticky;
        bottom: 0;
        min-height: 88px;
        max-height: 148px;
        overflow-y: auto;
        border-top: 1px solid rgba(148, 163, 184, 0.35);
        background: rgba(219, 234, 254, 0.94);
        position: relative;
        z-index: 20;
      }
      .dock-inner {
        padding: 8px 12px;
      }
      [data-testid="natively-attached-screenshot-strip"] {
        min-height: 34px;
        margin-bottom: 6px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 8px;
        padding: 6px 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: hidden;
        background: rgba(248, 250, 252, 0.74);
      }
      [data-testid="natively-attached-screenshot-strip"] img {
        width: 42px;
        height: 28px;
        object-fit: cover;
        border-radius: 6px;
        flex: 0 0 auto;
      }
      .input-wrap {
        position: relative;
      }
      [data-testid="natively-command-input"] {
        width: 100%;
        height: 40px;
        border-radius: 12px;
        border: 1px solid rgba(148, 163, 184, 0.35);
        padding: 0 42px 0 12px;
        font-size: 13px;
      }
      [data-testid="natively-command-send"] {
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 8px;
        background: #007aff;
        color: white;
      }
      .actions {
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        gap: 6px;
        overflow-x: auto;
        padding-bottom: 4px;
        margin-top: 6px;
      }
      .actions button {
        flex: 0 0 auto;
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 999px;
        background: rgba(248, 250, 252, 0.9);
        color: #1f2937;
        padding: 7px 10px;
        font-size: 10.5px;
        white-space: nowrap;
      }
      .tools-open [data-testid="natively-secondary-controls"] {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 6px;
        min-height: 30px;
      }
      .secondary-pill {
        width: 132px;
        height: 28px;
        border-radius: 8px;
        background: rgba(248, 250, 252, 0.85);
      }
    </style>
  </head>
  <body>
    <div data-testid="natively-root">
      <div class="top-pill"></div>
      <section data-testid="natively-overlay-panel">
        <div data-testid="natively-assist-layout">
          <div data-testid="natively-context-section">
            <div data-testid="natively-live-transcript-panel">
              <strong>Live transcript</strong>
              <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                Speaker: Dernier propos gardé visible sans rail compacte corrompue.
              </div>
            </div>
          </div>
          <main data-testid="natively-chat-scroll">
            ${messageHtml}
            <div class="answer-card">
              <strong>Follow-up questions</strong>
              <p>Quels sont les principaux points à clarifier maintenant ?</p>
              <p>Quel exemple concret peut-on demander sans rompre le rythme ?</p>
              <p>Quelle décision doit être verrouillée avant de passer au sujet suivant ?</p>
            </div>
              </main>
              <footer data-testid="natively-command-dock">
                <div class="dock-inner">
                  <div data-testid="natively-attached-screenshot-strip">
                    <span>1 screenshot attached</span>
                    <img alt="Screenshot 1" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='84' height='56'%3E%3Crect width='84' height='56' fill='%23007aff'/%3E%3C/svg%3E" />
                    <button aria-label="Remove all screenshots">×</button>
                  </div>
                  <div class="input-wrap">
                <input data-testid="natively-command-input" value="" placeholder="Ask anything on screen or conversation" />
                <button data-testid="natively-command-send" aria-disabled="false">→</button>
              </div>
              <div class="actions">
                <button data-testid="natively-action-what-to-answer">What to say</button>
                <button data-testid="natively-action-clarify">Clarify</button>
                <button data-testid="natively-action-dynamic">Brainstorm</button>
                <button data-testid="natively-action-follow-up">Follow Up</button>
                <button data-testid="natively-action-answer">Answer</button>
                <button data-testid="natively-action-tools" onclick="document.body.classList.toggle('tools-open')">Tools</button>
              </div>
              <div data-testid="natively-secondary-controls">
                <div class="secondary-pill"></div>
                <div class="secondary-pill"></div>
                <div class="secondary-pill"></div>
              </div>
            </div>
          </footer>
        </div>
      </section>
    </div>
  </body>
</html>`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function box(page, testId) {
  const locator = page.getByTestId(testId);
  const bounds = await locator.boundingBox();
  assert(bounds, `${testId} has no bounding box`);
  return { locator, bounds };
}

async function assertInViewport(page, testId) {
  const viewport = page.viewportSize();
  const { locator, bounds } = await box(page, testId);
  const details = `${testId} bounds=${JSON.stringify(bounds)} viewport=${JSON.stringify(viewport)}`;
  const top = bounds.y;
  const bottom = bounds.y + bounds.height;
  const left = bounds.x;
  const right = bounds.x + bounds.width;
  assert(top >= -0.5, `${details} is above the viewport`);
  assert(
    bottom <= viewport.height + 0.5,
    `${details} is below the viewport`,
  );
  assert(left >= -0.5, `${details} is left of the viewport`);
  assert(
    right <= viewport.width + 0.5,
    `${details} is right of the viewport`,
  );
  await locator.click({ trial: true });
  return { ...bounds, top, bottom, left, right };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 680 } });

  try {
    await page.setContent(html);

    const transcriptPanel = await box(page, "natively-live-transcript-panel");
    assert(
      transcriptPanel.bounds.height <= 96,
      `live transcript panel is too tall: ${transcriptPanel.bounds.height}px`,
    );

    const transcriptVisible = await page
      .getByTestId("natively-live-transcript-panel")
      .isVisible();
    assert(transcriptVisible, "live transcript must stay visible while chatting");

    const chatMetrics = await page.getByTestId("natively-chat-scroll").evaluate(
      (element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }),
    );
    assert(
      chatMetrics.scrollHeight > chatMetrics.clientHeight,
      "chat pane must own overflow for long conversations",
    );

    const firstMessageOffset = await page.getByTestId("natively-chat-scroll").evaluate(
      (element) => {
        const first = element.querySelector(".message");
        if (!(first instanceof HTMLElement)) return Infinity;
        return first.getBoundingClientRect().top - element.getBoundingClientRect().top;
      },
    );
    assert(
      firstMessageOffset < 32,
      `conversation content should start near the top, got ${firstMessageOffset}px`,
    );

    await assertInViewport(page, "natively-attached-screenshot-strip");
    const screenshotStrip = await box(page, "natively-attached-screenshot-strip");
    assert(
      screenshotStrip.bounds.height <= 44,
      `attached screenshot strip is too tall: ${screenshotStrip.bounds.height}px`,
    );

    const inputBefore = await assertInViewport(page, "natively-command-input");
    await assertInViewport(page, "natively-command-send");
    const sendDisabled = await page
      .getByTestId("natively-command-send")
      .evaluate((element) => element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true");
    assert(!sendDisabled, "send button must stay active with an attached screenshot");
    await page.getByTestId("natively-command-input").focus();
    const focusedInput = await page
      .getByTestId("natively-command-input")
      .evaluate((element) => document.activeElement === element);
    assert(focusedInput, "command input must remain focusable with an attached screenshot");
    await assertInViewport(page, "natively-action-what-to-answer");
    await assertInViewport(page, "natively-action-clarify");
    await assertInViewport(page, "natively-action-follow-up");
    await assertInViewport(page, "natively-action-answer");
    await assertInViewport(page, "natively-action-tools");

    const panel = await box(page, "natively-overlay-panel");
    const dock = await box(page, "natively-command-dock");
    const panelBottom = panel.bounds.y + panel.bounds.height;
    const dockBottom = dock.bounds.y + dock.bounds.height;
    assert(
      dockBottom <= panelBottom + 0.5,
      "command dock escapes the overlay panel",
    );

    await page.getByTestId("natively-chat-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
    await assertInViewport(page, "natively-command-input");

    await page.getByTestId("natively-chat-scroll").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const inputAfter = await assertInViewport(page, "natively-command-input");
    assert(
      Math.abs(inputBefore.top - inputAfter.top) < 1,
      "input should remain pinned while chat scrolls",
    );

    await page.getByTestId("natively-attached-screenshot-strip").evaluate((element) => {
      element.remove();
    });
    await page.getByTestId("natively-action-tools").click();
    await assertInViewport(page, "natively-secondary-controls");
    await assertInViewport(page, "natively-command-input");
    await assertInViewport(page, "natively-action-clarify");
    await assertInViewport(page, "natively-action-answer");
  } finally {
    await browser.close();
  }

  console.log("Overlay DOM stress guard passed.");
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
