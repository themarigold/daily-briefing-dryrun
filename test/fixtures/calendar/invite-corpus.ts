// test/fixtures/calendar/invite-corpus.ts — a CONFERENCING INVITE CORPUS for the read-time cleaning (plan M3a;
// spec r4 §6 "Cleaning", §10 "cleaning (a Zoom/Teams/Meet/Webex invite corpus)").
//
// SYNTHETIC: each description is written here in the SHAPE each service's invite takes (its markers, its
// label wording, its dial-string form), with made-up hosts' paths, numbers and codes — no real meeting.
// Every secret is a sentinel (`ZZ…`, or a digit string used nowhere else) so a test can assert it is gone,
// and every invite carries agenda text written by the organizer, which must survive.
//
// A plain module, not a `.test.ts` file — importing a test file re-registers its tests.

export type InviteCase = {
  name: string;
  /** The raw DESCRIPTION as a feed or EventKit would hand it over. */
  description: string;
  /** Substrings that must survive cleaning (the organizer's own text, the hosts a URL becomes). */
  kept: string[];
  /** Substrings that must not survive: every secret, every URL path, the boilerplate itself. */
  gone: string[];
};

export const INVITE_CORPUS: readonly InviteCase[] = [
  {
    name: "Zoom (plain text)",
    description: [
      "Quarterly planning — please read the doc beforehand.",
      "",
      "Taylor Example is inviting you to a scheduled Zoom meeting.",
      "",
      "Join Zoom Meeting",
      "https://us02web.zoom.us/j/84512345678?pwd=ZZzoomPWD1a2b3c",
      "",
      "Meeting ID: 845 1234 5678",
      "Passcode: ZZpass77",
      "",
      "---",
      "",
      "One tap mobile",
      "+16465558656,,84512345678#,,,,*99887766# US (New York)",
      "",
      "Dial by your location",
      "        +1 646 555 8656 US (New York)",
      "Meeting ID: 845 1234 5678",
      "Passcode: 99887766",
      "Find your local number: https://us02web.zoom.us/u/kZZlocalZZ",
    ].join("\n"),
    kept: ["Quarterly planning — please read the doc beforehand."],
    gone: ["ZZzoomPWD1a2b3c", "ZZpass77", "99887766", "84512345678", "845 1234 5678", "kZZlocalZZ", "Join Zoom Meeting", "One tap mobile"],
  },
  {
    name: "Microsoft Teams (plain text, Outlook-style angle-bracket links)",
    description: [
      "Hi all, agenda: budget review and hiring plan.",
      "________________________________________________________________________________",
      "Microsoft Teams meeting",
      "Join on your computer, mobile app or room device",
      "Click here to join the meeting<https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZZteamsSENTINEL%40thread.v2/0?context=%7b%22Tid%22%3a%22ZZtid%22%7d>",
      "Meeting ID: 123 456 789 012",
      "Passcode: ZZtms9",
      "Download Teams<https://www.microsoft.com/microsoft-teams/download-app> | Join on the web<https://www.microsoft.com/microsoft-teams/join-a-meeting>",
      "Or call in (audio only)",
      "+1 323-555-0100,,987654321#   United States, Los Angeles",
      "Phone Conference ID: 987 654 321#",
      "Learn More<https://aka.ms/JoinTeamsMeeting> | Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=ZZorgid>",
      "________________________________________________________________________________",
    ].join("\r\n"),
    kept: ["Hi all, agenda: budget review and hiring plan."],
    gone: ["ZZteamsSENTINEL", "ZZtid", "ZZtms9", "123 456 789 012", "987654321", "987 654 321", "ZZorgid", "Microsoft Teams meeting", "____"],
  },
  {
    name: "Google Meet (HTML, as Google's feeds carry it)",
    description:
      "Sprint demo. Bring <b>screenshots</b> &amp; notes.<br><br>-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-<br>" +
      'Join with Google Meet: <a href="https://meet.google.com/zzq-sent-inel">https://meet.google.com/zzq-sent-inel</a><br>' +
      "Or dial: (US) +1 650-555-0199 PIN: 246813579#<br>More phone numbers: https://tel.meet/zzq-sent-inel?pin=246813579<br><br>" +
      "Learn more about Meet at: https://support.google.com/a/users/answer/9282720<br><br>Please do not edit this section.<br>" +
      "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-",
    kept: ["Sprint demo. Bring screenshots & notes."],
    gone: ["zzq-sent-inel", "246813579", "-::~", "<b>", "<br>", "&amp;", "Google Meet"],
  },
  {
    name: "Webex (plain text)",
    description: [
      "Vendor sync — contract renewal.",
      "",
      "-- Do not delete or change any of the following text. --",
      "",
      "When it's time, join the Webex meeting here.",
      "",
      "Meeting number (access code): 2345 678 9012",
      "Meeting password: ZZwbxPW1",
      "",
      "Join meeting <https://example.webex.com/example/j.php?MTID=mZZwebexSENTINEL>",
      "",
      "Join by phone",
      "+1-408-555-0123,,23456789012## United States Toll",
    ].join("\n"),
    kept: ["Vendor sync — contract renewal."],
    gone: ["2345 678 9012", "ZZwbxPW1", "mZZwebexSENTINEL", "23456789012", "Do not delete"],
  },
  {
    name: "hand-typed dial-in with the secrets BEFORE any marker (no boilerplate to cut)",
    description:
      "Dial +1 555 0100,,778899# then PIN: 4455 66. Backup room: https://zoom.us/j/5550001?pwd=ZZhandPWD — " +
      "the passcode is 31337 and the host key: 909090. Meeting ID 111-222-333. Agenda: Q4 numbers (1,000,000 target).",
    kept: ["Dial +1 555 0100,,[redacted]#", "PIN: [redacted]", "zoom.us link", "the passcode is [redacted]", "host key: [redacted]", "Meeting ID [redacted]", "Agenda: Q4 numbers (1,000,000 target)."],
    gone: ["778899", "4455", "5550001", "ZZhandPWD", "31337", "909090", "111-222-333"],
  },
  {
    // The layout of two real Teams invites read on 2026-11-02 (a Microsoft Bookings one, its Teams block, and the
    // block Google Calendar's Teams add-on appends), with every id, code and digit replaced: the "Join:" link is
    // `/meet/<id>?p=<passcode>`, written twice, and the same meeting's `/l/meetup-join/` link sits behind
    // "System reference".
    name: "Microsoft Teams (the 2026 layout: a Join: /meet/ link, and a System reference link)",
    description: [
      "This meeting was scheduled from the bookings page of Sam Lee. Agenda: intro call.",
      "________________________________________________________________________________",
      "Microsoft Teams meeting",
      "Join: https://teams.microsoft.com/meet/27ZZmeetSENTINEL?p=ZZmeetPC",
      "Meeting ID: 271 828 182 845 904 5",
      "Passcode: ZZtmsPC7",
      "________________________________",
      "Need help?<https://aka.ms/JoinTeamsMeeting?omkt=en-GB> | System reference<https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZZsysrefSENTINEL%40thread.v2/0?context=%7b%22Tid%22%3a%22ZZtid2%22%7d>",
      "For organisers: Meeting options<https://teams.microsoft.com/meetingOptions/?organizerId=ZZorgid2>",
      "________________________________________________________________________________",
      "",
      "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-",
      "Join Microsoft Teams Meeting",
      "https://teams.microsoft.com/meet/27ZZmeetSENTINEL?p=ZZmeetPC (ID: 2718281828459045, passcode: ZZtmsPC7)",
      "",
      "Please do not edit this section.",
      "-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-",
    ].join("\n"),
    kept: ["This meeting was scheduled from the bookings page of Sam Lee. Agenda: intro call."],
    gone: ["ZZmeetSENTINEL", "ZZmeetPC", "ZZtmsPC7", "271 828 182 845 904 5", "2718281828459045", "ZZsysrefSENTINEL", "ZZtid2", "ZZorgid2",
      "Microsoft Teams meeting", "System reference", "____", "-::~"],
  },
];
