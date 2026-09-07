# 1. Product Requirements Document (PRD)

## 1.1 Vision

**KEYVORIA** — *Forge Your Musical Mastery.*

A single, polished app that takes someone from "never touched a keyboard" to
confidently playing real songs, reading music, and improvising over chord changes,
using a MIDI keyboard for real-time feedback on notes, chords, rhythm, and timing. It
should feel closer to a well-designed game or fitness app (Duolingo / Yousician
territory) than a static video course: instant feedback, visible progress, and a
reason to come back daily. Unlike a single fixed curriculum, Keyvoria is organized
around four learning categories a user chooses freely between (§1.4), with XP earned
through practice spent deliberately to unlock harder content in whichever category
they care about — progression the user steers, not a rail they're placed on.

## 1.2 Target users

| Persona | Description | Primary needs |
|---|---|---|
| **Absolute Beginner** | Never played, doesn't read music, may not own a keyboard yet | Hand position, note names, simple songs, low intimidation |
| **Returning Player** | Took lessons years ago, rusty | Placement/assessment, refreshers on theory & technique, faster ramp |
| **Self-taught Improviser** | Plays by ear, weak on theory/reading | Chord progressions, theory, sight-reading, ear training |
| **Classical Track Student** | Wants repertoire and reading fluency | Public-domain classical pieces, hands-separate practice, grading |
| **Songwriter / Hobbyist Producer** | Wants to learn *their own* material | Upload your file (F-05, MP3 + MIDI/MusicXML, **premium**) |
| **Genre Learner** | Wants pop/jazz/blues comping, not classical | Genre-tagged Playback & Repeat content and Library filters |

## 1.3 Platforms & shared codebase

iOS, Android, and Web from one primary codebase where practical (see
[Technical Architecture](./02-technical-architecture.md) for the concrete stack
decision). MIDI I/O and low-level audio are the parts that cannot be shared and get
thin, platform-specific implementations behind a common interface.

## 1.4 V1 feature scope

Feature IDs (`F-xx`) are referenced by the architecture and roadmap docs.

**Home is where Keyvoria opens** (screen map §3.3) — the app opens directly
onto it, so a user's first interaction is choosing a program rather than reading a
dashboard. It absorbs both what an earlier draft called the separate "Learn tab"
(since the four categories below *are* the curriculum) and that draft's Home/Dashboard
tab, which sat in front of it and delayed the choice. V1 keeps it to exactly
Keyvoria's five major learning categories:

1. **Ear Training** (F-02a)
2. **Sight-Reading** (F-02b)
3. **Key Signatures** (F-02d)
4. **Playback & Repeat** (F-02c)
5. **Upload your file** (F-05) — **Premium**

Each category has its own progression, independent of the others (F-03) — a user
picks which skills to develop rather than being pushed through one linear
curriculum. There is deliberately no "Beginner/Intermediate/Advanced path" spanning
all categories at once; the closest earlier draft had one, and it's retired in favor
of per-category progression. Free/warm-up play remains cut from V1's Home screen for
launch simplicity, revisitable post-V1.

**Free vs. Premium — Keyvoria Premium, $5.95/month.**

| | Free | Premium (Keyvoria Premium) |
|---|---|---|
| On-screen keyboard | **32 keys** (F2–C5), available in *every* category | **61 keys** (C2–C7), everywhere |
| Ear Training / Sight-Reading / Key Signatures / Playback & Repeat | **Tiers 1–3**, XP-unlocked (F-03) | + **tier 4** — the bonus/hardcore tier in each category, which needs the 61-key range |
| Upload your file (F-05) | — | Any song → **MIDI file + sheet music + tutorial** |
| Advanced performance analysis (F-09) | — | Timing profile, trends, hand independence |
| Personalized practice (F-10) | — | Generated sessions targeting your weakest skills |
| Create Music (F-11) | — | Compose, edit, notate and export your own music |
| Competition Mode (F-13) | — | Three games, up to 8 players; one mistake and you are out |

The full premium inventory, including what is already specified versus genuinely new,
is in **F-05a**.

**The tier rule is fixed and uniform:** every tiered category has exactly **four
tiers**. Tiers 1–3 are free (tier 1 costs 0 XP and is unlocked from the start; tiers
2 and 3 are XP purchases). **Tier 4 is always the premium tier** — it requires an
active Keyvoria Premium subscription *and* its XP cost. There is no per-category
variation in where the paywall falls, which keeps the offer explainable in one
sentence: *tiers 1–3 on 32 keys are free; tier 4, the 61-key keyboard, Upload your
file and Competition Mode are $5.95/month.*

**Two features are Premium-only, with no free path at all: Upload your file and
Competition Mode.** Everything else in Keyvoria has a free version that is genuinely
usable — three full categories, three tiers each, no ads and no session limits. These
two are what the subscription *is*, which is why they are also what the Home page
explains.

The billing mechanic is a **$5.95/month subscription**. The XP numbers are now set
too (F-03) — earning rates and unlock costs are fixed values, not placeholders.

### F-01 Structured learning content
Content is organized **by category**, not by a level spanning all of them — each
item below belongs to exactly one of the four tiered categories (Upload your file is
user-generated and has no authored-content quota of its own):

- **Ear Training** — procedurally generated per F-02a's engine at play time; no
  fixed authored-item count the way the content-heavy categories below have.
- **Sight-Reading** — 15–20 curated passages (`sight_reading_passages`, DB §4.4a)
  spanning Treble, Bass, and Grand Staff clefs across the difficulty range.
- **Playback & Repeat** — this is where nearly all authored content volume lives,
  since it's the category for playing real material rather than isolated drills:
  - 25–50 original exercises (technique, rhythm, hand independence)
  - 25–50 chord-progression lessons (e.g. I–V–vi–IV, ii–V–I, 12-bar blues, modal
    vamps), each with theory explanation, listen-and-identify, and play-along
  - 10–20 public-domain classical pieces (e.g. Bach Minuets, Clementi Sonatinas,
    Satie Gymnopédie No.1, Beethoven Für Elise excerpt, Joplin rags), sourced from
    verifiably public-domain editions (IMSLP or hand-engraved from PD scores)
  - 10–20 original practice songs, purpose-written to reinforce specific skills,
    licensed in-house (no third-party rights risk)
  - plus the category's own procedurally-generated call-and-response drill (F-02c)

Genre (Pop/Rock, Jazz, Blues, Classical-repertoire, etc.) is a **tag**, not a
separate path — content across Playback & Repeat (and the Library, F-04) carries
genre tags for filtering, rather than genre defining its own linear curriculum,
consistent with "users choose which skills to develop" above.

**DECISION NEEDED:** confirm which 2+ genre tags to prioritize authoring content for
in V1 (suggest Pop/Rock and Jazz-basics as most broadly useful; Blues and
Classical-repertoire as fallback options) — same open question as before, just
reframed as tags rather than paths.

### F-02 MIDI performance feedback
- Detect connected MIDI keyboard (USB and Bluetooth MIDI where the OS supports it).
- Real-time grading of: correct note(s), correct chord (right notes regardless of
  voicing/inversion where appropriate), rhythm accuracy (note onset vs. expected beat),
  and timing (early/late, with configurable tolerance).
- Visual feedback synced to input: falling-notes or on-staff highlighting, per-note
  hit/miss/early/late indicators, live accuracy meter.
- **A MIDI keyboard is never required to use any part of Keyvoria.** The on-screen
  keyboard is a first-class input surface, present in **every** category — Ear
  Training, Sight-Reading, and Playback & Repeat alike — not a fallback bolted onto
  the modes that happen to allow it. An earlier draft treated Sight-Reading and the
  Repeat drill as MIDI-only with "no meaningful reduced mode"; that restriction is
  **retired**. Tapping keys on screen produces the same note-on/note-off event stream
  that hardware does, feeds the same shared `grading-engine`, and earns the same XP.
- The only honest caveat: real hardware gives **more precise timing** (physical key
  travel and velocity beat touch latency), so timing tolerances are slightly wider
  for on-screen input, and velocity-sensitive grading is skipped there. Note accuracy,
  chord accuracy, and note-order grading are identical either way.
- The on-screen keyboard's range is tiered — **32 keys free (F2–C5), 61 keys premium
  (C2–C7)** — and this only affects users relying on it as their input surface. The
  free range is deliberately **F2–C5 rather than a plain two octaves from C**: it spans
  the *entire* bass staff (G2–A3) as well as the treble staff's lower octave (C4–C5).
  An earlier 25-key C3–C5 range forced every bass-clef passage into the top of its
  staff, which reads oddly to anyone learning to read bass clef properly. 32 keys still
  fits a phone screen without horizontal scrolling; 61 does not, and scrolls. A
  connected real MIDI keyboard is never range-limited by the app regardless of tier;
  the cap exists because the on-screen keyboard *is* the instrument for a free user
  with no hardware, not because the app restricts hardware you already own. The
  entire free-tier curriculum — **tiers 1–3 in all four categories** — is authored
  to fit within those 32 keys, so a free user with no hardware can complete every free
  tier end to end. **The 61-key keyboard is available only on Keyvoria Premium**, and tier
  4 is where content is deliberately written beyond the 32-key range — which is why the
  two ship together in the same subscription rather than as separate perks.

### F-02a Ear Training: intervals & chord-quality drills
A configurable ear-training drill, launched from Home (screen map §3.3),
with its own XP-unlocked tier ladder (F-03). Entering a tier presents **two modes as
an explicit choice** — Note Intervals or Chords — rather than mixing them within one
session, so a user can drill the skill they actually want:

- **Note Intervals** — the system plays a stimulus of **2 to 8 notes**, chosen by the
  user with a stepper/slider:
  - **2 notes**: classic two-note interval identification (answer: interval name,
    e.g. major third, perfect fifth). **Tier 1 is two-note intervals only** — every
    exercise in a tier-1 interval session is exactly two notes, drawn from a small
    wide-and-obvious pool (major 3rd, perfect 4th, perfect 5th, octave).
  - **3 notes**: a triad, graded by chord quality (see quality pool below).
  - **4–8 notes**: a short note sequence (played melodically); the user identifies
    the full chain of intervals between consecutive notes — this scales the same
    mechanic up into basic melodic dictation without introducing a new drill type.
  - A **Difficulty** setting (1–5, independent of note count) widens or narrows the
    interval range the stimulus is drawn from, adds/removes closely-confusable
    distractor choices, and adjusts playback tempo — so, for example, a 2-note drill
    at Difficulty 1 stays within an octave with obviously-different answer choices,
    while Difficulty 5 spans wider intervals with tighter distractors.
- **Chords** — the system plays a triad (three notes, sounded together) and the user
  names its quality. **The pool widens by tier rather than by a setting**, which is
  what makes the tier ladder mean something here:

  | Tier | Chord qualities offered |
  |---|---|
  | 1 | **Major, Minor** — a two-way choice, the smallest useful discrimination |
  | 2+ | **Major, Minor, Augmented, Diminished** |

  Tier 1 deliberately asks only "major or minor?". A beginner who cannot yet hear a
  third reliably gets a question they can actually answer, and the answer set grows
  once they've bought their way past it.

Mechanics common to both: each round plays the stimulus (repeatable via a "play
again" control) and presents multiple-choice answers; the session is self-graded, so
no keyboard of any kind is strictly needed to answer — a stretch goal, not V1, is
letting the user instead *play back* what they heard, on the on-screen keyboard or
connected hardware, graded by the same `grading-engine` used elsewhere in the app.
The 32-key on-screen keyboard is still present on this screen in V1 as a reference
instrument (the user can tap notes to compare against the stimulus, with Show Note
Names applying as everywhere else). Session summary shows accuracy per
interval/quality, feeding the same per-skill Progress Analytics breakdown as other
lesson types (PRD F-03).

**Show Note Names.** A toggle, available wherever a keyboard is shown on screen (Ear
Training first, reusable anywhere else a keyboard renders), that labels every key with
its note name. It's an assist for beginners, not a separate mode — a session with it
on still earns XP and still counts toward unlocking harder tiers, so a beginner can
treat Ear Training as an approachable, rewarded activity from day one rather than
something to avoid until they're "ready." It's one account-level setting (not
reconfigured per session), so it applies consistently across every screen that shows a
keyboard.

### F-02b Sight-Reading
Short notated passages the user reads and plays in real time, graded by the same
`grading-engine` as F-02. **Playable with either input surface** — a connected MIDI
keyboard or the on-screen keyboard (32 keys free / 61 keys premium), which sits
directly below the staff on this screen. Tiers 1–3 passages are written to stay
within the 32-key range so a free user with no hardware can read and play every
one of them. Bass-clef passages now use the real bass staff (G2–A3), which the
narrower earlier range could not reach.

**Passage shape and reading difficulty by tier:**

| Tier | Notes | Key signature | Motion |
|---|---|---|---|
| 1 | **5** | C major only — no accidentals | Stepwise |
| 2 | 5 | **G, D, F or B♭** — the user must play the sharps or flats the key implies | Small leaps |
| 3 | 6 | Up to three accidentals | Wider leaps |
| 4 | 6 | Same, beyond the 32-key range — needs the 61-key keyboard | Wide |

**A key signature changes what you play, not just what you see.** From tier 2, a
passage in G major draws an F on the staff and expects F♯ from the keyboard — the
accidental is applied by the key, not written next to the note. This is the point of
the tier: reading a key signature is a distinct skill from reading note positions, and
it's why tier 2 is where the black keys first become mandatory.

**A wrong note restarts the passage; it does not end the exercise.** The user plays
from the first note again, and can keep going until they get through. Only a **clean
run — every note right, first time — earns the XP** (F-03). An earlier build ended the
exercise outright on the first wrong note, which made a single slip read as "everything
I press is wrong" and gave the user nothing to practise against. Restarting keeps the
passage in front of them, which is the thing that actually builds reading fluency.

**Each note lights up as it is played** — green on the staff and on the key — so the
user can see their position in the passage without counting. Clefs are drawn as proper
treble and bass clef symbols, and the key signature's sharps or flats are engraved at
the correct staff positions, in the standard order.
- **No manual setup screen** — tapping Sight-Reading from Home launches
  straight into a passage. Clef is picked for the user, randomly, **treble or bass**,
  every time the tile is tapped, so the two get roughly even practice over time without
  the user having to remember to switch. Difficulty is likewise not manually chosen —
  it tracks the user's currently-unlocked tier in this category (F-03) automatically.
- Passages are curated content (not procedurally generated, unlike F-02a), difficulty-
  tagged, and organized into this category's own XP-unlocked tier ladder (F-03).
- Grading covers note accuracy and rhythm/timing, consistent with F-02.

### F-02d Key Signatures
Read the signature, name the key. Multiple choice, on the same four-tier ladder and
the same XP rates as every other category (F-03).

**The answer is always a pair.** A signature with two sharps is D major *and* B minor
at the same time; asking for only one of them would be teaching a half-truth, so every
option reads "D major / B minor". This also removes an ambiguity that would otherwise
make some questions unanswerable.

| Tier | Signatures | Why this grouping |
|---|---|---|
| **1** | C / Am, G / Em, D / Bm | The three a beginner meets first — none, one sharp, two |
| **2** | A / F♯m, E / C♯m, B / G♯m, F / Dm | Where the relative minor is itself sharpened, which is the first genuinely confusing step — and F introduces the flat side |
| **3** | F♯ / D♯m, C♯ / A♯m, B♭ / Gm, E♭ / Cm, A♭ / Fm, D♭ / B♭m, G♭ / E♭m, C♭ / A♭m | Six and seven accidentals, and the whole flat side beyond F |
| **4** | All fifteen | Not recalling one signature but telling fifteen apart at speed — a different skill from any single tier |

**Tiers widen the pool rather than changing the task**, because identifying a
signature is recognition: what makes it hard is how many things it could have been.
Tiers 1–3 partition the fifteen with no overlap and no gaps, so a learner who
completes all three has met every signature exactly once before tier 4 mixes them.

**Distractors are near neighbours** on the circle of fifths wherever the tier's pool
allows it — if the answer is three sharps, the wrong options are two and four sharps.
Random distractors would let most questions be answered by roughly counting marks,
which tests nothing. Tier 1 offers three options rather than four, because its pool
*is* three signatures and a fourth would have to come from a tier not yet taught.

**Answering reveals the scale**, spelled through the signature — `A B C♯ D E F♯ G♯ A`
— with the reminder that its first and last note is the tonic. That is the method for
reading a key off the page rather than recalling it from a table, and it is also what
the Competition tiebreak asks for (F-13c).

### F-02c Playback & Repeat
Keyvoria's fourth category, and the home for both a procedurally-generated drill and
the bulk of F-01's authored play-along content (exercises, chord progressions,
classical pieces, original songs) — the throughline is "hear something, play it,"
whether that's a generated note sequence or a real piece of music.

**Repeat drill** (the procedurally-generated half): a call-and-response memory drill —
the system plays a short note sequence, then the user must play it back correctly —
on a connected MIDI keyboard **or** on the on-screen keyboard shown at the bottom of
the drill screen. Tapping the sequence back on screen is a fully supported way to
play this drill, not a degraded mode; generated sequences stay within the 32-key range for
tiers 1–3 so the free keyboard is always sufficient.
- **Difficulty tier**: Basic, Intermediate, or Advanced, chosen before starting —
  distinct from this category's XP-unlocked content tiers; this selector picks the
  drill's own internal difficulty once the Repeat drill itself is unlocked.
- Each correct round extends the sequence by one note and the drill continues; a
  round is graded via the same `grading-engine` note/timing matching used everywhere
  else. The session ends on the first incorrect repeat-back, and its score is how many
  rounds were survived plus the longest correct sequence.
- **Playback tempo increases automatically as the sequence grows**, at a rate set by
  the chosen difficulty tier (Advanced ramps faster than Basic) — this is what makes
  the drill get harder over a single session, not just across sessions.

**Play-along repertoire** (the authored half, F-01): exercises, chord-progression
lessons, classical pieces, and original songs, each graded via the shared
`grading-engine` the same way as everywhere else, organized into this category's
tier ladder alongside the Repeat drill.

### F-03 The XP economy — Keyvoria's primary progression system
**XP is a currency the user spends, not a score that just goes up.** This is
deliberate: a traditional "user level" would be a single number that only ever
increases and gates nothing in particular — that's exactly what V1 does *not* want,
because it makes XP cosmetic. Instead:

- **Earning — one rule, no exceptions.** XP is awarded for **one correct exercise,
  once**, at a flat rate set by the tier the exercise belongs to:

  | Tier | XP per correct exercise |
  |---|---|
  | 1 | **75** |
  | 2 | **100** |
  | 3 | 125 |
  | 4 | 150 |

  An incorrect exercise earns **nothing** — not a reduced amount, not a consolation
  award. Nothing else in the app grants XP either: no completion bonus for finishing
  a session, no streak XP, no daily-challenge bonus XP, no XP for free play. This
  retires the earlier draft's "streak bonus" and "daily challenge bonus XP" as
  *XP sources*; streaks and the daily challenge remain as engagement features, they
  simply don't mint currency. The reason to be strict here: every additional XP
  source silently devalues the unlock costs below, and a currency with many faucets
  stops feeling earned.
- **Spending.** Ear Training, Sight-Reading, and Playback & Repeat (not Learn My
  Music — see below) each have their own ladder of **tiers**, with fixed costs:

  | Tier | Unlock cost | Correct tier-1 exercises to afford it |
  |---|---|---|
  | 1 | **0** — unlocked from the start | — |
  | 2 | **750 XP** | 10 |
  | 3 | **1,250 XP** | 17 (or 13 correct tier-2 exercises) |
  | 4 | 2,000 XP **+ Keyvoria Premium** | 27 (or 16 correct tier-3 exercises) |

  Tier 1 is free and already unlocked in every category; each subsequent tier is
  **purchased** by spending accumulated XP — a deliberate, permanent "unlock" action the user chooses
  to take, not something that happens automatically the moment they've "earned
  enough." Unlocking a tier reveals a batch of harder lessons/challenges in that
  category.
- **One shared balance, spent on purpose.** XP is earned from any activity in any
  category and pooled into one balance, spendable on an unlock in *any* category.
  This is what creates real choice: a user can save toward an expensive Sight-Reading
  unlock instead of a cheaper Ear Training one, split spending across all three, or
  binge one category while ignoring another entirely — Keyvoria doesn't force an
  order.
- **The cost curve is what makes XP feel valuable.** Costs rise faster than earning
  rates: unlock costs step 750 → 1,250 → 2,000 (roughly 1.6×) while the per-exercise
  rate only steps 75 → 100 → 125 → 150. So each tier takes more real practice than
  the one before even though each exercise pays more — early unlocks come quickly and
  feel rewarding, later ones represent a genuine decision about where to invest. A
  flat or trivial cost curve would collapse this back into cosmetic points; that's
  the failure mode this is explicitly designed to avoid.
- **What "an exercise" means for XP.** One exercise is one graded item — a single
  interval identified, one passage played correctly end to end, one sequence repeated
  back. A practice session bundles five of them, so a flawless tier-1 session pays
  375 XP and two of them clear a tier-2 unlock. This is deliberately the unit the
  user experiences as "getting one right," so the reward lands immediately rather
  than being deferred to a session total.
- **Four tiers per category; tier 4 is premium.** Every tiered category has exactly
  four tiers. Tier 1 is free and pre-unlocked (0 XP). Tiers 2 and 3 are free-tier XP
  purchases. **Tier 4 — the bonus tier — is gated behind Keyvoria Premium *in addition
  to* its XP cost**, so a free user can save XP indefinitely and still not reach
  hardcore content without upgrading. That gate isn't arbitrary: tier 4 content is
  authored beyond the 32-key range, so it genuinely needs the 61-key keyboard that
  the same subscription unlocks (§1.4).
  Upload your file (F-05) doesn't participate in this tier/XP-unlock system at all —
  it's gated purely by the Premium subscription, since it's user-generated content
  with no authored difficulty ladder to unlock.
- **Level still exists, but only as flavor.** A lightweight, purely cosmetic Level
  (derived from lifetime XP ever earned — not current spendable balance) shows on
  the profile for a sense of overall progress and bragging rights. It gates nothing.
  The real progression state a user cares about is "which tiers have I unlocked in
  each category," not their Level number.
- Daily streaks with a grace/freeze mechanic (1 freeze earned periodically, to avoid
  punishing a single missed day too harshly).
- Achievements/badges (streak milestones, "first advanced-tier unlock in a category,"
  perfect-accuracy sessions, Upload your file milestones).
- Daily challenge: one bite-sized, auto-selected activity per day. Its exercises pay
  their normal per-tier rate when answered correctly and **nothing extra** — the
  draw is the prompt itself, not bonus currency (see the earning rule above).
- Progress tracking: both per-skill accuracy mastery (e.g. "chord voicings,"
  "sight-reading," "left hand independence" — *how good* the user is) and per-category
  XP balance/spend and unlocked-tier state (*how far* they've progressed) — these
  answer different questions and both show on Progress Analytics (screen map §3.6).

### F-04 Library
- Searchable/filterable catalog of all lessons, exercises, chord progressions, and
  songs (classical + original), filterable by difficulty, skill tag, genre, duration,
  category, and completion status.

### F-05 "Upload your file" (F-05) — Keyvoria Premium only
*"Upload your file" is the user-facing name; F-05 remains its ID throughout these
documents. Earlier drafts called it "Learn My Music" and "Submit Your Clip" — one
upload pipeline throughout, renamed twice.*
The fourth Home category, and Keyvoria's main conversion path. **It requires Keyvoria
Premium.** A free account sees the tile, taps it, and gets one screen naming the price
and what the subscription includes. There is no free upload.

**This supersedes the 30-second free preview.** An earlier draft let anyone upload a
song and practise its first 30 seconds, on the argument that letting someone play the
opening of *their own* song sells the subscription better than describing it. That
argument still holds, and it was overruled deliberately: Upload and Competition are now
the two things that define what paying for Keyvoria means, and a feature that is
partly free does not define anything. The decision is recorded here rather than
silently deleted, because the preview machinery still exists in the prototype and is
one condition away from returning if the conversion numbers argue for it.

What the free tier keeps is substantial and unchanged: **all four categories through
tier 3, on the 32-key keyboard, with no time limits, no lesson counts and no ads.**
That is the honest free product. Premium is tier 4, the 61-key keyboard, Upload your
file, and Competition Mode.

**The flow is Upload → Confirm → Tutorial.** The confirmation step is not a
formality; it is what stops the app from spending analysis effort, and the user's
patience, on the wrong song:

1. **Upload.** **MP3 audio** is the headline format (also M4A/WAV/AAC), with
   **MIDI/MusicXML** accepted where the user has them. Available on both the app and
   the website — the upload flow is the same code on every platform (architecture
   §2.1). **A free user meets the gate before the file picker**, not after: one screen
   naming $5.95/month and everything the subscription includes — Upload your file,
   Competition Mode, tier 4 and the 61-key keyboard. Subscribers skip it entirely;
   showing a paywall to someone who already paid is the fastest way to make a
   subscription feel worthless. The gate is worded as an offer rather than a refusal,
   and it names the whole subscription rather than only the feature that was tapped,
   so a user meets the full proposition once instead of a different fragment each
   time they hit a locked door.
2. **Confirm the song.** Keyvoria identifies what it thinks was uploaded — title and
   artist from audio fingerprinting/metadata, or the track name from a MIDI file —
   and **asks the user to confirm or correct it before building anything**. The user
   can edit the title inline. Getting this wrong silently would produce a tutorial
   labelled with someone else's song, which is worse than asking.
3. **Transcription produces two files**, and they are the point of the feature:
   - **A MIDI file** — the notes as structured data: pitch, start, duration, velocity,
     with the detected tempo. Openable in any DAW or notation program.
   - **Sheet music** — the same transcription engraved on a staff, wrapping across
     systems, with the clef chosen from the piece's own range.

   Both come from one analysis pass, so they can never disagree with each other or
   with the practice tutorial. Alongside them: difficulty analysis (note density, hand
   span, tempo, rhythmic and chord complexity), phrase segmentation for looping, and a
   gradable note sequence for the shared `grading-engine`.

   **Transcription time scales with the length of the recording** — a two-minute clip
   is quick, a full album track is not. The processing screen therefore shows a real
   progress state and the named stage it is on (reading, tempo/key detection,
   transcription, MIDI, engraving) rather than an indeterminate spinner, and it states
   an estimate up front. Symbolic input (MIDI/MusicXML) is far cheaper than audio,
   because there is nothing to transcribe — only to parse.

   The confirm screen shows exactly what will be produced — the note count, and the
   two output files. Everyone who reaches this screen is a subscriber, so there is no
   preview banner and no in-tutorial upgrade path to maintain.

**Playback speed is a fixed set of seven steps**, not a continuous slider. This
supersedes an earlier draft's "0.25×–2× continuous, YouTube-style":

| Slower — for learning | Normal | Faster — for pushing |
|---|---|---|
| **0.25× · 0.5× · 0.75×** | **1×** | **1.25× · 1.5× · 2×** |

Discrete steps beat a continuous slider here because a learner returns to *the same*
speed across sessions to measure progress, and "somewhere around 0.6" is not a
reference point they can return to. Pitch is preserved at every step — the song sounds
like itself, just slower.

- **Section looping** — auto-segmented by phrase/measure, loop points user-adjustable.
- **Progressive, hands-separate practice** (left alone / right alone / both).
- **Performance grading** against the uploaded material via the shared
  `grading-engine` (F-02), on the same keyboard as everything else.
- **Upload your file does not pay XP.** It is user-supplied content with no tier and no
  authored difficulty rating, so paying XP for it would let a user mint currency from
  a file they chose — see F-03's earning rule. Practice here is its own reward.

**Three ways to practise the same upload**, all from one analysis pass so the user can
switch freely:
  1. **Sheet Music** — the analysis rendered as notation on a grand staff.
  2. **Synthesia-style falling notes** — for users who don't read music.
  3. **Auto-Play** — Keyvoria plays it back so the user can listen and follow.

**Format determines confidence, not entitlement.** Every format is available to every
subscriber, but an **audio-sourced** tutorial carries a persistent
*Estimated transcription* banner because audio-to-score is best-effort; MIDI/MusicXML uploads are
exact and carry no banner. V1 does not attempt full generalized transcription of dense
polyphonic recordings (§1.6).

### F-05a Keyvoria Premium — the complete premium inventory
One place that answers "what does $5.95 buy," because the answer is now spread across
several features. Most of it is already specified; this table exists so the roadmap
plans the *gap*, not the whole list again.

| Premium feature | Status | Where |
|---|---|---|
| 61-key virtual keyboard | Specified | §1.4, F-02 |
| Tier 4 / Expert difficulty | Specified | §1.4, F-03 |
| Advanced Ear Training | Specified — tier 4 of F-02a | F-02a |
| Advanced Sight-Reading | Specified — tier 4 of F-02b | F-02b |
| Advanced Playback & Repeat | Specified — tier 4 of F-02c | F-02c |
| Advanced Key Signatures | Specified — tier 4 of F-02d | F-02d |
| **Upload your file** — upload your own music | Specified, **renamed** | F-05 |
| Adjustable playback speeds | Specified — seven fixed steps | F-05 |
| Section / measure looping | Specified | F-05 |
| Hands-separate practice | Specified | F-05 |
| Premium / master challenges | Specified — Master Mode | F-08 |
| Advanced song & exercise content | Specified — tier 4 content | F-01, F-04 |
| **Advanced performance analysis** | **New** | **F-09** |
| **Personalized practice recommendations** | **New** | **F-10** |
| **Create Music** — composition & notation | **New** | **F-11** |
| **Competition Mode** | **New** | **F-13** |

Two naming and scope notes, since both would otherwise create phantom work:

- **"Submit Your Clip" is Upload your file (F-05), not a second feature.** Same upload,
  same confirmation step, same tutorial. "Submit Your Clip" is the better label for the
  *entry point* — it says what the user does — so Home tile and marketing use
  it, while F-05 remains the feature ID the other documents reference. There is one
  upload pipeline, not two.
- **"Tier 4" applies to the four tiered categories.**
  Upload your file has no tier ladder by design (F-03) — it is user content with no
  authored difficulty to unlock. Its Premium equivalent is full-length songs plus the
  advanced practice tools — the category is Premium end to end, with no free tier of
  its own to measure against.

### F-06 Onboarding & assessment
- Goal selection (e.g. "play songs I love," "learn theory," "classical repertoire") —
  feeds an initial recommendation of which category to start spending XP in, not a
  fixed path assignment.
- Lightweight skill assessment (can be skipped) to grant a starting XP boost and/or
  pre-unlock an early tier or two in the relevant category, instead of always
  starting every category at tier 1.
- MIDI keyboard setup/pairing walkthrough, with a no-MIDI fallback path.

### F-07 Profile: overview, stats & subscription management
Keyvoria's third and last tab (screen map §3.8), and the only surface that reports on
the user rather than giving them something to do. It merges what an earlier draft
split between a Home/Dashboard tab and a thin settings-style Profile tab.

**Overview stats.** Three headline numbers, shown as equals:
- **Total XP earned** — lifetime XP, every point ever earned, which only rises.
  Deliberately distinct from the spendable balance on Home: this is "how much
  have I done," not "what can I afford." Both appear, labelled so the difference is
  legible (F-03).
- **Total hours practiced** — cumulative *active* practice time across every category.
  "Active" means time inside a session actually playing or answering, not time with
  the app open; a session idle past a timeout stops accruing (DB §4.10a). A number
  that inflates while the user makes tea is worse than no number.
- **Current streak**, with freeze status.

Below: per-category XP-spent and current tier, practice-time breakdown by category, a
recent-activity heatmap, achievements, and the recommended-next-unlock card (moved
here from the retired dashboard — it reports on progress, so it belongs with stats).

**Subscription management.** Its own section on Profile, one tap from the tab bar,
never buried under Settings — cancelling must not be harder to find than subscribing
was. For a subscriber it shows plan, price, renewal date, and a **Cancel
Subscription** action:
- **Access runs to the end of the paid period.** Cancelling never revokes Premium
  mid-cycle; the screen then reads "Premium until 14 March" with a **Resume** action for
  the remainder of that window.
- **The confirmation states both halves plainly.** What lapses at period end: tier 4
  relocks in all four categories, the on-screen keyboard returns to 32 keys, and
  Upload your file uploads become inaccessible. What does *not*: **XP, unlocked tiers
  1–3, progress, streaks and achievements are untouched, and uploaded files are
  retained rather than deleted** — resubscribing restores access instead of starting
  over. Users hesitate to cancel when they can't tell which it is, and being straight
  about it is both the honest version and the one that brings them back.
- **One confirmation step, no retention gauntlet.** A single "here's what you lose"
  screen is information; a chain of them is a dark pattern.
- **Where cancellation happens differs by store** (architecture §2.6a): web (Stripe)
  cancels in-app; iOS and Android subscriptions are owned by Apple/Google and can only
  be cancelled through their own subscription-management surfaces, so the button
  deep-links there, labelled so the handoff isn't a surprise. Entitlement is server-side, so a
  subscription bought on one platform is *visible* everywhere; when the user is on a
  platform other than the one they bought on, this section says where to cancel rather
  than offering a button that cannot work.

### F-08 Mastery, Master Mode & achievements
The endgame. F-03's XP economy answers "what do I unlock next"; this answers "what
happens when there's nothing left to unlock," and it has to make finishing Keyvoria
feel like an accomplishment rather than an ending.

**Mastery is earned at the keyboard, not bought.** This is the load-bearing decision
in the whole section. Unlocking a tier costs XP; **clearing** a tier costs correct
exercises — a fixed number of them played at that tier (suggest **12**, tunable). A
user with a huge XP balance can buy every tier in an afternoon and still hold no
mastery at all. Without this split, "Keyvoria Master" would be a purchase, and a
badge you can buy is worth nothing to the person who earned it.

| Award | Requirement |
|---|---|
| **Tier cleared** | Tier unlocked *and* 12 correct exercises played at that tier |
| **🎧 / 📖 / 🗝️ / 🔄 Category Master** | All four tiers cleared in that category |
| **🎹 Keyvoria Master** | All three Category Masters. Requires Premium, since tier 4 is premium |
| **💯 100% Curriculum Completion** | Keyvoria Master *and* at least one flawless (5/5) session in each category |
| **🏆 Perfect Score** | Any session answered 5 out of 5 |
| **✨ Exceptional Accuracy** | 95% or better across 50+ exercises |

100% Completion is deliberately *not* a synonym for Keyvoria Master: Master means you
finished everything, 100% means you also proved you could play each category
flawlessly at least once. Two different claims, so two different badges.

**Master Mode** unlocks per category the moment that category is mastered, plus a
**Mixed** mode once all three are. It is procedurally generated at expert difficulty
and never repeats a fixed set, so it does not run out:
- **Endless, streak-scored.** One wrong answer ends the run; the score is how many
  challenges you survived. This is what gives the endgame a number worth chasing and
  gives leaderboards something meaningful to rank.
- Correct challenges still pay tier-4 XP (F-03's earning rule is unchanged), so
  Master Mode keeps feeding lifetime XP after every tier is bought.
- It does **not** count toward tier clears — it sits after the curriculum, not inside
  it.

**Shareable achievement cards.** Every badge has a card: branded, dark, the
achievement's icon and title, one real statistic, and a Keyvoria keyboard motif.
Two rules govern them:
- **Nothing on a card identifies the account.** No email, no user ID, no handle
  derived from either. The only identity is a display name the user types themselves,
  and the default is no name at all ("A Keyvoria player"). Sharing an achievement must
  never be a privacy decision made on the user's behalf.
- **Locked cards are viewable but not shareable** — a user can see what they're
  working toward, greyed and marked, which is a better motivator than an empty slot.

**Leaderboards are opt-in and off by default.** Turning them on publishes exactly four
numbers under a chosen name: XP, accuracy, best Master Mode streak, and achievements
earned. Practice history, uploads, and account details are never published, and the
opt-in is reversible at any time. Ranking is available across four metrics so a
careful player and a prolific one both have a board they can win.

**Cosmetic rewards — deferred.** Keyboard themes were built and then **cut**: they
added a settings surface and a per-key styling path for a reward nobody had asked for,
and they competed for attention with the badges, which are the reward that actually
means something. The *channel* stays open — profile frames, backgrounds and unlock
animations are the natural candidates post-V1 — under the rule that made themes safe
in the first place: **cosmetics never affect grading, difficulty or XP**, which is what
lets them be given away generously without touching the economy.

### F-09 Advanced performance analysis — Premium
Free tier reports *what happened*: score, accuracy, XP. Premium explains *why*, using the
per-note data already captured in `attempts.note_events` (DB §4.8).

- **Timing profile** — a distribution of note onsets against the beat, which separates
  the two problems a single "rhythm: 72%" score hides: playing *inaccurately* (spread
  in both directions) versus playing *consistently early or late* (a shifted centre).
  Rushing is a habit; scatter is a control problem. They need different advice.
- **Per-skill accuracy over time**, not just a current number — a trend answers "am I
  improving" which a snapshot cannot.
- **Hand independence** where hands-separate data exists: accuracy for each hand alone
  against both together, which localises whether the difficulty is one hand or the
  coordination.
- **Consistency across attempts** — best score versus median. A user whose best is far
  above their median has the technique but not yet the reliability, and should be told
  that rather than shown only their best.

### F-10 Personalized practice — Premium
Analysis that does not change what the user practises next is just a dashboard. F-10
turns F-09's findings into a session.

- **Skill observations.** Every graded item is attributed to one or more skill keys —
  `chord.diminished`, `interval.tritone`, `sight.key.G`, `rhythm.eighth`,
  `hand.left` — and accumulated per user (DB §4.14). This is the substrate; without
  per-skill attribution at grading time there is nothing to recommend from later, so
  it must be written from the first graded exercise.
- **A weakness needs enough evidence to be a weakness.** A skill is only eligible for
  reporting or targeting after a **minimum observation count** (suggest 12). "Diminished
  chords: 64%" drawn from three attempts is noise, and telling someone they are weak at
  something on that basis is both wrong and discouraging. Below the threshold the skill
  reads as "not enough practice yet" — which is itself a useful, honest prompt.
- **The recommendation is a generated session**, not a list of percentages: pick the
  two or three eligible skills with the lowest accuracy, generate exercises that
  actually exercise them, and offer it as one tappable "Recommended session." It pays
  XP at the normal tier rate for the exercises it contains (F-03's earning rule is
  unchanged — nothing here mints XP by itself).
- **The user can always decline.** A recommendation is an offer on Home and
  Profile, never a redirect, and never the only way in. Keyvoria's whole progression
  model is "the user steers" (§1.1); an algorithm that quietly takes the wheel would
  contradict it.

### F-11 Create Music — Premium
A composer for keyboard players: play, record, edit, notate, save, export. The
reference point is the *workflow* of MIDI software like Logic Pro or Pro Tools —
record, then edit what you recorded on a grid — **not** their scope. Keyvoria is not
becoming a DAW: no audio tracks, no plugins, no mixing, no automation.

**What it does:**
- Play notes and chords on the virtual keyboard (61 keys, Premium) and **record** the
  performance.
- Build melodies and chord progressions across **multiple sections/measures**.
- **Edit after recording** — move, retune, lengthen, shorten, delete notes on a grid.
- Adjust **tempo, time signature and quantization**.
- **Save to the account**, replay, and continue editing later, on any device.
- **Generate readable standard notation automatically** from the recorded data.
- **Export** where technically supported: MIDI and MusicXML always; PDF/PNG of the
  score and an audio render where the platform allows it.

**The central rule: a composition is structured musical data, never only audio.**
Every composition is stored as notes with pitch, start, duration and velocity (DB
§4.13). This is what lets one composition later be replayed, edited, notated,
exported, and turned into practice material. An audio recording could do only the
first of those, and the decision cannot be reversed later — you cannot recover notes
from a mixdown. So it is settled here, at the start.

**Notation generation is a quantization problem, and quantization must be visible.**
Human playing is never metrically exact, and un-quantized MIDI cannot be written down
— it produces unreadable ties and tuplets. So the composer quantizes before notating.
Because quantization *changes what the user played*, it is an explicit setting with a
live preview (1/4 through 1/32, plus off), not a hidden step. A composer that silently
"corrects" someone's performance and shows them a score they did not play is a bug
they will not know how to report. The underlying performance is always retained
unquantized, so the setting is non-destructive and can be changed at any time.

**Modularity requirement.** Composition, notation, analysis and any later AI-assisted
features must attach to Keyvoria through the capability layer (architecture §2.10) and
their own packages — not by editing the learning engine. The test for this is
concrete: adding a future premium feature should require a new capability name, a new
package, and a new screen, with **no change to grading, XP, or the tier system**.

### F-12 Accounts, identity & privacy
Home now opens with **who you are**, so identity stops being a settings detail and
becomes part of the product's first screen.

**Sign-in options.** Email sign-up inside the app, **Continue with Google**, and
**Continue with Yahoo**. All three produce the same account; the provider is recorded
but never changes what a user can do. Playing without an account stays possible — the
sign-in prompt on Home is an offer, not a wall — because forcing registration before
anyone has heard a note costs more users than it saves.

**Two names, and they do different jobs.**
- **Name** — what Keyvoria calls you in the interface. From the provider, or typed.
- **Nickname** — the online persona, optional, and **used instead of the name wherever
  anyone else could see it**. Plenty of people will happily appear on a leaderboard as
  *clefhanger* and would not appear at all under their real name. Making the nickname
  the public identity, rather than a decoration, is what makes the public setting
  usable.

**Visibility is one setting, and it defaults to Private.**

| | Private *(default)* | Public |
|---|---|---|
| Achievement cards | "A Keyvoria player" | Your nickname (or name) |
| Leaderboards | Anonymous entry | Your nickname (or name) |
| Email address | Never shown | **Never shown** |

Three rules hold this together, and each exists because the alternative fails quietly:

- **Private is the default**, not an opt-out. A user who never opens settings is
  private, and nothing they do can publish their name by accident.
- **The email address is never public on either setting.** It is a credential and a
  contact route, never an identity others see. This is not a preference.
- **One function decides what others may see.** Every surface that could expose a
  name — cards, leaderboards, share text — reads the same `publicName()`; none reads
  the account directly. Privacy enforced at one call site cannot be forgotten at the
  next one, which is exactly how these leaks normally happen.

**Signing out keeps local progress** and clears the account, visibility and leaderboard
opt-in together — leaving a stale opt-in behind after a sign-out would publish a
stranger's numbers under the previous user's name.

### F-13 Competition Mode — Premium
Live head-to-head play, and one of the two features that require a subscription.
**Competition has three games.** They share matchmaking, lobbies, the 8-player cap and
the elimination rule, and differ in what they test and how they are won.

#### F-13a Reading Race — first to finish
Up to **8 players** race to perform the same passage, and **the first wrong note
eliminates you**. That single rule is what makes it a music game rather than a typing
race: speed alone loses, because the fastest player who slips is out while a slower
accurate one finishes.

| Level | Bars | Notes | Time | Key signature |
|---|---|---|---|---|
| 1 | 1 | 4 | **20s** | C |
| 2 | 2 | 8 | **30s** | C |
| 3 | 3 | 12 | **50s** | One sharp or flat (G, F) |
| 4 | 4 | 16 | **70s** | Two accidentals (D, B♭) |
| 5 | 5 | 20 | **90s** | Three accidentals (A, E♭) |

Four notes to the bar throughout, so the level number *is* the bar count. Time rises
faster than note count on purpose — level 5 gives 4.5s per note against level 1's 5s,
so the clock tightens as the reading gets harder rather than staying flat.

**Key signatures enter at level 3** and deepen through 5. This is the difficulty axis
that matters for a reading race: at levels 1–2 the passage is all white keys and the
challenge is pure speed, while from level 3 a player has to read the key and hit
accidentals under time pressure — a different and much harder skill.

#### F-13b Chord Race — last player standing
A chord is played; every player names its quality. **One wrong answer is out**, and the
**last player standing wins** — not the fastest. Where the Reading Race rewards speed
held together by accuracy, Chord Race rewards nerve: you can take your time, and taking
it is often the right call.

| Level | Chords | Time | Qualities |
|---|---|---|---|
| 1 | 8 | **40s** | Major, Minor |
| 2 | 10 | **55s** | + Major 7th, Minor 7th |
| 3 | 12 | **70s** | + Augmented, Diminished |

**Levels widen the pool rather than speeding anything up**, because what makes a chord
hard to name is how many things it could have been. Level 1 is the fundamental
major/minor distinction. Level 2 adds a fourth note and the third stops being the only
thing to listen for. Level 3 adds augmented and diminished, where the *fifth* stops
being a landmark — a different kind of listening again.

No quality appears three times in a row, so a player cannot answer by pattern instead
of by ear. Chords sound in root position with roots in C3–C4, which keeps the top of a
major 7th inside the free 32-key range — a race decided by whose keyboard rendered the
note would be a bad race.

**Chord Race needs no keyboard on screen**, which is what makes room for six answer
buttons and the live roster at the same time.

#### F-13c Key Signature Race — last player standing, then sudden death
**Ten questions.** A signature is shown; every player names the key. **One wrong
answer is out**, and the **last player standing wins**.

| Level | Questions | Time | Signatures in play |
|---|---|---|---|
| 1 | 10 | **60s** | C, G, D and their relative minors |
| 2 | 10 | **70s** | Up to five sharps, and the flat side begins with F |
| 3 | 10 | **80s** | All fifteen |

Levels are **cumulative**, not exclusive — level 2 still asks the level 1 signatures.
A player who has just learned G major should be able to answer one at level 2, and a
pool that excluded it would make the middle level harder than the top one for the
wrong reason.

**Sudden death.** Ten questions is short enough that a field of good readers can *all*
survive it, and a competition whose common outcome is "no winner" is broken. So a
round that ends with **two or more players still standing** — whether they answered
all ten or were still in when the clock ran out — goes to a tiebreak:

- **Thirty seconds.** Scales, one after another: *what key is this scale in?*
- **Most correct wins.** This is the format because the first and last note of a scale
  is its tonic (F-02d) — reading that off the page is the same skill under more
  pressure, not a different one.
- **Nothing is eliminated here.** A wrong answer costs the question and nothing else.
  Eliminating on a wrong answer would make the tiebreak a second elimination round
  rather than the count race it is; with two players left, the first to risk a guess
  would lose to someone who simply answered nothing.
- **A tie is broken by the player's own clock**, the same principle the main round
  uses. Still level, and it runs again — up to **three rounds**, after which a shared
  result stands. "Keep going until someone wins" is the kind of rule that loops
  forever the one time it matters, and a draw between two inseparable players is a
  better outcome than a match that never ends.

Unlike Chord Race, this game is **not meaningfully cheatable**: the client is sent a
signature to draw and four options to show, and neither reveals which option is right.
The answer exists only on the server.

#### Rules common to all three games
- **The round runs until a winner is named.** A match ends when a player completes it,
  when one player is left (Chord Race, Key Signature Race), when a tiebreak resolves,
  when everyone is eliminated, or when the clock expires — and the outcome is announced either way. "No winner" is a result, not a
  hang.
- **Eliminated players stay on screen**, greyed, showing how far they got. Watching the
  rest of the race is part of the appeal, and vanishing on your first mistake is a bad
  way to spend 90 seconds.
- **Competition awards no XP.** The result depends on who else is in the match, and
  F-03's rule is that XP is earned for *your own* correct exercises. A player who wins
  against weak opposition has not practised more than one who loses to strong
  opposition. Wins and best-progress are tracked separately and feed the leaderboards
  (F-08) instead.

**Eight players is a hard cap** (roadmap M7a supersedes an earlier "up to 16"): a
smaller lobby fills far faster at launch, keeps the whole roster on one phone screen,
and avoids turning most of the field into an audience the moment elimination starts.

**Opponents come from anywhere, not just the same room.** Most users practise alone, so
a same-room-only design would remove the feature's whole point. A **private lobby with
a share code** covers the classroom and the couch on the same matchmaking path — one
architecture, both cases.

**Timing is measured on each player's own device**, from the moment the round renders
to the moment they finish, and validated server-side. Scoring on server-received time
would hand every race to whoever has the shortest ping, which is not a musical skill.
A finish is held briefly before the match closes so other in-flight completions can
land and be ranked by their own clocks; without that hold, the local-clock rule does
nothing and latency decides the winner after all.

**Real-time multiplayer is a server feature** — matchmaking, lobbies, synchronised
start, and server-authoritative elimination so a tampered client cannot claim a win.
Until that lands, the mode is playable against simulated opponents, which exercises
every rule above except the networking.

**One honest limitation: Chord Race is cheatable in a way the Reading Race is not.**
The client has to be told which pitches to sound, and anyone reading those pitches can
compute the quality. Pre-rendered audio would not fix it, since audio can be analysed.
What the server does instead is reveal **one chord at a time at each player's own
position**, so a patched client cannot precompute a round, enforce a floor on plausible
answer time, and remain the only authority on correctness. That bounds the advantage
rather than removing it, and it is stated here rather than left for someone to
discover.

## 1.5 Non-functional requirements

- **Sound must work on a phone, unconditionally.** Keyvoria without audio is not a
  degraded app, it is a broken one — Ear Training, Playback & Repeat, Chord Race and
  the Key Signature tiebreak all *are* their sound. Three mobile failure modes have to
  be handled explicitly, because each one is total silence with no error anywhere:
  1. **The gesture rule.** No browser starts an audio context outside a real user
     interaction, and one created beforehand stays suspended. The app must create its
     context *inside* a gesture, not merely resume it there — Safari can leave a
     context created outside one permanently stuck.
  2. **The iOS ring/silent switch.** Web Audio plays in the "ambient" audio session
     category, which the physical switch mutes. A user on silent — most people, most
     of the time — hears nothing while every other part of the app works. The app must
     ask for the **playback** category (`navigator.audioSession` on iOS 16.4+) and,
     for older versions, hold the session with a silent looping media element.
  3. **Interruptions.** A call, a backgrounded tab or unplugged headphones suspend the
     context and nothing resumes it. The app must re-check on return and tell the user
     when sound is off, rather than failing quietly.
  Playback is scheduled on the **audio clock, not `setTimeout`** — phone browsers
  throttle timers, and an exercise whose notes arrive on a throttled timer comes out
  ragged or not at all. There must also be a way for a user to *test* sound and be
  told what is wrong, since "I hear nothing" is otherwise unactionable.
- **Latency:** MIDI note-to-feedback round trip must feel instantaneous for rhythm
  grading to be meaningful — target end-to-end input latency budget of ≤20ms added by
  the app on top of device/OS MIDI latency.
- **Offline-capable:** previously downloaded lessons/songs and progress recording must
  work with no network; sync when connectivity returns.
- **Accessibility:** color-blind-safe feedback (not color-only), scalable text,
  screen-reader-friendly navigation chrome (the notation/practice surface itself is
  necessarily visual, but all surrounding UI must be accessible).
- **Privacy:** uploaded MIDI/MusicXML/audio files are user content — stored
  encrypted at rest, deletable on request, never used for anything beyond the
  requesting user's own tutorials without explicit opt-in.
- **Licensing integrity:** public-domain classical pieces must be traceable to a
  verifiably PD source/edition; original songs and exercises are owned/licensed
  in-house. This gets tracked per-asset (see `songs.license_type` in the DB schema).
- **Cross-platform parity:** a lesson completed on one platform must show as complete
  everywhere once synced; the core practice/grading experience should not meaningfully
  differ between iOS, Android, and Web.

## 1.6 Explicitly out of scope for V1

- Social features (friends, leaderboards, sharing recordings) — may follow in V2.
- Live/synchronous teacher-led lessons or video calls.
- Instruments other than keyboard/piano (no guitar, no vocal).
- Marketplace/third-party content submission.
- Full generalized audio-to-score transcription for dense/polyphonic recordings —
  F-05's MP3 path is explicitly "best-effort" for V1, not a competitor to specialized
  transcription software.
- *(Resolved — kept here as a record.)* Per-tier XP costs and earn rates, which tiers
  are premium (always and only tier 4), and billing ($5.95/month) were all open in
  earlier drafts. All three are now fixed in F-03 and §1.4. What remains genuinely
  open is only the **tier-3 and tier-4 rates and cost** (125/150 XP and 2,000 XP),
  which extend the given curve and should be confirmed once tier-3+ content exists to
  play against.
