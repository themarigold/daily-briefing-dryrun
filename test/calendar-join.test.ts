// test/calendar-join.test.ts — Join candidates from an event's RAW details (redesign C, "Join links"; wave-2 plan
// C-M2-T4). The engine extracts; Rust validates again before opening (C-M3-T9).
//
// UNVERIFIED: the five services' join-URL host patterns (source: C spec). They are pinned here to the hosts the spec
// names (whereby.com, meet.jit.si, meet.goto.com, global.gotomeeting.com, bluejeans.com, chime.aws), each with its
// subdomains; no real invite of theirs was read.
import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import {
  candidateMeetingKey, joinAcross, joinCandidate, KNOWN_JOIN_HOSTS, LINK_KEYS_MAX, NOTES_SERVICES, placeKeyText, producerKeys,
  type JoinCandidate, type JoinFields,
} from "../src/calendar/join";
import { INVITE_CORPUS } from "./fixtures/calendar/invite-corpus";

const known = (url: string): JoinCandidate => ({ kind: "known", url, host: new URL(url).hostname });

describe("known hosts and their join paths", () => {
  test.each([
    "https://teams.microsoft.com/l/meetup-join/x", "https://teams.microsoft.com/meet/123",
    "https://teams.live.com/l/meetup-join/x", "https://teams.live.com/meet/123",
  ])("both Teams hosts accept both join paths: %s", (url) => {
    expect(joinCandidate({ notes: url })).toEqual(known(url));
  });
  test.each(["www.webex.com", "help.webex.com", "support.webex.com"])("Webex non-join host %s is refused even with a join path", (host) => {
    expect(joinCandidate({ notes: `https://${host}/meet/sam.lee` })).toBeNull();
  });
  test("accepted: each known host's join paths, from any of the three fields", () => {
    for (const url of [
      "https://zoom.us/j/84512345678", "https://us02web.zoom.us/j/84512345678?pwd=ZZx", "https://zoomgov.com/j/1612345678",
      "https://agency.zoomgov.com/j/1612345678", "https://meet.google.com/abc-defg-hij", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
      "https://teams.live.com/meet/9381234567890", "https://example.webex.com/example/j.php?MTID=m123", "https://acme.webex.com/meet/sam.lee",
      "https://acme.webex.com/join/sam.lee",
    ]) {
      expect(joinCandidate({ url })).toEqual(known(url));
      expect(joinCandidate({ location: `Room 4, ${url}` })).toEqual(known(url));
      expect(joinCandidate({ notes: `Join here: ${url}.` })).toEqual(known(url));
    }
    expect(KNOWN_JOIN_HOSTS).toEqual(["Zoom", "Google Meet", "Teams", "Webex"]);
  });

  test("never a candidate: dial-in, help, options, support and agenda links (the invite corpus's included)", () => {
    for (const url of [
      "https://us02web.zoom.us/u/kZZlocalZZ",                                   // invite-corpus.ts: Zoom's local-number link
      "https://teams.microsoft.com/meetingOptions/?organizerId=ZZorgid",        // invite-corpus.ts: Teams' meeting options
      "https://aka.ms/JoinTeamsMeeting", "https://support.google.com/a/users/answer/9282720", "https://tel.meet/zzq-sent-inel?pin=246813579",
      "https://zoom.us/support", "https://zoom.us/", "https://meet.google.com/", "https://meet.google.com/landing", "https://www.webex.com/",
      "https://help.webex.com/en-us/article/x", "https://teams.microsoft.com/dl/launcher/launcher.html", "https://docs.google.com/document/d/ZZagenda/edit",
    ]) expect(`${url}: ${JSON.stringify(joinCandidate({ notes: `see ${url} now` }))}`).toBe(`${url}: null`);
    // In the invite corpus, only the real join link of each service counts.
    const found = INVITE_CORPUS.map((c) => joinCandidate({ notes: c.description }));
    expect(found.map((f) => (f && f.kind === "known" ? f.host : f?.kind ?? null))).toEqual([
      "us02web.zoom.us", "teams.microsoft.com", "meet.google.com", "example.webex.com", "zoom.us", "teams.microsoft.com",
    ]);
    // The 2026 Teams layout joins through its "Join:" link, never its "System reference" one.
    expect(found[5]).toEqual(known("https://teams.microsoft.com/meet/27ZZmeetSENTINEL?p=ZZmeetPC"));
  });
});

describe("the field order and \"several\"", () => {
  test("the first field holding a known-host candidate wins: the URL field, then the location, then the notes", () => {
    const z = "https://zoom.us/j/111", m = "https://meet.google.com/abc-defg-hij", t = "https://teams.microsoft.com/l/meetup-join/x";
    expect(joinCandidate({ url: z, location: m, notes: t })).toEqual(known(z));
    expect(joinCandidate({ location: m, notes: `${t} ${z}` })).toEqual(known(m));
    expect(joinCandidate({ url: "https://intranet.example/agenda", location: "Room 1", notes: t })).toEqual(known(t));
  });
  test("several: two DIFFERENT known-host candidates in the winning field (by host and path, ignoring query and fragment)", () => {
    expect(joinCandidate({ notes: "https://zoom.us/j/111 or https://meet.google.com/abc-defg-hij" })).toEqual({ kind: "several" });
    expect(joinCandidate({ notes: "https://zoom.us/j/111 and https://zoom.us/j/222" })).toEqual({ kind: "several" });
    // The same link twice (an HTML href and its text, a different query or fragment) is one.
    expect(joinCandidate({ notes: '<a href="https://meet.google.com/abc-defg-hij">https://meet.google.com/abc-defg-hij?authuser=0#x</a>' }))
      .toEqual(known("https://meet.google.com/abc-defg-hij"));
    // Several in a LATER field do not count when an earlier field has one.
    expect(joinCandidate({ location: "https://zoom.us/j/111", notes: "https://zoom.us/j/222 https://zoom.us/j/333" })).toEqual(known("https://zoom.us/j/111"));
  });
  test("a Teams invite's Join: /meet/ link and its System reference /l/meetup-join/ link are one meeting, joined through /meet/", () => {
    const meet = "https://teams.microsoft.com/meet/2718281828?p=ZZpc", ref = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0";
    expect(joinCandidate({ notes: `Join: ${meet} | System reference<${ref}>` })).toEqual(known(meet));
    // In either order, with the Join link written twice, in the location as in the notes, and on teams.live.com too.
    expect(joinCandidate({ notes: `${ref} then ${meet} and again ${meet}` })).toEqual(known(meet));
    expect(joinCandidate({ location: `${meet} ${ref}` })).toEqual(known(meet));
    const slashed = "https://teams.microsoft.com/meet/2718281828/?p=ZZpc";
    expect(joinCandidate({ notes: `${slashed} ${ref}` })).toEqual(known(slashed));
    const liveMeet = "https://teams.live.com/meet/9334?p=ZZ", liveRef = "https://teams.live.com/l/meetup-join/19%3ameeting_y%40thread.v2/0";
    expect(joinCandidate({ notes: `${liveMeet} ${liveRef}` })).toEqual(known(liveMeet));
    // Across a key-c merge's views: a paired view and a view holding only the same /meet/ link agree.
    expect(joinAcross([{ fields: { notes: `${meet} ${ref}` }, tier: 1 }, { fields: { notes: meet }, tier: 2 }])).toEqual(known(meet));
  });
  test("still several: any other mix of Teams links, or a Teams link beside another service", () => {
    const meet = "https://teams.microsoft.com/meet/2718281828", ref = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0";
    const several: JoinCandidate = { kind: "several" };
    expect(joinCandidate({ notes: `${meet} ${ref} https://teams.microsoft.com/meet/3141592653` })).toEqual(several);
    expect(joinCandidate({ notes: `${meet} ${ref} https://teams.microsoft.com/l/meetup-join/19%3ameeting_z%40thread.v2/0` })).toEqual(several);
    expect(joinCandidate({ notes: `${meet} https://teams.microsoft.com/meet/3141592653` })).toEqual(several);
    expect(joinCandidate({ notes: `${ref} https://teams.microsoft.com/l/meetup-join/19%3ameeting_z%40thread.v2/0` })).toEqual(several);
    expect(joinCandidate({ notes: `https://teams.live.com/meet/9334 ${ref}` })).toEqual(several);
    expect(joinCandidate({ notes: `${meet} https://zoom.us/j/111` })).toEqual(several);
    expect(joinCandidate({ notes: `${meet} ${ref} https://zoom.us/j/111` })).toEqual(several);
    // A /meet/ link with no id is not the Join link of a pair.
    expect(joinCandidate({ notes: `https://teams.microsoft.com/meet/ ${ref}` })).toEqual(several);
  });
});

describe("other hosts: asked first", () => {
  test("another https host in the URL field or the location, as written, asks first", () => {
    expect(joinCandidate({ url: "https://meet.example.org/room/42" })).toEqual({ kind: "other", url: "https://meet.example.org/room/42", host: "meet.example.org" });
    expect(joinCandidate({ location: "https://video.example.com/r/abc" })).toEqual({ kind: "other", url: "https://video.example.com/r/abc", host: "video.example.com" });
    // Not one URL: the first https URL found in it.
    expect(joinCandidate({ location: "Room 4 (or https://video.example.com/r/abc, then https://second.example/x)" }))
      .toEqual({ kind: "other", url: "https://video.example.com/r/abc", host: "video.example.com" });
    // The URL field before the location.
    expect(joinCandidate({ url: "https://a.example/1", location: "https://b.example/2" })).toEqual({ kind: "other", url: "https://a.example/1", host: "a.example" });
  });
  test("from the notes, only the five services, asking with the service named", () => {
    for (const [url, host, serviceName] of [
      ["https://whereby.com/team-room", "whereby.com", "Whereby"], ["https://acme.whereby.com/standup", "acme.whereby.com", "Whereby"],
      ["https://meet.jit.si/OurRoom", "meet.jit.si", "Jitsi"], ["https://meet.goto.com/123456789", "meet.goto.com", "GoTo"],
      ["https://global.gotomeeting.com/join/123456789", "global.gotomeeting.com", "GoTo"], ["https://bluejeans.com/123456", "bluejeans.com", "BlueJeans"],
      ["https://app.chime.aws/meetings/1234567890", "app.chime.aws", "Amazon Chime"],
    ] as const) expect(joinCandidate({ notes: `Call: ${url}` })).toEqual({ kind: "service", url, host, serviceName });
    expect(NOTES_SERVICES.map((s) => s.name)).toEqual(["Whereby", "Jitsi", "GoTo", "BlueJeans", "Amazon Chime"]);
  });
  test("no Join: a docs.google.com link (or any other link) in the notes", () => {
    expect(joinCandidate({ notes: "Agenda: https://docs.google.com/document/d/x/edit" })).toBeNull();
    expect(joinCandidate({ notes: "https://video.example.com/r/abc" })).toBeNull();
    expect(joinCandidate({})).toBeNull();
    expect(joinCandidate({ url: "", location: "Room 4", notes: "No link here." })).toBeNull();
  });
  test("ignored: another https host when a known-host candidate exists anywhere", () => {
    expect(joinCandidate({ url: "https://intranet.example/x", notes: "https://zoom.us/j/1" })).toEqual(known("https://zoom.us/j/1"));
    expect(joinCandidate({ location: "https://video.example.com/r", notes: "https://whereby.com/r https://meet.google.com/abc-defg-hij" }))
      .toEqual(known("https://meet.google.com/abc-defg-hij"));
  });
  test("the look-alike zoom.us.evil.com never matches the direct-open list: it asks first from the location, and is nothing in the notes", () => {
    expect(joinCandidate({ location: "https://zoom.us.evil.com/j/123" })).toEqual({ kind: "other", url: "https://zoom.us.evil.com/j/123", host: "zoom.us.evil.com" });
    expect(joinCandidate({ notes: "https://zoom.us.evil.com/j/123" })).toBeNull();
    expect(joinCandidate({ notes: "https://evilzoom.us/j/123 https://meet.google.com.evil.com/abc-defg-hij" })).toBeNull();
    expect(joinCandidate({ notes: "https://whereby.com.evil.com/r" })).toBeNull();
  });
});

describe("refused before anything else", () => {
  test.each(["\u200b", "\u00ad"])("invisible host character %j is refused on repeated raw URL checks", (invisible) => {
    const url = `https://zo${invisible}om.us/j/1`;
    expect([joinCandidate({ url }), joinCandidate({ url }), joinCandidate({ notes: url })]).toEqual([null, null, null]);
  });
  test("http, userinfo and a written port (443 included), on the raw string", () => {
    for (const url of [
      "http://zoom.us/j/1", "https://user@zoom.us/j/1", "https://user:pw@zoom.us/j/1", "https://zoom.us:443/j/1", "https://zoom.us:8443/j/1",
      "https://zoom.us:/j/1", "https://evil.example\\@zoom.us/j/1",
    ]) {
      expect(`${url}: ${JSON.stringify(joinCandidate({ url }))}`).toBe(`${url}: null`);
      expect(`${url}: ${JSON.stringify(joinCandidate({ notes: url }))}`).toBe(`${url}: null`);
    }
    expect(joinCandidate({ location: "https://a@video.example.com/r" })).toBeNull();
  });
  test("a refused known-host link does not hide a valid one in the same field", () => {
    expect(joinCandidate({ notes: "https://zoom.us:443/j/1 https://zoom.us/j/2" })).toEqual(known("https://zoom.us/j/2"));
  });
  test("an HTML-escaped ampersand in a found link is read as one", () => {
    expect(joinCandidate({ notes: '<a href="https://zoom.us/j/1?pwd=a&amp;uname=b">x</a>' })).toEqual(known("https://zoom.us/j/1?pwd=a&uname=b"));
  });
  test("a Unicode host is given in its ASCII (punycode) form", () => {
    expect(joinCandidate({ url: "https://zоom.example/j/1" })).toEqual({ kind: "other", url: "https://zоom.example/j/1", host: "xn--zom-sed.example" });
  });
});

// ── Calendar near-duplicates (key c): producer keys and Join across views (plan T1.1; spec 2026-10-31 §3, §4, §5) ──

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Each producer call runs twice: the URL regexes are global, and a stateful `.test` would make the second differ. */
const keysOf = (raw: { location?: string; notes?: string }) => {
  const first = producerKeys(raw);
  expect(producerKeys(raw)).toEqual(first);
  return first;
};
const meetingKeyOf = (raw: { location?: string; notes?: string }) => keysOf(raw).meetingKey;
const placeKeyOf = (location: string) => keysOf({ location }).placeKey;

describe("producer keys: placeKey (M22, M23)", () => {
  test("M22 collapse and trim of spaces that punctuation or URL removal creates, exact text and hash", () => {
    expect(placeKeyText("Clinic , North")).toBe("clinic north");
    expect(placeKeyText("Clinic + North")).toBe("clinic north");
    expect(placeKeyText(", Clinic North")).toBe("clinic north");
    expect(placeKeyText("Clinic North https://example.com/x")).toBe("clinic north");
    for (const loc of ["Clinic , North", "Clinic + North", ", Clinic North", "Clinic North https://example.com/x"]) {
      expect(placeKeyOf(loc)).toBe(sha("clinic north"));
      expect(placeKeyOf(loc)).toBe(placeKeyOf("Clinic North"));
    }
  });
  test.each([
    ["12 Main Street", "12 main st"], ["5 Park Avenue", "5 park ave"], ["9 Mill Road", "9 mill rd"], ["1 Sunset Boulevard", "1 sunset blvd"],
    ["3 Oak Drive", "3 oak dr"], ["Suite 4, Tower", "ste 4 tower"],
  ])("M22 abbreviation, whole token: %s", (loc, want) => {
    expect(placeKeyText(loc)).toBe(want);
    expect(placeKeyOf(loc)).toBe(sha(want));
  });
  test.each([
    ["Clinic, USA", "clinic"], ["Clinic, United States", "clinic"], ["Clinic US", "clinic"], ["Clinic, U.S.A.", "clinic u s a"],
  ])("M22 one trailing country form: %s", (loc, want) => {
    expect(placeKeyText(loc)).toBe(want);
  });
  test("M22 replacements are whole-token only, and only one trailing country form goes", () => {
    expect(placeKeyText("Drivers Lane")).toBe("drivers lane");
    expect(placeKeyText("Broadway")).toBe("broadway");
    expect(placeKeyText("Campus")).toBe("campus");
    expect(placeKeyText("Streetwise Roadhouse")).toBe("streetwise roadhouse");
    expect(placeKeyText("Clinic US USA")).toBe("clinic us");
    expect(placeKeyText("US Clinic")).toBe("us clinic");
    expect(placeKeyOf("12 Main Street, USA")).toBe(placeKeyOf("12 main st"));
  });
  test("M22 a token named like an Object.prototype key is kept as written, never replaced", () => {
    expect(placeKeyText("Constructor Hall")).toBe("constructor hall");
    // Only "constructor" exercises the prototype hazard: tokens are lower-cased first, so the camel-case prototype keys
    // (toString, valueOf, hasOwnProperty, …) can never be looked up, and "__proto__" loses its underscores (\p{P}).
    expect(placeKeyOf("Constructor Hall")).toBe(sha("constructor hall"));
  });
  test("M23 entity decoding, the second NFKC and invisible stripping together, then each alone", () => {
    expect(placeKeyText("&#xFF23;li​nic")).toBe("clinic");
    expect(placeKeyOf("&#xFF23;li​nic")).toBe(placeKeyOf("Clinic"));
    // The second NFKC alone: the entity decodes to a full-width C only after the first NFKC has run.
    expect(placeKeyText("&#xFF23;linic")).toBe("clinic");
    // Invisible stripping alone: U+200B is neither whitespace nor punctuation, so only `INVISIBLE_RE` removes it.
    expect(placeKeyText("Cli​nic")).toBe("clinic");
    // The first NFKC must precede `stripHtml`: full-width tags become real tags first.
    expect(placeKeyText("＜b＞Clinic＜/b＞")).toBe("clinic");
  });
  test("M23 URL removal: full-width, entity-escaped, special/backslash and bare URLs leave only the place", () => {
    for (const loc of [
      "ＨＴＴＰＳ://maps.example.com/x Clinic North", "&#x68;ttps://maps.example.com/x Clinic North", "https:/\\maps.example.com/x Clinic North",
      "maps.example.com/x Clinic North", "https%3A%2F%2Fmaps.example.com%2Fx Clinic North", "Clinic https://a.example/1 North https://b.example/2",
    ]) {
      expect(`${loc} → ${placeKeyText(loc)}`).toBe(`${loc} → clinic north`);
      expect(placeKeyOf(loc)).toBe(placeKeyOf("Clinic North"));
    }
  });
  test("no placeKey: URL-only, empty, punctuation-only and absent locations", () => {
    for (const location of ["https://zoom.us/j/555", "https://maps.google.com/?q=clinic+a", "", "  — · !! ", "USA"]) {
      expect(placeKeyText(location)).toBe("");
      expect(keysOf({ location }).placeKey).toBeUndefined();
    }
    expect(keysOf({}).placeKey).toBeUndefined();
  });
  test("P07 placeKey reads only the raw location, never the notes", () => {
    expect(keysOf({ notes: "Clinic North" }).placeKey).toBeUndefined();
    expect(keysOf({ location: "Clinic North", notes: "Somewhere else" }).placeKey).toBe(sha("clinic north"));
  });
});

describe("producer keys: linkKeys (P05)", () => {
  test("P05 one key per valid https link: lower-cased host, no trailing slash, sorted query, no fragment", () => {
    expect(keysOf({ location: "https://Example.COM/a/b/?z=2&a=1#frag" }).linkKeys).toEqual([sha("example.com/a/b?a=1&z=2")]);
    expect(keysOf({ location: "https://example.com/" }).linkKeys).toEqual([sha("example.com")]);
    // Pairs sort by name, then value.
    expect(keysOf({ location: "https://example.com/x?b=2&a=2&a=1" }).linkKeys).toEqual([sha("example.com/x?a=1&a=2&b=2")]);
  });
  test("P05 sorted and deduped; spellings of one link give one key", () => {
    const loc = "https://whereby.com/acme-hr https://meet.goto.com/111 https://WHEREBY.com/acme-hr/#x https://meet.goto.com/111?";
    expect(keysOf({ location: loc }).linkKeys).toEqual([sha("whereby.com/acme-hr"), sha("meet.goto.com/111")].sort());
  });
  test(`P05 at most ${LINK_KEYS_MAX} values, the first after sorting; a ninth distinct link is dropped`, () => {
    const urls = Array.from({ length: 9 }, (_, i) => `https://h${i}.example/p`);
    const all = urls.map((u) => sha(new URL(u).host + "/p")).sort();
    expect(keysOf({ location: urls.join(" ") }).linkKeys).toEqual(all.slice(0, 8));
    expect(LINK_KEYS_MAX).toBe(8);
  });
  test("P05 omitted, never [], with no valid https link: http, bare, port, userinfo, notes-only", () => {
    for (const location of ["Clinic North", "http://example.com/x", "example.com/x", "https://example.com:443/x", "https://u@example.com/x"]) {
      expect(`${location}: ${"linkKeys" in keysOf({ location })}`).toBe(`${location}: false`);
    }
    expect("linkKeys" in keysOf({ notes: "https://example.com/x" })).toBe(false);
  });
  test("P05 different map queries differ; Zoom pwd variants differ in linkKey but share the meeting key", () => {
    expect(keysOf({ location: "https://maps.google.com/?q=clinic+a" }).linkKeys).not.toEqual(keysOf({ location: "https://maps.google.com/?q=clinic+b" }).linkKeys);
    const a = keysOf({ location: "https://us02web.zoom.us/j/81234567890?pwd=a" }), b = keysOf({ location: "https://zoom.us/j/81234567890" });
    expect(a.linkKeys).not.toEqual(b.linkKeys);
    expect(a.meetingKey).toBe(b.meetingKey!);
    expect(a.meetingKey).toBe(sha("zoom\u000081234567890"));
  });
});

describe("producer keys: meetingKey providers (M04, M11, M12, S15, S27, S29)", () => {
  test("Zoom: the digits, host and query ignored; zoom and zoomgov are distinct providers (S29)", () => {
    expect(meetingKeyOf({ location: "https://us02web.zoom.us/j/81234567890?pwd=a#x" })).toBe(sha("zoom\u000081234567890"));
    expect(meetingKeyOf({ location: "https://zoomgov.com/j/1612345678" })).toBe(sha("zoomgov\u00001612345678"));
    expect(meetingKeyOf({ location: "https://agency.zoomgov.com/j/1612345678?pwd=x" })).toBe(sha("zoomgov\u00001612345678"));
    expect(meetingKeyOf({ location: "https://zoom.us/j/1612345678" })).not.toBe(meetingKeyOf({ location: "https://zoomgov.com/j/1612345678" })!);
  });
  test("Google Meet: the code, lower-cased", () => {
    expect(meetingKeyOf({ notes: "https://meet.google.com/ABC-defg-HIJ" })).toBe(sha("meet\u0000abc-defg-hij"));
    expect(meetingKeyOf({ notes: "https://meet.google.com/abc-defg-hij/?authuser=0" })).toBe(sha("meet\u0000abc-defg-hij"));
  });
  test("M11 Teams: encoded and decoded thread agree; only the first segment after /l/meetup-join/ counts", () => {
    const enc = meetingKeyOf({ location: "https://teams.microsoft.com/l/meetup-join/19%3AMeeting_X%40thread.v2/0?context=%7b%7d" });
    const dec = meetingKeyOf({ location: "https://teams.live.com/l/meetup-join/19:meeting_x@thread.v2" });
    expect(enc).toBe(sha("teams\u000019:meeting_x@thread.v2"));
    expect(dec).toBe(enc!);
    expect(meetingKeyOf({ location: "https://teams.microsoft.com/meet/9381234567890?p=x" })).toBe(sha("teams-meet\u00009381234567890"));
  });
  test("Teams /meet/<id>: the id is neither lower-cased nor decoded, so /meet/ABC and /meet/abc are two meetings", () => {
    expect(meetingKeyOf({ location: "https://teams.microsoft.com/meet/ABC" })).toBe(sha("teams-meet\u0000ABC"));
    expect(meetingKeyOf({ location: "https://teams.microsoft.com/meet/abc" })).toBe(sha("teams-meet\u0000abc"));
    expect(meetingKeyOf({ location: "https://teams.microsoft.com/meet/ABC" })).not.toBe(meetingKeyOf({ location: "https://teams.microsoft.com/meet/abc" })!);
  });
  test("S27 Teams: a different thread differs; malformed encoding and empty ids give no key", () => {
    expect(meetingKeyOf({ location: "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_y%40thread.v2/0" }))
      .not.toBe(meetingKeyOf({ location: "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_x%40thread.v2/0" })!);
    for (const location of [
      "https://teams.microsoft.com/l/meetup-join/19%ZZmeeting/0", "https://teams.microsoft.com/l/meetup-join/%E0%A4%A",
      "https://teams.microsoft.com/l/meetup-join/", "https://teams.microsoft.com/l/meetup-join//0", "https://teams.live.com/meet/",
    ]) expect(`${location}: ${meetingKeyOf({ location })}`).toBe(`${location}: undefined`);
  });
  test("S15 Webex: j.php keys on MTID (different MTIDs differ, none gives no key); /meet and /join rooms key on site + name", () => {
    expect(meetingKeyOf({ location: "https://acme.webex.com/acme/j.php?MTID=m1" })).toBe(sha("webex\u0000m1"));
    expect(meetingKeyOf({ location: "https://acme.webex.com/acme/j.php?MTID=m2" })).not.toBe(sha("webex\u0000m1"));
    expect(meetingKeyOf({ location: "https://acme.webex.com/acme/j.php" })).toBeUndefined();
    expect(meetingKeyOf({ location: "https://acme.webex.com/acme/j.php?MTID=" })).toBeUndefined();
    // The query name is exactly `MTID`: a lower-case `mtid` is no MTID, so no key.
    expect(meetingKeyOf({ location: "https://acme.webex.com/acme/j.php?mtid=m1" })).toBeUndefined();
    const room = sha("webex-room\u0000acme.webex.com/sam.lee");
    expect(meetingKeyOf({ location: "https://acme.webex.com/meet/sam.lee" })).toBe(room);
    expect(meetingKeyOf({ location: "https://ACME.webex.com/join/Sam.Lee/" })).toBe(room);
    expect(meetingKeyOf({ location: "https://other.webex.com/meet/sam.lee" })).not.toBe(room);
  });
  test("other services, and refused or off-path known hosts, give no key", () => {
    for (const location of [
      "https://whereby.com/acme-hr", "https://meet.goto.com/111", "https://zoom.us/support", "https://zoom.us:443/j/1", "http://zoom.us/j/1",
      "https://zoom.us.evil.com/j/1", "zoom.us/j/1",
    ]) expect(`${location}: ${meetingKeyOf({ location })}`).toBe(`${location}: undefined`);
  });
  test("candidateMeetingKey: one URL by the same provider rules", () => {
    expect(candidateMeetingKey("https://us02web.zoom.us/j/111?pwd=x")).toBe(sha("zoom\u0000111"));
    expect(candidateMeetingKey("https://acme.webex.com/acme/j.php?MTID=7")).toBe(sha("webex\u00007"));
    for (const url of ["https://acme.webex.com/acme/j.php", "https://teams.live.com/meet/", "https://whereby.com/x", "https://zoom.us:443/j/1", "not a url"]) {
      expect(candidateMeetingKey(url)).toBeUndefined();
    }
  });
});

describe("producer keys: which field decides the meeting key (P07, S25, S25b, S26, S28)", () => {
  test("P07 location first, then notes; the first field with a known-host link decides", () => {
    expect(meetingKeyOf({ location: "https://zoom.us/j/111", notes: "https://zoom.us/j/222" })).toBe(sha("zoom\u0000111"));
    expect(meetingKeyOf({ location: "Clinic North https://whereby.com/r", notes: "https://zoom.us/j/222" })).toBe(sha("zoom\u0000222"));
    expect(meetingKeyOf({ notes: "Join: https://zoom.us/j/222." })).toBe(sha("zoom\u0000222"));
  });
  test("variants of one meeting in one field are not several", () => {
    expect(meetingKeyOf({ location: "https://zoom.us/j/111 https://us02web.zoom.us/j/111?pwd=a" })).toBe(sha("zoom\u0000111"));
  });
  test("S25 two different meeting keys in the location: no key, and the notes are never retried", () => {
    expect(meetingKeyOf({ location: "https://zoom.us/j/111 https://zoom.us/j/222", notes: "https://zoom.us/j/222" })).toBeUndefined();
  });
  test("S25b the location's several keys include the other view's key: still no key", () => {
    const other = meetingKeyOf({ location: "https://zoom.us/j/222" });
    expect(other).toBe(sha("zoom\u0000222"));
    expect(meetingKeyOf({ location: "https://meet.google.com/abc-defg-hij https://zoom.us/j/222", notes: "https://zoom.us/j/222" })).toBeUndefined();
  });
  test("S26 a keyless known-host link in the deciding field blocks the key, even beside a keyed one", () => {
    for (const location of [
      "https://acme.webex.com/acme/j.php", "https://teams.microsoft.com/l/meetup-join/19%ZZx/0", "https://teams.live.com/meet/",
      "https://teams.microsoft.com/l/meetup-join/",
    ]) expect(`${location}: ${meetingKeyOf({ location, notes: "https://zoom.us/j/222" })}`).toBe(`${location}: undefined`);
    expect(meetingKeyOf({ location: "https://zoom.us/j/222 https://acme.webex.com/acme/j.php" })).toBeUndefined();
  });
  test("S26a j.php?MTID=1 beside j.php?MTID=2 in one field is several: no key", () => {
    expect(meetingKeyOf({ location: "https://acme.webex.com/acme/j.php?MTID=1 https://acme.webex.com/acme/j.php?MTID=2" })).toBeUndefined();
  });
  test("S26b j.php?MTID=1 beside a bare j.php in one field: no key", () => {
    expect(meetingKeyOf({ location: "https://acme.webex.com/acme/j.php?MTID=1 https://acme.webex.com/acme/j.php" })).toBeUndefined();
  });
  test("S28 an off-path zoom.us link neither gives a key nor stops the search", () => {
    expect(meetingKeyOf({ location: "Help: https://zoom.us/support https://zoom.us/j/", notes: "https://zoom.us/j/222" })).toBe(sha("zoom\u0000222"));
  });
});

describe("join across views (C10–C15, pure halves)", () => {
  type V = { fields: JoinFields; tier: 1 | 2 | 3 };
  const v = (tier: 1 | 2 | 3, fields: JoinFields): V => ({ fields, tier });
  test("one view behaves as joinCandidate; no candidates give null", () => {
    for (const fields of [{ notes: "https://zoom.us/j/1" }, { location: "https://video.example.com/r" }, { notes: "https://whereby.com/r" }, {}]) {
      expect(joinAcross([v(2, fields)])).toEqual(joinCandidate(fields));
    }
    expect(joinAcross([])).toBeNull();
    expect(joinAcross([v(1, { location: "Room 1" }), v(3, {})])).toBeNull();
  });
  test("C10 three views: two share a key through Zoom host variants and one has none → one Join; different Webex MTIDs → several", () => {
    expect(joinAcross([v(1, { location: "https://zoom.us/j/111" }), v(1, { notes: "https://us02web.zoom.us/j/111?pwd=a" }), v(2, { location: "Clinic" })]))
      .toEqual(known("https://zoom.us/j/111"));
    expect(joinAcross([v(1, { location: "https://acme.webex.com/acme/j.php?MTID=1" }), v(1, { location: "https://acme.webex.com/acme/j.php?MTID=2" }), v(2, {})]))
      .toEqual({ kind: "several" });
  });
  test("C11 a keyed and a keyless candidate on one host+path → several; two keyless ones on it agree", () => {
    expect(joinAcross([v(1, { location: "https://acme.webex.com/acme/j.php?MTID=1" }), v(1, { location: "https://acme.webex.com/acme/j.php" })]))
      .toEqual({ kind: "several" });
    expect(joinAcross([v(1, { location: "https://acme.webex.com/acme/j.php" }), v(2, { notes: "https://acme.webex.com/acme/j.php?x=1" })]))
      .toEqual(known("https://acme.webex.com/acme/j.php"));
  });
  test("C12 per-candidate keys: a URL-field link agrees with another view's location; URL /j/111 + location /j/222 vs /j/222 → several", () => {
    expect(joinAcross([v(1, { url: "https://zoom.us/j/222" }), v(1, { location: "https://us02web.zoom.us/j/222?pwd=b" })])).toEqual(known("https://zoom.us/j/222"));
    expect(joinAcross([v(1, { url: "https://zoom.us/j/111", location: "https://zoom.us/j/222" }), v(1, { location: "https://zoom.us/j/222" })]))
      .toEqual({ kind: "several" });
  });
  test("C13 a known-host candidate overrides another view's other/service candidate only from the same or a better tier", () => {
    expect(joinAcross([v(1, { notes: "https://zoom.us/j/1" }), v(2, { location: "https://whereby.com/acme-hr" })])).toEqual(known("https://zoom.us/j/1"));
    expect(joinAcross([v(2, { location: "https://video.example.com/r" }), v(2, { notes: "https://zoom.us/j/1" })])).toEqual(known("https://zoom.us/j/1"));
    expect(joinAcross([v(1, { notes: "https://whereby.com/acme-hr" }), v(1, { notes: "https://zoom.us/j/1" })])).toEqual(known("https://zoom.us/j/1"));
    // The tier-crossing fixture: own entry (tier 2) with a Whereby link, invitation (tier 3) with Zoom → several.
    expect(joinAcross([v(2, { location: "https://whereby.com/acme-hr" }), v(3, { location: "https://zoom.us/j/1" })])).toEqual({ kind: "several" });
    expect(joinAcross([v(2, { notes: "https://whereby.com/acme-hr" }), v(3, { notes: "https://zoom.us/j/1" })])).toEqual({ kind: "several" });
  });
  test("C13 SOME known-host candidate of the same or a better tier drops another view's other candidate; the known ones must still agree", () => {
    // Tier-1 Zoom drops the tier-2 Whereby even though a tier-3 Zoom candidate is worse than it (`some`, not `every`).
    expect(joinAcross([v(1, { location: "https://zoom.us/j/1" }), v(2, { location: "https://whereby.com/acme-hr" }), v(3, { location: "https://zoom.us/j/1" })]))
      .toEqual(known("https://zoom.us/j/1"));
    // The same shape with a tier-3 Zoom link to a different meeting: the remaining known candidates disagree.
    expect(joinAcross([v(1, { location: "https://zoom.us/j/1" }), v(2, { location: "https://whereby.com/acme-hr" }), v(3, { location: "https://zoom.us/j/2" })]))
      .toEqual({ kind: "several" });
  });
  test("other and service candidates, with no known-host one, compare by host and path", () => {
    expect(joinAcross([v(1, { location: "https://whereby.com/acme-hr" }), v(1, { notes: "https://whereby.com/acme-hr?x=1" })]))
      .toEqual({ kind: "other", url: "https://whereby.com/acme-hr", host: "whereby.com" });
    expect(joinAcross([v(1, { location: "https://whereby.com/acme-hr" }), v(1, { location: "https://whereby.com/other" })])).toEqual({ kind: "several" });
  });
  test("any view whose own candidate is several gives several", () => {
    expect(joinAcross([v(1, { location: "https://zoom.us/j/1" }), v(3, { notes: "https://zoom.us/j/1 https://zoom.us/j/2" })])).toEqual({ kind: "several" });
  });
  test("C14 the Join URL comes from the first remaining candidate by (tier, given order); forged fallback", () => {
    expect(joinAcross([v(2, { location: "https://zoom.us/j/1" }), v(1, { location: "https://us02web.zoom.us/j/1?pwd=x" })]))
      .toEqual(known("https://us02web.zoom.us/j/1?pwd=x"));
    expect(joinAcross([v(3, { location: "https://zoom.us/j/1" }), v(3, { location: "https://us02web.zoom.us/j/1?pwd=x" })])).toEqual(known("https://zoom.us/j/1"));
    // Accepted risk: a tier-3 view supplies Join when the answered view has none.
    expect(joinAcross([v(1, { location: "Clinic" }), v(3, { notes: "https://zoom.us/j/9" })])).toEqual(known("https://zoom.us/j/9"));
  });
  test("C15 single-event joinCandidate is unchanged: two Zoom host variants in one field are still several", () => {
    expect(joinCandidate({ notes: "https://zoom.us/j/111 https://us02web.zoom.us/j/111?pwd=a" })).toEqual({ kind: "several" });
  });
});
