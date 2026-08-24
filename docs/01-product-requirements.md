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
| **Songwriter / Hobbyist Producer** | Wants to learn *their own* material | Learn My Music (F-05, MP3 + MIDI/MusicXML, **premium**) |
| **Genre Learner** | Wants pop/jazz/blues comping, not classical | Genre-tagged Playback & Repeat content and Library filters |

## 1.3 Platforms & shared codebase

iOS, Android, and Web from one primary codebase where practical (see
[Technical Architecture](./02-technical-architecture.md) for the concrete stack
decision). MIDI I/O and low-level audio are the parts that cannot be shared and get
thin, platform-specific implementations behind a common interface.

## 1.4 V1 feature scope

Feature IDs (`F-xx`) are referenced by the architecture and roadmap docs.

**The Main Menu is Keyvoria's home screen** (screen map §3.3) — the app opens directly
onto it, so a user's first interaction is choosing a program rather than reading a
dashboard. It absorbs both what an earlier draft called the separate "Learn tab"
(since the four categories below *are* the curriculum) and that draft's Home/Dashboard
tab, which sat in front of it and delayed the choice. V1 keeps it to exactly
Keyvoria's four major learning categories:

1. **Ear Training** (F-02a)
2. **Sight-Reading** (F-02b)
3. **Playback & Repeat** (F-02c)
4. **Learn My Music** (F-05) — **Premium**

Each category has its own progression, independent of the others (F-03) — a user
picks which skills to develop rather than being pushed through one linear
curriculum. There is deliberately no "Beginner/Intermediate/Advanced path" spanning
all categories at once; the closest earlier draft had one, and it's retired in favor
of per-category progression. Free/warm-up play remains cut from V1's Main Menu for
launch simplicity, revisitable post-V1.

**Free vs. Premium — Keyvoria Plus, $9.95/month.**

| | Free | Premium (Keyvoria Plus) |
|---|---|---|
| On-screen keyboard | **32 keys** (F2–C5), available in *every* category | **61 keys** (C2–C7), everywhere |
| Ear Training / Sight-Reading / Playback & Repeat | **Tiers 1–3**, XP-unlocked (F-03) | + **tier 4** — the bonus/hardcore tier in each category, which needs the 61-key range |
| Learn My Music (F-05) | Locked (paywall) | Unlocked — Keyvoria's primary premium feature |

**The tier rule is fixed and uniform:** every tiered category has exactly **four
tiers**. Tiers 1–3 are free (tier 1 costs 0 XP and is unlocked from the start; tiers
2 and 3 are XP purchases). **Tier 4 is always the premium tier** — it requires an
active Keyvoria Plus subscription *and* its XP cost. There is no per-category
variation in where the paywall falls, which keeps the offer explainable in one
sentence: *tiers 1–3 and 32 keys free; tier 4, the full 61-key keyboard and Learn My
Music for $9.95/month.*

The billing mechanic is a **$9.95/month subscription**. The XP numbers are now set
too (F-03) — earning rates and unlock costs are fixed values, not placeholders.

### F-01 Structured learning content
Content is organized **by category**, not by a level spanning all of them — each
item below belongs to exactly one of the three tiered categories (Learn My Music is
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
  entire free-tier curriculum — **tiers 1–3 in all three categories** — is authored
  to fit within those 32 keys, so a free user with no hardware can complete every free
  tier end to end. **The 61-key keyboard is available only on Keyvoria Plus**, and tier
  4 is where content is deliberately written beyond the 32-key range — which is why the
  two ship together in the same subscription rather than as separate perks.

### F-02a Ear Training: intervals & chord-quality drills
A configurable ear-training drill, launched from the Main Menu (screen map §3.3),
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
- **No manual setup screen** — tapping Sight-Reading from the Main Menu launches
  straight into a passage. Clef is picked for the user, randomly, **treble or bass**,
  every time the tile is tapped, so the two get roughly even practice over time without
  the user having to remember to switch. Difficulty is likewise not manually chosen —
  it tracks the user's currently-unlocked tier in this category (F-03) automatically.
- Passages are curated content (not procedurally generated, unlike F-02a), difficulty-
  tagged, and organized into this category's own XP-unlocked tier ladder (F-03).
- Grading covers note accuracy and rhythm/timing, consistent with F-02.

### F-02c Playback & Repeat
Keyvoria's third category, and the home for both a procedurally-generated drill and
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
  | 4 | 2,000 XP **+ Keyvoria Plus** | 27 (or 16 correct tier-3 exercises) |

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
  purchases. **Tier 4 — the bonus tier — is gated behind Keyvoria Plus *in addition
  to* its XP cost**, so a free user can save XP indefinitely and still not reach
  hardcore content without upgrading. That gate isn't arbitrary: tier 4 content is
  authored beyond the 32-key range, so it genuinely needs the 61-key keyboard that
  the same subscription unlocks (§1.4).
  Learn My Music (F-05) doesn't participate in this tier/XP-unlock system at all —
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
  perfect-accuracy sessions, Learn My Music milestones).
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

### F-05 "Learn My Music" — Premium
Keyvoria's **primary premium feature**, and the fourth Main Menu category. Reaching it
without an active subscription shows the paywall instead of the upload flow
(`entitlements`, DB §4.2).

**The flow is Upload → Confirm → Tutorial.** The confirmation step is not a
formality; it is what stops the app from spending analysis effort, and the user's
patience, on the wrong song:

1. **Upload.** **MP3 audio** is the headline format (also M4A/WAV/AAC), with
   **MIDI/MusicXML** accepted where the user has them. Available on both the app and
   the website — the upload flow is the same code on every platform (architecture
   §2.1).
2. **Confirm the song.** Keyvoria identifies what it thinks was uploaded — title and
   artist from audio fingerprinting/metadata, or the track name from a MIDI file —
   and **asks the user to confirm or correct it before building anything**. The user
   can edit the title inline. Getting this wrong silently would produce a tutorial
   labelled with someone else's song, which is worse than asking.
3. **Tutorial generation.** Difficulty analysis (note density, hand span, tempo,
   rhythmic and chord complexity), phrase segmentation for looping, and a gradable
   note sequence for the shared `grading-engine`.

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
- **Learn My Music does not pay XP.** It is user-supplied content with no tier and no
  authored difficulty rating, so paying XP for it would let a user mint currency from
  a file they chose — see F-03's earning rule. Practice here is its own reward.

**Three ways to practise the same upload**, all from one analysis pass so the user can
switch freely:
  1. **Sheet Music** — the analysis rendered as notation on a grand staff.
  2. **Synthesia-style falling notes** — for users who don't read music.
  3. **Auto-Play** — Keyvoria plays it back so the user can listen and follow.

**Format determines confidence, not entitlement.** Every format is behind the same
paywall, but an **audio-sourced** tutorial carries a persistent *Estimated
transcription* banner because audio-to-score is best-effort; MIDI/MusicXML uploads are
exact and carry no banner. V1 does not attempt full generalized transcription of dense
polyphonic recordings (§1.6).

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
  Deliberately distinct from the spendable balance on the Main Menu: this is "how much
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
- **Access runs to the end of the paid period.** Cancelling never revokes Plus
  mid-cycle; the screen then reads "Plus until 14 March" with a **Resume** action for
  the remainder of that window.
- **The confirmation states both halves plainly.** What lapses at period end: tier 4
  relocks in all three categories, the on-screen keyboard returns to 32 keys, and
  Learn My Music uploads become inaccessible. What does *not*: **XP, unlocked tiers
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
| **🎧 / 📖 / 🔄 Category Master** | All four tiers cleared in that category |
| **🎹 Keyvoria Master** | All three Category Masters. Requires Plus, since tier 4 is premium |
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

**Cosmetic rewards.** Keyboard themes (Classic Ivory, Midnight, Ember, Master Gold),
each gated behind a specific badge rather than a second currency. Cosmetics never
affect grading, difficulty, or XP — that separation is what keeps them safe to give
away generously. Profile frames, backgrounds, and unlock animations extend the same
pattern post-V1.

## 1.5 Non-functional requirements

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
  are premium (always and only tier 4), and billing ($9.95/month) were all open in
  earlier drafts. All three are now fixed in F-03 and §1.4. What remains genuinely
  open is only the **tier-3 and tier-4 rates and cost** (125/150 XP and 2,000 XP),
  which extend the given curve and should be confirmed once tier-3+ content exists to
  play against.
