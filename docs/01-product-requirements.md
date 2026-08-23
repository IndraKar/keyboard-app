# 1. Product Requirements Document (PRD)

## 1.1 Vision

**KEYFORGE** — *Forge Your Musical Mastery.*

A single, polished app that takes someone from "never touched a keyboard" to
confidently playing real songs, reading music, and improvising over chord changes,
using a MIDI keyboard for real-time feedback on notes, chords, rhythm, and timing. It
should feel closer to a well-designed game or fitness app (Duolingo / Yousician
territory) than a static video course: structured paths, instant feedback, visible
progress, and a reason to come back daily.

## 1.2 Target users

| Persona | Description | Primary needs |
|---|---|---|
| **Absolute Beginner** | Never played, doesn't read music, may not own a keyboard yet | Hand position, note names, simple songs, low intimidation |
| **Returning Player** | Took lessons years ago, rusty | Placement/assessment, refreshers on theory & technique, faster ramp |
| **Self-taught Improviser** | Plays by ear, weak on theory/reading | Chord progressions, theory, sight-reading, ear training |
| **Classical Track Student** | Wants repertoire and reading fluency | Public-domain classical pieces, hands-separate practice, grading |
| **Songwriter / Hobbyist Producer** | Wants to learn *their own* material | Learn My Music (F-05, MIDI/MusicXML) and Learn My Song (F-06, MP3/audio) |
| **Genre Learner** | Wants pop/jazz/blues comping, not classical | Genre-focused learning paths, chord-progression lessons |

## 1.3 Platforms & shared codebase

iOS, Android, and Web from one primary codebase where practical (see
[Technical Architecture](./02-technical-architecture.md) for the concrete stack
decision). MIDI I/O and low-level audio are the parts that cannot be shared and get
thin, platform-specific implementations behind a common interface.

## 1.4 V1 feature scope

Feature IDs (`F-xx`) are referenced by the architecture and roadmap docs.

A **Main Menu** screen (screen map §3.5) is the primary entry point into every
training session type below — Ear Training (both drill types), Sight Reading (both
clefs), Chord Progression Trainer, and Learn My Song — rather than those being buried
under a generic "Practice" label. It is not a separate feature so much as the
organizing surface for all of F-02a, F-02b, and F-06.

### F-01 Structured learning content
- 25–50 original learning exercises (technique, theory, rhythm, hand independence)
  spanning beginner → advanced.
- 25–50 chord-progression lessons (e.g. I–V–vi–IV, ii–V–I, 12-bar blues, modal vamps),
  each with theory explanation, listen-and-identify, and play-along with MIDI grading.
- 10–20 public-domain classical pieces (e.g. Bach Minuets, Clementi Sonatinas, Satie
  Gymnopédie No.1, Beethoven Für Elise excerpt, Joplin rags), sourced from verifiably
  public-domain editions (IMSLP or hand-engraved from PD scores — see licensing note
  below), each in MusicXML.
- 10–20 original practice songs, purpose-written to reinforce specific skills, licensed
  in-house (no third-party rights risk).
- Beginner, Intermediate, Advanced, and Genre-focused (at least 2 genres, e.g.
  Pop/Rock comping and Jazz basics) learning paths, each a sequenced curriculum of the
  content above plus theory/ear-training/sight-reading units.

  **DECISION NEEDED:** confirm which 2+ genre paths to prioritize for V1 (suggest
  Pop/Rock and Jazz-basics as most broadly useful; Blues and Classical-repertoire as
  fallback options).

### F-02 MIDI performance feedback
- Detect connected MIDI keyboard (USB and Bluetooth MIDI where the OS supports it).
- Real-time grading of: correct note(s), correct chord (right notes regardless of
  voicing/inversion where appropriate), rhythm accuracy (note onset vs. expected beat),
  and timing (early/late, with configurable tolerance).
- Visual feedback synced to input: falling-notes or on-staff highlighting, per-note
  hit/miss/early/late indicators, live accuracy meter.
- Works without a MIDI keyboard in a reduced mode (on-screen keyboard, self-graded)
  for theory/ear-training/sight-reading content that doesn't require live playing.

### F-02a Ear Training: intervals & chord-quality drills
A configurable ear-training drill, launched from the Main Menu (screen map §3.5) and
also offered as fixed, difficulty-ordered stops on the Beginner/Intermediate paths.
Two drill types, both configured before the session starts:

- **Note Intervals** — the system plays a stimulus of **2 to 8 notes**, chosen by the
  user with a stepper/slider:
  - **2 notes**: classic two-note interval identification (answer: interval name,
    e.g. major third, perfect fifth).
  - **3 notes**: a triad, graded by chord quality (see quality pool below).
  - **4–8 notes**: a short note sequence (played melodically); the user identifies
    the full chain of intervals between consecutive notes — this scales the same
    mechanic up into basic melodic dictation without introducing a new drill type.
  - A **Difficulty** setting (1–5, independent of note count) widens or narrows the
    interval range the stimulus is drawn from, adds/removes closely-confusable
    distractor choices, and adjusts playback tempo — so, for example, a 2-note drill
    at Difficulty 1 stays within an octave with obviously-different answer choices,
    while Difficulty 5 spans wider intervals with tighter distractors.
- **Chord Progressions** — the system plays a short sequence of chords; the user
  identifies each chord's quality in order. Quality pool is a multi-select over
  exactly four qualities: **Major, Minor, Augmented, Diminished** (chords are built
  only from selected qualities, so a beginner can start with Major vs. Minor and add
  Augmented/Diminished later). The same Difficulty 1–5 setting adjusts progression
  length and voicing complexity.

Mechanics common to both: each round plays the stimulus (repeatable via a "play
again" control) and presents multiple-choice answers; the session is self-graded (no
MIDI keyboard required, per F-02's reduced mode) — a stretch goal, not V1, is letting
the user instead play back what they heard on a connected MIDI keyboard, graded by the
same `grading-engine` used elsewhere in the app. Session summary shows accuracy per
interval/quality, feeding the same per-skill Progress Analytics breakdown as other
lesson types (PRD F-03).

### F-02b Sight Reading
Short notated passages the user reads and plays in real time, graded by the same
`grading-engine` as F-02 (this mode does expect a MIDI keyboard, unlike ear training).
- **Clef selector**: Treble, Bass, or Grand Staff (both clefs, hands together) — set
  before starting, since left-hand/bass-clef reading is a distinct skill most beginner
  content should isolate before combining.
- Passages are curated content (not procedurally generated, unlike F-02a), difficulty-
  tagged, and pulled into the Beginner/Intermediate/Advanced paths as well as offered
  as standalone drills from the Main Menu.
- Grading covers note accuracy and rhythm/timing, consistent with F-02.

### F-03 Gamification & progress
- XP awarded per completed lesson/exercise/song, weighted by difficulty and accuracy.
- Levels derived from cumulative XP.
- Daily streaks with a grace/freeze mechanic (1 freeze earned periodically, to avoid
  punishing a single missed day too harshly).
- Achievements/badges (skill milestones, streak milestones, genre completion, perfect
  scores, "Learn My Music" milestones).
- Daily challenge: one bite-sized, auto-selected exercise/song section per day.
- Progress tracking: per-skill mastery (e.g. "chord voicings," "sight-reading," "left
  hand independence"), visualized over time.

### F-04 Library
- Searchable/filterable catalog of all lessons, exercises, chord progressions, and
  songs (classical + original), filterable by difficulty, skill tag, genre, duration,
  and completion status.

### F-05 "Learn My Music"
- User uploads a MIDI file or MusicXML file of a song they want to learn.
- System analyzes and produces:
  - Difficulty rating (using note density, hand span, tempo, rhythmic complexity,
    chord complexity as inputs to a scoring heuristic).
  - Hands-separate practice mode (left hand alone / right hand alone / both).
  - Section looping (auto-segmented by phrase/measure, user-adjustable loop points).
  - Performance grading against the uploaded score using the same MIDI-feedback
    engine as F-02.
  - Adjustable playback/practice speed: 25%, 50%, 75%, 100% (pitch-preserved).
- Because this is a *symbolic* input format (MIDI/MusicXML), analysis is
  deterministic, not estimated — this is the higher-confidence path relative to F-06.

### F-06 Audio-file upload & analysis ("Learn My Song")
- User uploads an audio recording, typically an MP3, of a song they want to learn.
- System runs tempo/BPM detection and best-effort chord/note transcription (as
  before), then offers **three ways to learn the song**, all built on top of that one
  transcription pass so the user can freely switch between them for the same upload:
  1. **Sheet Music** — renders the transcription as notation (treble/bass grand
     staff, via the `notation` package) for users who want to read it.
  2. **Synthesia-style** — falling-notes/piano-roll practice, the same visual paradigm
     and controls as F-05's Tutorial Player (hands-separate, section looping,
     25/50/75/100% speed, performance grading against the transcription).
  3. **Auto-Play** — the app plays the transcribed performance back through a
     synthesized piano, with play/pause/scrub controls so the user can pause at any
     moment and listen/follow along at their own pace; note highlighting on the
     visual keyboard is shown alongside since the same rendering pipeline as mode 2
     already drives it.
  Section looping, tempo-adjusted playback, and speed control (25/50/75/100%) are
  available in all three modes, not just Auto-Play.
- **All transcription output must be clearly and persistently labeled as an estimate**
  (e.g. "Estimated — audio transcription is approximate" badge/banner, not a one-time
  toast) since audio-to-MIDI transcription accuracy varies significantly by recording
  quality and polyphony. This applies across all three modes, but matters most for
  Sheet Music, where a low-confidence transcription can render outright wrong notation
  — that mode should visibly flag (or decline to render) sections below a confidence
  threshold, rather than presenting a clean-looking score that's actually guesswork.
  Users can manually correct detected chords, and corrections should be able to feed
  back into all three modes once confidence is reasonable.

### F-07 Onboarding & assessment
- Goal selection (e.g. "play songs I love," "learn theory," "classical repertoire").
- Lightweight skill assessment (can be skipped) to place the user on a path instead of
  always starting at absolute zero.
- MIDI keyboard setup/pairing walkthrough, with a no-MIDI fallback path.

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
- Monetization/subscription billing mechanics — **DECISION NEEDED:** confirm whether
  V1 ships free, paid-up-front, or with a subscription paywall, since this affects the
  architecture's auth/entitlements layer. The architecture doc assumes a stubbed
  entitlements table that can support any of these later without a schema rewrite.
- Full generalized audio-to-score transcription for dense/polyphonic recordings —
  F-06 is explicitly "best-effort" for V1, not a competitor to specialized transcription
  software.
