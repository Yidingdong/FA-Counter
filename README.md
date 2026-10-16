# ja. — The live lecture count

Public display: https://www.itsyid.com/FA-Counter/

This repository contains the public **ja count**, its lecture date and update time, visit-only activity statistics, and an explanation of the counter architecture. Audio is transcribed by OpenAI; recordings, transcripts, detailed word frequencies, and publishing credentials are not published here. There are no contribution forms or recording uploads on this site.

The display reads a count-only relay every second and changes automatically when the laptop sends a new count. It retains the last confirmed number during connection failures. A dash means that no real count has been published yet; zero is a valid published count. The public page needs no API key, account, or refresh.

Lecture days are Fridays starting **16 October 2026**, using the Europe/Berlin calendar. The owner selects the lecture date in the laptop workspace.

`public/data/current.json` contains the public relay address and unpublished fallback state. It contains no publishing credential. Live count updates go directly to the relay and do not create Git commits or wait for GitHub Pages builds.

GitHub Actions tests and deploys only `public/` when the viewer source changes on `main`. Run `npm test` with Node.js 22+ to check the public display. The laptop workspace and relay source are excluded from this repository's current tree.

## Observed statistics

The first real relay snapshot establishes the visitor's baseline. The page shows net change since that baseline, average net change per minute after a 30-second warmup, observation time through the last successful response, and when the last count change was received. The recent chart groups received net changes by one-minute buckets over ten minutes. Negative values retain manual corrections instead of pretending every update is new speech. Grey minutes had no successful observations; a minute can be only partially observed.

These are statistics about updates received during this visit, not full-lecture averages, speech timestamps, or an accuracy measurement. Reloading clears them; changing lecture date or returning to unpublished state resets the baseline. History is held only in tab memory. Connection failures retain the last confirmed count and statistics. No additional publishing fields or server writes are introduced.

## Architecture transparency

The website explains the existing microphone → OpenAI Whisper → local counting → authenticated relay → GitHub Pages path, overlap handling, optional counting settings, delay, data boundaries, and recognition limitations. The relay stores a count-only JSON snapshot in R2. Public requests are unauthenticated reads; the laptop's secret authenticates writes. Full word counts and lecture duration remain unavailable until the laptop can safely publish those aggregates later.
