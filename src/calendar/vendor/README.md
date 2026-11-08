# Vendored: ical.js

- `ical.js` — **ical.js 2.2.1** (iCalendar parser, Philipp Kewisch and contributors), the package's
  `dist/ical.js` ES module, **unmodified**. sha256 `396c1349c899974b1048460e3c7495ec394ff1a86941ab5bf6291b272b8d53c2`
  (267,656 bytes).
- `LICENSE.ical.js` — its licence, the **Mozilla Public License 2.0**, unmodified. sha256
  `1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5`.
- Source: `https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz` (`package/dist/ical.js`, `package/LICENSE`);
  tarball sha512 `yK/UlPbEs316igb/tjRgbFA8ZV75rCsBJp/hWOatpyaPNlgw0dGDmU+FoicOcwX4xXkeXOkYiOmCqNPFpNPkQg==`.
  Project: https://github.com/kewisch/ical.js

Why vendored: the engine has no runtime dependencies and `scripts/install.sh` compiles without `bun install`
(calendar spec §4.2). It is loaded only by a dynamic import, only when calendar is on, and only inside the
`calendar-parse` child process (`src/calendar/parse-job.ts`). `ical.d.ts` beside it is ours: the minimal type
surface the engine uses, so the vendored file itself never has to change.

Do not edit `ical.js`. `test/calendar-parse.test.ts` pins both sha256 values; to upgrade, replace both files
from a verified release tarball and update the pins, this README and the version together.
