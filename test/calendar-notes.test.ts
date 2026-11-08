// test/calendar-notes.test.ts — the meeting card's notes, LIGHTLY cleaned (redesign C, "The shown notes are lightly
// cleaned", steps 0-7; wave-2 plan C-M1-T3). Unlike the morning's description cleaning, newlines are kept and links
// are removed (Join is its own button) rather than written as "<host> link"; the label rule still catches a label and
// its value split by a newline. The morning's rules are reused from src/calendar/clean.ts by export, unchanged
// (test/calendar-clean.test.ts runs unmodified beside this file).
import { test, expect, describe } from "bun:test";
import { CAL_NOTES_MAX, cleanNotes } from "../src/calendar/notes";
import { REDACTION } from "../src/transcripts/credentials";
import { INVITE_CORPUS } from "./fixtures/calendar/invite-corpus";

describe("the label rule across a newline and doubled spaces, after NFKC", () => {
  test("\"Passcode:\\n99887766\" and \"PIN:  1234\" are redacted", () => {
    expect(cleanNotes("Passcode:\n99887766")).toBe(`Passcode: ${REDACTION}`);
    expect(cleanNotes("PIN:  1234")).toBe(`PIN: ${REDACTION}`);
    expect(cleanNotes("Agenda\nPasscode:\n\n  99887766\nThanks")).toBe(`Agenda\nPasscode: ${REDACTION}\nThanks`);
    expect(cleanNotes("Password is\nZZhunter2")).toBe(`Password is ${REDACTION}`);
    expect(cleanNotes("Meeting ID\r\n845 1234 5678")).toBe(`Meeting ID ${REDACTION}`);
  });
  test("full-width spellings fold first (NFKC), so the label and the digits meet the rule as ASCII", () => {
    expect(cleanNotes("ＰＩＮ：１２３４")).not.toContain("1234");
    expect(cleanNotes("ＰＩＮ：１２３４")).toContain(REDACTION);
    expect(cleanNotes("Passcode：\n９９８８")).toBe(`Passcode: ${REDACTION}`);
  });
  test("a label followed by an ordinary word on the next line keeps its newline", () => {
    expect(cleanNotes("Pin\nthe agenda to the wall")).toBe("Pin\nthe agenda to the wall");
    expect(cleanNotes("Password reset\nmeeting at 10")).toBe("Password reset\nmeeting at 10");
  });
});

describe("the steps", () => {
  test("<br> becomes a newline, then HTML is stripped and entities decoded; other newlines stay", () => {
    expect(cleanNotes("a<br>b<BR/>c<br />d")).toBe("a\nb\nc\nd");
    expect(cleanNotes("Bring <b>screenshots</b> &amp; notes.<br>Line two")).toBe("Bring screenshots & notes.\nLine two");
    expect(cleanNotes("Line one\nLine two\r\nLine three")).toBe("Line one\nLine two\nLine three");
  });
  test("control and invisible characters go, newlines stay, horizontal whitespace collapses within each line", () => {
    expect(cleanNotes("a\u0000b​c‮d\u{e0041}e")).toBe("abcde");
    expect(cleanNotes("  one \t  two  \n\n\n\n   three   ")).toBe("one two\n\nthree");
  });
  test("the boilerplate cut on the invite corpus: every secret and the boilerplate gone, the organiser's text kept", () => {
    for (const c of INVITE_CORPUS) {
      const out = cleanNotes(c.description);
      for (const g of c.gone) expect(`${c.name}: ${out.includes(g) ? g : "gone"}`).toBe(`${c.name}: gone`);
      // The corpus's kept strings, except the morning's "<host> link" spellings (notes remove links instead).
      for (const k of c.kept.filter((k) => !/ link\b/.test(k))) expect(`${c.name}: ${out.includes(k) ? "kept" : out}`).toBe(`${c.name}: kept`);
      expect(out.length).toBeLessThanOrEqual(CAL_NOTES_MAX);
    }
  });
  test("links are removed, not written as \"<host> link\"; the words around them stay", () => {
    const out = cleanNotes("Doc: https://docs.google.com/document/d/ZZdoc/edit. Room zoom.us/j/123456 or www.example.com\nmeet.google.com/abc-defg-hij then talk");
    expect(out).not.toMatch(/https?:|docs\.google|ZZdoc|zoom\.us|example\.com|meet\.google|abc-defg/);
    expect(out).not.toContain(" link");
    expect(out).toContain("Doc:");
    expect(out).toContain("Room");
    expect(out.split("\n").length).toBe(2);
    // The encoded and backslash spellings the morning's URL rule knows are removed too.
    expect(cleanNotes("see https%3A%2F%2Fevil.example%2Fx and https:\\\\evil.example\\path end")).toBe("see and end");
  });
  test("non-http scheme links are removed from notes", () => {
    expect(cleanNotes("Before zoommtg://zoom.us/join?confno=1&pwd=x after")).toBe("Before after");
  });
  test("capped at about 600 characters at a word boundary", () => {
    const out = cleanNotes(`${"word ".repeat(300)}end`);
    expect(out.length).toBeLessThanOrEqual(CAL_NOTES_MAX);
    expect(out.endsWith("word…")).toBe(true);
    expect(CAL_NOTES_MAX).toBe(600);
  });
  test("redactCredentials runs last", () => {
    const key = `sk-ant-api03-${"A".repeat(40)}`;
    expect(cleanNotes(`token ${key}\nnext`)).not.toContain(key);
  });
  test("empty, whitespace-only and all-boilerplate notes come back empty", () => {
    expect(cleanNotes("")).toBe("");
    expect(cleanNotes(" \n\t\n ")).toBe("");
    expect(cleanNotes("Join Zoom Meeting\nhttps://zoom.us/j/1")).toBe("");
  });
  test("linear on hostile input", () => {
    const t0 = performance.now();
    cleanNotes("Passcode:\n".repeat(20_000));
    cleanNotes("<br>".repeat(50_000));
    cleanNotes("https://x".repeat(20_000));
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
