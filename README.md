# ja. — The live lecture count

Public display: https://www.itsyid.com/FA-Counter/

This repository contains only the public display of the current **ja count**, its lecture date, and its last update time. Counting software, recordings, transcripts, word frequencies, and publishing credentials stay on the owner's laptop. There are no contribution forms or recording uploads on this site.

The display reads a count-only relay every two seconds and changes automatically when the laptop sends a new count. It retains the last confirmed number during connection failures. A dash means that no real count has been published yet; zero is a valid published count. The public page needs no API key, account, or refresh.

Lecture days are Fridays starting **16 October 2026**, using the Europe/Berlin calendar. The owner selects the lecture date in the laptop workspace.

`public/data/current.json` contains the public relay address and unpublished fallback state. It contains no publishing credential. Live count updates go directly to the relay and do not create Git commits or wait for GitHub Pages builds.

GitHub Actions tests and deploys only `public/` when the viewer source changes on `main`. Run `npm test` with Node.js 22+ to check the public display. The laptop workspace and relay source are excluded from this repository's current tree.
