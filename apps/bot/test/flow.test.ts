import { describe, expect, it } from "vitest";
import { botMessages, FlowManager, type FlowAction, type SourceFile } from "../src/flow.js";

const HOUR = 3_600_000;

function setup() {
  let nowMs = 1_000_000;
  const fm = new FlowManager({
    now: () => nowMs,
    ttlMs: HOUR,
    jobTimeoutMs: 40 * 60_000,
    maxJobsPerChatPerDay: 5,
    maxTitleChars: 200,
    maxPromptChars: 2000,
  });
  const file = (i: number): SourceFile => ({ path: `/tmp/f${i}`, filename: `f${i}.pdf` });
  /** Drive a chat through source → title → prompt; returns the createJob action. */
  const runToJob = (chatId: number): FlowAction => {
    const srcActs = fm.handleSource(chatId, [file(chatId)]);
    expect(srcActs).toEqual([{ type: "send", text: botMessages.askTitle }]);
    expect(fm.handleText(chatId, "عنوان")).toEqual([{ type: "send", text: botMessages.askPrompt }]);
    const acts = fm.handleText(chatId, "خلاصه کن");
    expect(acts.length).toBe(1);
    expect(acts[0]!.type).toBe("createJob");
    return acts[0]!;
  };
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  return { fm, file, runToJob, advance };
}

describe("flow state machine", () => {
  it("walks /start → file → title → prompt → SUBMITTED", () => {
    const { fm, runToJob } = setup();
    expect(fm.handleStart(1)).toEqual([{ type: "send", text: botMessages.welcome }]);
    const act = runToJob(1);
    expect(act).toMatchObject({ type: "createJob", title: "عنوان", prompt: "خلاصه کن" });
    if (act.type === "createJob") {
      expect(act.sources.map((s) => s.filename)).toEqual(["f1.pdf"]);
      expect(act.title).toBe("عنوان");
    }
    expect(fm.peekState(1)).toBe("SUBMITTED");
  });

  it("accepts plain text (as .txt) as a source from IDLE", () => {
    const { fm } = setup();
    expect(fm.peekState(9)).toBe("IDLE");
    const acts = fm.handleSource(9, [{ path: "/tmp/t", filename: "source-123.txt" }]);
    expect(acts).toEqual([{ type: "send", text: botMessages.askTitle }]);
    expect(fm.peekState(9)).toBe("WAIT_TITLE");
  });

  it("marks the job id on 201 (markSubmitted)", () => {
    const { fm, runToJob } = setup();
    runToJob(1);
    fm.markSubmitted(1, "j1");
    expect(fm.submittedFlows().map((f) => f.jobId)).toEqual(["j1"]);
    // The flow has a 40-min deadline from submission.
    const f = fm.submittedFlows()[0]!;
    expect(f.jobDeadline).toBe(f.jobSubmittedAt! + 40 * 60_000);
  });

  it("rejects a title over 200 chars and stays in WAIT_TITLE", () => {
    const { fm, file } = setup();
    fm.handleSource(1, [file(1)]);
    expect(fm.peekState(1)).toBe("WAIT_TITLE");
    expect(fm.handleText(1, "x".repeat(201))).toEqual([{ type: "send", text: botMessages.titleTooLong }]);
    expect(fm.peekState(1)).toBe("WAIT_TITLE");
    expect(fm.handleText(1, "عنوان")).toEqual([{ type: "send", text: botMessages.askPrompt }]);
  });

  it("rejects a prompt over 2000 chars and stays in WAIT_PROMPT", () => {
    const { fm, file } = setup();
    fm.handleSource(1, [file(1)]);
    fm.handleText(1, "عنوان");
    expect(fm.peekState(1)).toBe("WAIT_PROMPT");
    expect(fm.handleText(1, "x".repeat(2001))).toEqual([{ type: "send", text: botMessages.promptTooLong }]);
    expect(fm.peekState(1)).toBe("WAIT_PROMPT");
  });

  it("ignores files while asking for title/prompt (text only)", () => {
    const { fm, file } = setup();
    fm.handleSource(1, [file(1)]);
    expect(fm.handleSource(1, [file(2)])).toEqual([{ type: "send", text: botMessages.titleTextOnly }]);
    fm.handleText(1, "عنوان");
    expect(fm.handleSource(1, [file(3)])).toEqual([{ type: "send", text: botMessages.promptTextOnly }]);
  });

  it("cancels an in-progress flow and answers idle cancels politely", () => {
    const { fm, file } = setup();
    expect(fm.handleCancel(1)).toEqual([{ type: "send", text: botMessages.cancelIdle }]);
    fm.handleSource(1, [file(1)]);
    expect(fm.handleCancel(1)).toEqual([{ type: "send", text: botMessages.cancelledFlow }]);
    expect(fm.peekState(1)).toBe("IDLE");
  });

  it("cancels a submitted job via a cancelJob action", () => {
    const { fm, runToJob } = setup();
    runToJob(1);
    fm.markSubmitted(1, "j1");
    expect(fm.handleCancel(1)).toEqual([{ type: "cancelJob", jobId: "j1" }]);
    expect(fm.peekState(1)).toBe("SUBMITTED"); // stays until the cancel is confirmed
    fm.jobCancelled(1);
    expect(fm.peekState(1)).toBe("IDLE");
  });

  it("keeps one active flow per chat while SUBMITTED", () => {
    const { fm, runToJob, file } = setup();
    runToJob(1);
    fm.markSubmitted(1, "j1");
    expect(fm.handleSource(1, [file(2)])).toEqual([{ type: "send", text: botMessages.busy }]);
    expect(fm.handleText(1, "متن جدید")).toEqual([{ type: "send", text: botMessages.busy }]);
    expect(fm.handleUnsupported(1)).toEqual([{ type: "send", text: botMessages.busy }]);
    expect(fm.handleStart(1)).toEqual([{ type: "send", text: botMessages.busy }]);
    // Another chat is unaffected.
    expect(fm.handleSource(2, [file(3)])[0]).toMatchObject({ text: botMessages.askTitle });
  });

  it("enforces the 5 jobs / 24 h limit per chat, then allows again after the window", () => {
    const { fm, runToJob, advance, file } = setup();
    for (let i = 0; i < 5; i++) {
      const act = runToJob(1);
      expect(act.type).toBe("createJob");
      fm.markSubmitted(1, `j${i}`);
      fm.jobDone(1);
    }
    // 6th attempt inside the same window:
    fm.handleSource(1, [file(6)]);
    fm.handleText(1, "عنوان");
    expect(fm.handleText(1, "سوال")).toEqual([{ type: "send", text: botMessages.limit }]);
    expect(fm.peekState(1)).toBe("IDLE");

    // After the 24 h window slides, a new job is allowed.
    advance(25 * 60 * 60_000);
    expect(runToJob(1).type).toBe("createJob");
  });

  it("rolls back the quota when the submit fails", () => {
    const { fm, runToJob } = setup();
    for (let i = 0; i < 4; i++) {
      runToJob(1);
      fm.markSubmitted(1, `j${i}`);
      fm.jobDone(1);
    }
    const act = runToJob(1); // 5th: allowed
    expect(act.type).toBe("createJob");
    fm.onJobSubmitFailed(1); // API down → rolled back
    expect(fm.peekState(1)).toBe("IDLE");
    expect(runToJob(1).type).toBe("createJob"); // 5th retry: still allowed
  });

  it("resets idle flows after the TTL", () => {
    const { fm, file, advance } = setup();
    fm.handleSource(1, [file(1)]);
    expect(fm.peekState(1)).toBe("WAIT_TITLE");
    advance(HOUR + 1);
    expect(fm.peekState(1)).toBe("IDLE");
    expect(fm.handleText(1, "متن")).toEqual([{ type: "send", text: botMessages.hintSource }]);
  });

  it("sweep() resets expired flows and returns them for temp-file cleanup", () => {
    const { fm, file, advance } = setup();
    fm.handleSource(1, [file(1)]);
    advance(HOUR + 1);
    const affected = fm.sweep();
    expect(affected.map((f) => f.chatId)).toEqual([1]);
    expect(fm.peekState(1)).toBe("IDLE");
  });

  it("answers unsupported content types politely", () => {
    const { fm } = setup();
    expect(fm.handleUnsupported(1)).toEqual([{ type: "send", text: botMessages.onlyFileOrText }]);
    expect(fm.peekState(1)).toBe("IDLE");
  });

  it("accepts multiple files across messages up to the source cap", () => {
    const { fm, file } = setup();
    fm.handleSource(1, [file(1), file(2), file(3)]);
    const f = fm.flowFor(1);
    expect(f.sources.length).toBe(3);
  });
});
