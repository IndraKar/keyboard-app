# 4. Database Structure

PostgreSQL (via Supabase, per architecture §2.6). This document defines the V1 schema
at the entity/field level; exact migration files are a Milestone 1 deliverable.
Conventions: every table has `id uuid primary key default gen_random_uuid()`,
`created_at`/`updated_at timestamptz`, soft-deletes only where noted.

## 4.1 Entity-relationship overview

```mermaid
erDiagram
    USERS ||--o{ USER_PROGRESS : has
    USERS ||--o{ ATTEMPTS : makes
    USERS ||--o{ XP_EVENTS : earns
    USERS ||--o{ USER_ACHIEVEMENTS : unlocks
    USERS ||--|| STREAKS : has
    USERS ||--o{ USER_UPLOADS : uploads
    USERS ||--|| USER_LEVEL : has
    USERS ||--o{ DAILY_CHALLENGE_PROGRESS : tracks

    CATEGORY_TIERS ||--o{ LESSONS : unlocks
    CATEGORY_TIERS ||--o{ USER_CATEGORY_UNLOCKS : "purchased as"
    USERS ||--o{ USER_CATEGORY_UNLOCKS : purchases

    LESSONS ||--o{ ATTEMPTS : "attempted via"
    LESSONS }o--o{ TAGS : tagged

    LESSONS ||--o| EXERCISES : "type: exercise"
    LESSONS ||--o| SIGHT_READING_PASSAGES : "type: sight_reading"
    LESSONS ||--o| CHORD_PROGRESSION_LESSONS : "type: progression"
    LESSONS ||--o| SONGS : "type: song"

    CHORD_PROGRESSION_LESSONS }o--|| CHORD_PROGRESSIONS : uses

    SONGS ||--o{ SONG_SECTIONS : "segmented into"
    SONGS ||--o{ MEDIA_ASSETS : has

    ACHIEVEMENTS ||--o{ USER_ACHIEVEMENTS : "unlocked as"
    DAILY_CHALLENGES ||--o{ DAILY_CHALLENGE_PROGRESS : tracked_by

    USER_UPLOADS ||--o| GENERATED_TUTORIALS : produces
    GENERATED_TUTORIALS ||--o{ TUTORIAL_SECTIONS : "segmented into"
    GENERATED_TUTORIALS ||--o{ ATTEMPTS : "attempted via"

    EAR_TRAINING_DRILLS ||--o| LESSONS : "curated as (optional)"
    EAR_TRAINING_DRILLS ||--o{ EAR_TRAINING_SESSIONS : "played as"
    USERS ||--o{ EAR_TRAINING_SESSIONS : plays
    EAR_TRAINING_SESSIONS ||--o{ EAR_TRAINING_ROUNDS : contains

    USERS ||--o{ REPEAT_SESSIONS : plays
    REPEAT_SESSIONS ||--o{ REPEAT_ROUNDS : contains

    USERS ||--o{ ENTITLEMENTS : has
    USERS ||--o{ SUBSCRIPTIONS : "billed via"
    SUBSCRIPTIONS ||--o| ENTITLEMENTS : grants

    USERS ||--o{ PRACTICE_INTERVALS : accrues
    USERS ||--|| USER_STATS : "rolled up into"

    USERS ||--o{ USER_TIER_CLEARS : clears
    CATEGORY_TIERS ||--o{ USER_TIER_CLEARS : "cleared as"
    USERS ||--o{ MASTER_RUNS : plays
    USERS ||--|| USER_COSMETICS : equips
    USERS ||--|| SHARE_PREFERENCES : controls
    SHARE_PREFERENCES ||--o| LEADERBOARD_ENTRIES : publishes

    USERS ||--o{ COMPOSITIONS : writes
    COMPOSITIONS ||--o{ COMPOSITION_SECTIONS : "divided into"
    COMPOSITIONS ||--o{ COMPOSITION_TRACKS : contains
    COMPOSITION_TRACKS ||--o{ COMPOSITION_EVENTS : holds
    COMPOSITIONS ||--o{ COMPOSITION_EXPORTS : "rendered as"

    USERS ||--o{ SKILL_OBSERVATIONS : accumulates
    SKILL_DEFINITIONS ||--o{ SKILL_OBSERVATIONS : describes
    USERS ||--o{ PRACTICE_RECOMMENDATIONS : receives
    ATTEMPTS ||--o| ATTEMPT_ANALYSIS : "analysed into"
```

## 4.2 Identity & account

**`users`**
`id`, `email`, `display_name`, `auth_provider` (enum: email / google / yahoo), `created_at`, `last_active_at`,
`onboarding_completed_at`, `initial_goal` (enum: play_songs / theory_reading /
classical / improvise), `is_guest` (bool), `show_note_names` (bool, default false —
Home's global keyboard-label toggle from PRD F-02a; one setting, read by
every screen that renders a keyboard, not reconfigured per session).

**`entitlements`**
`id`, `user_id → users`, `plan` (enum: free / trial / paid — `paid` means an active
Keyvoria Premium subscription, $5.95/month per PRD §1.4), `starts_at`, `expires_at`.
This table answers only "what can this user access right now," so it stays small and
fast — it is read on nearly every gated action. The commercial state behind it
(provider, renewal date, cancellation) lives in `subscriptions` (§4.10b); cancelling
changes that table, and only the period-end job changes this one.
Gates three things: F-05 uploads in full (see `generated_tutorials` §4.11 for
exactly where that check happens — every upload type now, not just audio), the
on-screen keyboard's key range (the shared component reads `plan` at mount —
`plan = free` → 32 keys (F2–C5), otherwise → 61 keys, not a value stored per-user
elsewhere; note this gates *range only*, never the keyboard's presence, which is
unconditional on every play screen per PRD F-02), and every category's **tier 4**
(`category_tiers.required_plan = premium`, §4.9b) — a free user can hold any amount
of unspent XP and still can't purchase tier 4 without an active `paid` plan.

**`midi_devices`**
`id`, `user_id → users`, `device_name`, `transport` (usb / bluetooth), `last_connected_at`,
`measured_latency_ms` (nullable, from calibration flow).

## 4.3 Content

**`category_tiers`** — see §4.9b for the full spec (kept there, next to the XP
economy it powers, rather than here — cross-referenced from `lessons` below since
every curated lesson belongs to one).

**`lessons`**
`id`, `slug`, `title`, `type` (enum: exercise / chord_progression / theory /
ear_training / sight_reading / song), `tier_id → category_tiers` (**not** nullable —
every curated lesson belongs to exactly one category tier; there is no
"unattached" curated content in V1's model, per PRD F-01/F-03), `difficulty`
(1–10 int, fine-grained ordering *within* a tier — tiers are the coarse XP-unlock
boundary, `difficulty` is the finer sequencing inside one), `est_duration_seconds`,
`skill_focus` (text[] — e.g. `{rhythm, left_hand, chord_voicing}`), `description`,
`is_published`. Type-specific detail lives in the linked table (`exercises` §4.4,
`sight_reading_passages` §4.4a, `chord_progression_lessons` §4.5, `songs` §4.6, or
`ear_training_drills` §4.9 for the `ear_training` type) via `lessons.detail_id` +
`type`, not a giant nullable-column table.

**`tags`** / **`lesson_tags`** (join table `lesson_id`, `tag_id`) — powers Library
search/filter facets independent of `skill_focus` (tags are curator-facing/searchable;
`skill_focus` drives the Progress Analytics mastery breakdown).

### 4.4 Exercises

**`exercises`**
`id`, `lesson_id → lessons`, `midi_reference_asset_id → media_assets` (the expected
note/timing sequence the grading engine plays against), `instructions_md`,
`hand` (enum: left / right / both).

### 4.4a Sight reading passages

Supports PRD F-02b. Unlike ear training, these are curated content (like exercises),
not procedurally generated.

**`sight_reading_passages`**
`id`, `lesson_id → lessons`, `clef` (enum: treble / bass / grand_staff),
`key_signature` (enum: C / G / D / A / E / F / Bb / Eb / Ab — tier 1 passages are
always `C`; from tier 2 the key is what forces sharps or flats onto the keyboard, per
PRD F-02b, so this is a difficulty axis in its own right and not just engraving
metadata), `note_count`, `musicxml_asset_id → media_assets`,
`midi_reference_asset_id → media_assets` (expected note/timing sequence for grading,
same role as `exercises.midi_reference_asset_id` — note this stores *sounding* pitch,
so a passage in G major stores F♯ even though the score draws a plain F),
`measure_count`, `difficulty` (1–10). Home's Sight-Reading tile (screen map §3.3) queries `WHERE clef IN ('treble', 'bass')
AND lesson.tier_id IN <the user's currently-unlocked Sight-Reading tiers>` and picks
one at random — `grand_staff` passages exist in this table for tiers that
deliberately combine both clefs but aren't in that quick-launch pool, since PRD F-02b
only randomizes between the two single-clef options.

### 4.5 Chord progressions

**`chord_progressions`**
`id`, `slug`, `name` (e.g. "ii–V–I in C"), `roman_numerals` (text[]),
`key_signature`, `time_signature`, `midi_reference_asset_id → media_assets`.

**`chord_progression_lessons`**
`id`, `lesson_id → lessons`, `progression_id → chord_progressions`, `stage` (enum:
theory_explainer / listen_identify / play_along), `content_md`.

### 4.6 Songs (classical + original)

**`songs`**
`id`, `lesson_id → lessons` (every song belongs to a Playback & Repeat tier, per
§4.3's `lessons.tier_id`), `title`, `composer_or_artist`, `era` (nullable, classical
only), `category` (enum: classical_public_domain / original), `license_type` (enum:
public_domain / owned_original), `license_source_note` (text — PD edition citation, or
"composed in-house"), `musicxml_asset_id → media_assets`,
`midi_reference_asset_id → media_assets`, `audio_preview_asset_id → media_assets`.

**`song_sections`**
`id`, `song_id → songs`, `label` (e.g. "A section", "Verse 1"), `start_measure`,
`end_measure`, `sort_order` — powers the loop-region selector on the Practice Screen.

### 4.7 Media

**`media_assets`**
`id`, `kind` (enum: musicxml / midi / audio_preview / pdf / png), `storage_path`, `mime_type`,
`size_bytes`, `checksum`.

## 4.8 Progress, attempts, and grading history

**`user_progress`**
`id`, `user_id → users`, `lesson_id → lessons` (nullable), `generated_tutorial_id →
generated_tutorials` (nullable — exactly one of these two is set), `status` (enum:
not_started / in_progress / completed), `best_score` (0–100), `last_attempt_at`.
Unique on `(user_id, lesson_id)` and `(user_id, generated_tutorial_id)`.

**`attempts`**
`id`, `user_id → users`, `lesson_id → lessons` (nullable),
`generated_tutorial_id → generated_tutorials` (nullable), `started_at`, `completed_at`,
`accuracy_notes` (0–100), `accuracy_rhythm` (0–100), `accuracy_timing` (0–100),
`overall_score` (0–100), `note_events` (jsonb — the per-note hit/miss/early/late
detail from the grading engine, kept for the Progress Analytics breakdown and for
potential replay/review UI later), `input_source` (enum: midi_hardware / on_screen —
every lesson type is playable with either surface, per PRD F-02, and the two grade
under different timing tolerances, so the attempt records which one produced it).

## 4.9 Ear training drills

Supports PRD F-02a. Unlike exercises/songs/progressions, most sessions here are
user-configured at play time rather than pre-authored, so the schema models a
*drill configuration* plus a *played session* separately.

Sight-reading grading is **restart-on-error, not fail-on-error** (PRD F-02b): a wrong
note resets the passage to its first note and sets a "flawed" flag on the attempt.
The attempt still completes and is still recorded; only a run with no wrong notes
awards XP. `attempts.note_events` therefore records every wrong note across all
restarts, which is what makes "which note does this user keep missing" answerable.

**`ear_training_drills`**
`id`, `lesson_id → lessons` (nullable — set only for curated, tier-linked stops
within the Ear Training category; null for an ad-hoc config the user assembles from
Home, which spends no XP and unlocks nothing), `drill_type` (enum:
interval / chord_progression), `stimulus_note_count` (int, 2–8, applicable when
`drill_type = interval` — 2 = two-note interval, 3 = triad graded by chord quality,
4–8 = melodic interval-chain dictation), `allowed_qualities` (text[], subset of
`{major, minor, augmented, diminished}` — applicable when `drill_type =
chord_progression`, or when `drill_type = interval` and `stimulus_note_count = 3`),
`progression_length` (int, nullable — number of chords in sequence, applicable when
`drill_type = chord_progression`), `difficulty_level` (int, 1–5 — the user-facing
Difficulty dial from PRD F-02a; for curated, `lesson_id`-linked drills, the linked
`lessons.tier_id` is what actually gates access — this field is the *internal*
difficulty dial within an already-unlocked drill, distinct from the XP-cost tier
gate). A row is created for every session, curated or ad hoc, so
`ear_training_sessions` always has exactly one `drill_id` to reference regardless of
where the config came from.

**`ear_training_sessions`**
`id`, `user_id → users`, `drill_id → ear_training_drills`, `started_at`,
`completed_at`, `total_rounds`, `correct_count`, `accuracy` (0–100). This is the
per-session analog of `attempts` for this drill family; XP is awarded per session via
an `ear_training_session_complete` `xp_events.source` value (§4.10), referencing this
table rather than `attempts`.

**`ear_training_rounds`**
`id`, `session_id → ear_training_sessions`, `round_index`, `stimulus` (jsonb — the
generated notes/chord-quality sequence actually played, e.g.
`{"note_a": "C4", "note_b": "E4"}` for a 2-note interval, `{"root": "C4", "quality":
"minor"}` for a triad, `{"notes": ["C4", "E4", "G4", "B4", "D5"]}` for a 5-note
interval-chain dictation round, or `{"chords": [{"root": "C4", "quality": "major"},
{"root": "G4", "quality": "diminished"}]}` for a progression — generated at runtime by
the `core-theory` package, not pre-authored content), `correct_answer` (for
interval-chain rounds, the ordered list of interval names between consecutive notes),
`user_answer`, `is_correct`, `response_time_ms`.

### 4.9a Playback & Repeat: the Repeat drill

Supports PRD F-02c's procedurally-generated half of the Playback & Repeat category
(the authored half — exercises, chord progressions, songs — uses the ordinary
`exercises`/`chord_progression_lessons`/`songs` tables above, all linked into this
category's tiers via `lessons.tier_id`). A session is graded round-by-round via the
`grading-engine`, same as Sight-Reading and Exercises — against **live input from
either source**, hardware MIDI or the on-screen keyboard (PRD F-02), which is why
`repeat_rounds.note_events` below carries an input-source discriminator rather than
assuming hardware.

**`repeat_drills`**
`id`, `lesson_id → lessons` (nullable, same curated-vs-ad-hoc pattern as
`ear_training_drills` — set only when this specific drill config is the thing gating
a Playback & Repeat tier), `difficulty_tier` (enum: basic / intermediate / advanced),
`starting_tempo_bpm`, `tempo_ramp_bpm_per_round` (how much playback speeds up each
time the sequence grows by a note — set per tier, so Advanced ramps faster than
Basic per PRD F-02c).

**`repeat_sessions`**
`id`, `user_id → users`, `drill_id → repeat_drills`, `started_at`, `ended_at`,
`rounds_survived`, `longest_sequence_length`, `ended_reason` (enum: missed_note /
wrong_timing / quit). No `accuracy` column here unlike `ear_training_sessions` —
a Repeat session doesn't have a fixed round count to score a percentage against, it
just ends on the first miss, so `rounds_survived` is the score.

**`repeat_rounds`**
`id`, `session_id → repeat_sessions`, `round_index`, `sequence` (jsonb — the full
note sequence played this round, one note longer than the previous round),
`tempo_bpm`, `note_events` (jsonb, same per-note hit/miss/early/late shape as
`attempts.note_events` — this is what the live input was graded against),
`input_source` (enum: midi_hardware / on_screen — recorded per round because
on-screen input is graded with wider timing tolerances and no velocity, per PRD
F-02; keeping it here means analytics can compare the two without guessing),
`passed` (bool).

### 4.9b The XP economy: category tiers & unlock purchases

Supports PRD F-03 — the schema for "XP is a currency, not a score." Two tables, kept
next to the drill/content tables above rather than inside §4.10 Gamification, since
they're as much a *content-organization* structure (what tier does a lesson belong
to) as a gamification one.

**`category_tiers`**
`id`, `category` (enum: ear_training / sight_reading / playback_repeat — exactly
Keyvoria's four tiered categories; Upload your file has no tier ladder, it's gated
purely by `entitlements`, §4.11), `tier_number` (int, **1–4** — every category has
exactly four tiers, per PRD §1.4), `title`, `description`, `xp_cost` (int),
`required_plan` (enum: free / premium). Unique on `(category, tier_number)`. Every
curated `lessons` row (§4.3) belongs to exactly one of these via `lessons.tier_id`.

The tier rule is uniform across all four categories, and seed data must satisfy it
(worth a CHECK constraint or a seed-validation test, since the whole pricing story
depends on it holding):

| `tier_number` | `xp_cost` | `xp_per_correct_exercise` | `required_plan` | Unlocked how |
|---|---|---|---|---|
| 1 | `0` | `75` | `free` | Pre-unlocked for every user; no purchase row needed |
| 2 | `750` | `100` | `free` | XP purchase |
| 3 | `1250` | `125` | `free` | XP purchase |
| 4 | `2000` | `150` | `premium` | XP purchase **and** active Keyvoria Premium |

`xp_per_correct_exercise` is a column on `category_tiers`, not a constant in client
code — the whole economy is then tunable by a content migration rather than an app
release, and the server can validate an award against the tier the exercise actually
belongs to instead of trusting a client-supplied amount.

Tier 4 is what PRD F-03 calls "premium sits on top of XP, not instead of it": it
still costs `xp_cost` XP *and* requires the entitlement. It's also the only tier
whose content may exceed the 32-key range, which is why it pairs with the 61-key
keyboard the same subscription unlocks.

**`user_category_unlocks`**
`id`, `user_id → users`, `tier_id → category_tiers`, `xp_spent` (int — a snapshot of
`category_tiers.xp_cost` at purchase time, so a later cost-curve rebalance in content
production doesn't retroactively rewrite what a past purchase "cost"), `unlocked_at`.
Unique on `(user_id, tier_id)`. Purchasing is a single transaction: verify the user's
current balance covers `xp_cost` (and, if `required_plan = premium`, verify
`entitlements`), insert this row, and from that point every lesson under that tier is
accessible. This never happens automatically on lesson completion — it's a deliberate
action the user takes from that category's tier-ladder screen (screen map §3.3).

**Computing a user's spendable XP balance** — never stored directly, always
`sum(xp_events.amount) − sum(user_category_unlocks.xp_spent)` for that user,
computed server-side at request time (or cached briefly, never trusted from a
client), same never-trust-the-client rule that already governs `xp_events` below.
This is distinct from **lifetime XP** (`sum(xp_events.amount)` alone, with nothing
subtracted), which is what the purely-cosmetic Level (`user_level`, §4.10) is derived
from — spending XP on an unlock doesn't demote a user's Level, since Level reflects
effort put in, not currency currently on hand.

## 4.10 Gamification

**`xp_events`**
The **earning** ledger only. One row per *correct exercise*, and nothing else writes
to it — see PRD F-03's earning rule. `amount` must equal the
`category_tiers.xp_per_correct_exercise` of the tier the exercise belonged to, checked
server-side; a client never supplies the number. — spending is tracked separately in
`user_category_unlocks` (§4.9b), not as a negative row here, so this table never
needs negative `amount` values and always reads as "here's everything a user has
ever earned."
`id`, `user_id → users`, `attempt_id → attempts` (nullable),
`ear_training_session_id → ear_training_sessions` (nullable — set instead of
`attempt_id` for §4.9 sessions), `repeat_session_id → repeat_sessions` (nullable —
set instead of `attempt_id` for §4.9a sessions; a session with `show_note_names` on
still generates one of these per PRD F-02a — the toggle changes nothing about how XP
is earned), `source` (enum: lesson_complete / daily_challenge / achievement /
streak_bonus / ear_training_session_complete / repeat_session_complete), `amount`,
`created_at`, plus `exercise_correct` (bool — always true in V1, present so a later
change of policy doesn't require a migration to record graded-but-unrewarded attempts).
Note the `source` enum above is now narrower in practice than it reads: `streak_bonus`
and `daily_challenge` are **retired as XP sources** (PRD F-03) and no code path emits
them; they stay in the enum only so historical rows from earlier builds remain valid.
Both a user's spendable balance and lifetime total are always computed
from this table server-side (§4.9b) — never a client-writable counter (per
architecture §2.7).

**`user_level`**
`user_id → users` (PK), `current_level`, `current_xp_into_level` — derived purely
from **lifetime** XP (`sum(xp_events.amount)`, unaffected by spending), recomputed by
the same job that inserts events. This is explicitly **cosmetic** (PRD F-03) — it
gates nothing in the app; the real progression state is per-category unlocked tiers
(`user_category_unlocks`, §4.9b). Kept as its own small table (rather than computed
on every read) purely for fast dashboard reads.

**`streaks`**
`user_id → users` (PK), `current_streak_days`, `longest_streak_days`,
`last_practice_date`, `freezes_available`, `freezes_used_total`.

**`achievements`**
`id`, `slug`, `title`, `description`, `icon_asset`, `criteria` (jsonb — rule
definition evaluated by the `gamification` package, e.g.
`{"type": "streak_reached", "days": 30}` or `{"type": "tier_unlocked", "category":
"sight_reading", "tier_number": 3}`).

**`user_achievements`**
`id`, `user_id → users`, `achievement_id → achievements`, `unlocked_at`. Unique on
`(user_id, achievement_id)`.

**`daily_challenges`**
`id`, `challenge_date` (date, unique), `lesson_id → lessons` (nullable),
`generated_selection_rule` (jsonb, for auto-picked-per-user challenges if V1 does
personalized rather than global-per-day challenges — **DECISION NEEDED:** confirm
whether the daily challenge is the same for all users on a given date or personalized;
schema supports either, but it changes how `daily_challenges` vs.
`daily_challenge_progress` are populated).

**`daily_challenge_progress`**
`id`, `user_id → users`, `daily_challenge_id → daily_challenges`, `completed_at`,
`attempt_id → attempts`.

## 4.10a Practice time (Profile's "total hours")

Supports PRD F-07's headline stat. Every session type already carries start/end
timestamps (`attempts`, `ear_training_sessions`, `repeat_sessions`), so raw duration
is derivable — but two problems make a naive `sum(ended_at - started_at)` the wrong
answer, and both are why this gets its own structure:

1. **Idle time inflates it.** A session left open while the user walks away would
   count. Practice time must be *active* time.
2. **Summing three tables on every Profile load is wasteful**, and gets worse as
   history grows — Profile is a frequently-visited tab.

**`practice_intervals`**
`id`, `user_id → users`, `category` (enum, nullable — null for Upload your file and
Library practice, which sit outside the four tiered categories), `source_type`
(enum: attempt / ear_training_session / repeat_session / learn_my_music),
`source_id` (uuid, the row in whichever table above), `started_at`, `ended_at`,
`active_seconds` (int). Written once when a session closes.

`active_seconds` is **not** `ended_at − started_at`: the client accumulates it while
the session is actually receiving input or presenting a stimulus, and pauses
accumulation after an idle timeout (suggest 90s of no interaction, tuned in QA) and
whenever the app is backgrounded. It is also clamped server-side to the wall-clock
span, so a buggy or tampered client cannot report more active time than elapsed.

**`user_stats`**
`user_id → users` (PK), `total_active_seconds`, `total_active_seconds_by_category`
(jsonb), `lifetime_xp`, `sessions_completed`, `updated_at`. A rollup maintained
incrementally as each `practice_intervals` row lands, so Profile reads one row.
Rebuildable from `practice_intervals` + `xp_events` at any time — it is a cache, never
a source of truth, and a periodic job re-derives it to catch drift.

`lifetime_xp` is duplicated here (it is also `sum(xp_events.amount)`) for the same
read-performance reason as `user_level`, and under the same rule: any *decision* —
what a user can afford, whether an unlock is permitted — reads the ledger, never this
table (§4.9b).

## 4.10b Subscriptions & billing state

Supports PRD F-07's subscription management. `entitlements` (§4.2) answers "what can
this user access right now" and stays deliberately small and fast, since it is checked
on nearly every gated action. This table answers the separate question of "what is the
state of their commercial relationship," which is where cancellation lives.

**`subscriptions`**
`id`, `user_id → users`, `provider` (enum: stripe / apple_app_store / google_play),
`provider_subscription_id` (text — the id in that provider's system),
`purchase_platform` (enum: web / ios / android — where it was bought, which
determines where it can be cancelled), `status` (enum: active / trialing /
cancel_pending / expired / grace_period / billing_retry), `price_cents` (`595` for
Keyvoria Premium at $5.95/month), `currency`, `current_period_start`, `current_period_end`,
`cancel_at_period_end` (bool), `cancelled_at` (nullable — when the user *requested*
cancellation, distinct from when access ends), `created_at`, `updated_at`.

Notes that matter for the cancel flow:

- **Cancellation sets `cancel_at_period_end = true`; it does not touch
  `entitlements`.** Access continues until `current_period_end`, at which point the
  provider webhook moves `status` to `expired` and a job downgrades `entitlements.plan`
  to `free`. This is what makes "Premium until 14 March" truthful rather than a UI
  fiction. Resuming before that date clears the flag with no billing event at all.
- **Only `provider = stripe` can be cancelled by our backend.** Apple and Google own
  their subscriptions; there is no server-side cancel API for them, so the app
  deep-links to their management surfaces and waits for the webhook. `purchase_platform`
  is what the Profile screen reads to decide which of those it is showing (screen map
  §3.8.1).
- **Webhooks are the source of truth for `status`,** not client reports — a client
  saying "I cancelled" is a hint to refetch, never an authority to downgrade.
- **A row is never deleted on cancellation.** History is kept, so a resubscribing user
  is recognizable as returning and their prior period is auditable. Multiple rows per
  user are expected over time; the current one is the row with the latest
  `current_period_end`.
- **Downgrading never destroys user data** (PRD F-07): `xp_events`,
  `user_category_unlocks` for tiers 1-3, `user_progress`, `streaks`, and
  `generated_tutorials`/uploaded files all survive. The only effect of an expired
  entitlement is gating — tier 4 becomes unpurchasable/unenterable, the keyboard
  renders 32 keys, Upload your file locks. Resubscribing restores access with nothing
  to rebuild.

## 4.10c Mastery, achievements & Master Mode

Supports PRD F-08. The central rule — mastery is played, not purchased — is enforced
by keeping *clears* in their own table rather than inferring them from
`user_category_unlocks` (which only records XP spend).

**`user_tier_clears`**
`user_id → users`, `tier_id → category_tiers`, `correct_count` (int, incremented once
per correct exercise attributed to that tier), `cleared_at` (nullable — stamped when
`correct_count` first reaches the tier's `clear_target`). Primary key
`(user_id, tier_id)`. `category_tiers` gains `clear_target` (int, default 12) so the
requirement is content data, tunable per tier without a release.

A category is mastered when all four of its tiers have a non-null `cleared_at`.
Keyvoria Master is all three. Both are **computed, never stored as a flag** — a stored
flag drifts the moment `clear_target` is retuned.

**`achievements`** (extends §4.10) gains `share_icon` (text, the emoji), `share_blurb`
(text), and `is_headline` (bool — the Keyvoria Master card is styled differently).
`user_achievements` already carries `unlocked_at`, which is what the card prints.

**`master_runs`**
`id`, `user_id → users`, `category` (enum: ear_training / sight_reading /
playback_repeat / mixed), `streak` (int — challenges survived), `xp_earned`,
`started_at`, `ended_at`, `ended_reason` (enum: wrong_answer / quit). Best streak per
category is `max(streak)` over this table, not a separate column.

**`user_cosmetics`** — *not in V1.* Keyboard themes were cut (PRD F-08), and no other
cosmetic shipped, so the table has nothing to hold. Kept here as a named placeholder
so a later profile frame or background has an obvious home: `user_id → users`,
`profile_frame`, `background`, `unlocked_cosmetics` (text[]).

**`share_preferences`**
`user_id → users` (PK), `leaderboard_opt_in` (bool, default **false**), `opted_in_at`
(nullable). The public *name* is no longer stored here — it is derived from
`users.nickname` / `users.display_name` gated by `users.profile_visibility` (PRD F-12),
so there is exactly one place a name can become public. An earlier draft kept a
separate `display_name` on this table; two copies of "what may others see" is two
things to keep in sync, and the one that drifts is the one that leaks.

Card and leaderboard rendering must resolve identity through the single
`public_name(user)` helper — never by reading `users` columns directly. `email` is not
readable by that path at all, on either visibility setting.

**`leaderboard_entries`** (materialised, refreshed periodically)
`user_id → users`, `display_name` (snapshot from `share_preferences`), `lifetime_xp`,
`accuracy_pct`, `best_master_streak`, `achievement_count`, `updated_at`. Rows exist
**only** for users with `leaderboard_opt_in = true`; opting out deletes the row rather
than hiding it.

## 4.11 Upload your file

Every upload type here (`midi` / `musicxml` / `audio`) is gated the same way now —
PRD F-05 is one unified premium feature, not a free-MIDI/paid-audio split. The API
checks `entitlements` (§4.2) for the requesting user before accepting *any* upload or
serving a `generated_tutorials` row, regardless of `upload_type`.

**`user_uploads`**
`id`, `user_id → users`, `upload_type` (enum: midi / musicxml / audio),
`original_filename`, `storage_path`, `status` (enum: processing / ready / failed),
`created_at`.

**`user_uploads`** gains the confirmation step from PRD F-05: `detected_title`,
`detected_artist` (both nullable — what identification proposed), `confirmed_title`
(text, set by the user on the confirm screen), `confirmed_at` (nullable), and
`source_format` (enum: audio / midi / musicxml). **Tutorial generation does not start
until `confirmed_at` is set** — that ordering is the point of the step, since building
against a misidentified song wastes the analysis and mislabels the result.

`generated_tutorials` are built **in full regardless of plan** — the 30-second free
limit (PRD F-05) is applied at *read* time from `entitlements`, never by truncating
what is stored. Storing a truncated tutorial would mean regenerating it on upgrade,
which is both slower and a worse moment to fail.

Each confirmed upload yields **two derived artifacts**, stored as `media_assets` rows
linked from the tutorial: a **MIDI file** (`kind = midi`) and **engraved sheet music**
(`kind = musicxml`, plus a rendered `pdf`/`png` where the platform supports export).
They are generated from one analysis pass and regenerated together, so they can never
drift apart or disagree with the practice sequence. Both are cached artifacts, safe to
delete and rebuild from `generated_tutorials`.

**`generated_tutorials`**
`id`, `user_upload_id → user_uploads`, `title` (from filename or embedded metadata),
`difficulty_rating` (1–10, from the `analysis` package heuristic), `difficulty_factors`
(jsonb — note density, hand span, tempo, chord complexity breakdown, kept for
transparency/debuggability of the rating), `detected_tempo_bpm`, `hands_separate_available`
(bool), `is_estimated` (bool — **true for audio-sourced tutorials, false for
MIDI/MusicXML-sourced**; this is the field the UI's "Estimated" badge reads from, per
PRD F-05 — format determines confidence, not entitlement, since both formats are
premium now), `sheet_music_available` (bool — false when transcription confidence is
too low to render notation responsibly; gates whether the Sheet Music mode card in
the screen map's Mode Select is enabled or shown disabled with an explanation. The
Synthesia-style and Auto-Play modes have no equivalent gate — they degrade
gracefully with a rougher transcription in a way that mis-rendered notation cannot).

**`tutorial_sections`**
`id`, `generated_tutorial_id → generated_tutorials`, `label`, `start_time_ms`,
`end_time_ms` (audio-sourced) or `start_measure`/`end_measure` (symbolic-sourced),
`sort_order` — same role as `song_sections` but for user-generated content; kept as a
separate table rather than unifying with `song_sections` since the two have different
population pipelines (curated authoring vs. auto-segmentation) even though the
Practice Screen consumes both through the same loop-selector UI.

**`estimated_chord_labels`** *(audio uploads only)*
`id`, `generated_tutorial_id → generated_tutorials`, `start_time_ms`, `end_time_ms`,
`chord_label`, `confidence` (0–1, from the transcription model), `user_corrected`
(bool) — supports the "manually correct obviously-wrong chord labels" interaction from
the screen map's Upload your file flow.

## 4.11a Competition Mode (PRD F-13)

**`competition_matches`**
`id`, `game` (enum: reading / chords — the two Competition games, PRD F-13a/F-13b),
`level` (1–5 for reading, 1–3 for chords; a CHECK enforces the per-game ladder length so
a level 5 chord match cannot be stored and then fail to generate), `key_signature` and
`clef` (**nullable — reading only**; a chord round has neither, and a second CHECK ties
both columns to `game = 'reading'` rather than leaving them meaninglessly empty),
`passage` (jsonb — the round every player receives, generated server-side so no client
can see it early), `player_count` (2–8; **8 is a hard cap**, clamped server-side — roadmap M7a),
`lobby_kind` (enum: matched / private), `join_code` (nullable — set for private
lobbies, which is how "everyone in one room" is served without a separate local
transport), `started_at`, `ended_at`, `winner_user_id` (nullable — null
when the clock expires with nobody finished), `end_reason` (enum: completed /
all_eliminated / timeout / **last_standing** — the last of these is how a Chord Race
normally ends, with one player left rather than a round completed).

**`competition_entrants`**
`match_id → competition_matches`, `user_id → users`, `notes_correct` (int — notes in a
Reading Race, chords named in a Chord Race; one counter, since the engine treats both as
"answers correct so far"), `eliminated_at_note` (nullable), `finished_at` (nullable),
`placement` (int), `client_elapsed_ms` (int — measured on the player's own device from
the round rendering to completion). **Ranking uses `client_elapsed_ms`, not server arrival time**, so a player
on a slow connection is not beaten by their ping (PRD F-13); the server validates it
against the match window and rejects impossibly fast values.
Primary key `(match_id, user_id)`.

**Elimination is decided server-side.** The client reports key presses (or named chord
qualities); the server holds the round and rules on them. A client-authoritative match would be trivially
winnable by editing the page, and a competitive mode that can be cheated is worth less
than no competitive mode at all.

**No `xp_events` rows are ever written for a match** (PRD F-13) — competition results
depend on the opposition, and XP is only earned for a user's own correct exercises
(§4.10). Wins surface through `competition_entrants` and the leaderboards (§4.10c).

## 4.12 Search

V1 uses Postgres full-text search (`tsvector` generated column on
`lessons.title || songs.title || tags`) rather than standing up a separate search
service — sufficient for a catalog on the order of low hundreds of items at V1 scale.
Revisit only if Library search quality/performance becomes a problem post-launch.

## 4.13 Compositions (PRD F-11)

**A composition is structured musical data, never an audio blob.** Notes are rows, not
samples — that is what lets one composition be replayed, edited, notated, exported and
practised. Recovering notes from a mixdown is not possible, so this is settled here
rather than left to the implementation.

**`compositions`**
`id`, `user_id → users`, `title`, `tempo_bpm` (numeric), `time_signature` (text, e.g.
`4/4`), `key_signature` (text, drives enharmonic spelling in notation),
`ppq` (int, ticks per quarter note — default 480; stored per composition so a later
change of resolution cannot silently reinterpret existing rows), `quantize_grid`
(enum: off / q4 / q8 / q8t / q16 / q32 — a *view* setting, see below), `created_at`,
`updated_at`, `schema_version` (int).

**`composition_sections`**
`id`, `composition_id → compositions`, `name` (e.g. "Verse", "Chorus"), `index`,
`start_tick`, `length_ticks`. Sections are the composer's structural unit and the loop
targets on the practice screen.

**`composition_tracks`**
`id`, `composition_id → compositions`, `name`, `role` (enum: left_hand / right_hand /
both / other), `muted` (bool), `index`. `role` is what makes hands-separate practice
(F-05) work on a user's own composition with no extra machinery.

**`composition_events`**
`id`, `track_id → composition_tracks`, `section_id → composition_sections` (nullable),
`pitch` (int, MIDI note), `start_tick` (int), `duration_ticks` (int), `velocity` (int
0–127). Indexed on `(track_id, start_tick)`.

**`start_tick` and `duration_ticks` store what was actually played, unquantized.**
`compositions.quantize_grid` is applied on the way *out* — to notation, playback and
export — never written back. Two reasons this matters: the user can change the grid at
any time without having destroyed the take, and a better quantizer shipped later
improves every existing composition rather than only new ones.

**`composition_exports`**
`id`, `composition_id → compositions`, `format` (enum: midi / musicxml / pdf / audio),
`storage_path`, `size_bytes`, `generated_at`. Exports are cached artifacts, not
sources — deleting one is always safe because it can be regenerated from the events.

## 4.14 Skill observations & recommendations (PRD F-09/F-10)

**`skill_observations`**
`user_id → users`, `skill_key` (text — `chord.diminished`, `interval.tritone`,
`sight.key.G`, `rhythm.eighth`, `hand.left`), `correct_count`, `total_count`,
`last_observed_at`. Primary key `(user_id, skill_key)`.

Written by the grading path **at grading time**, not by a later batch job. The reason
is recoverability: `attempts` records the score, not which skill the item trained, so
an exercise graded before attribution ships is permanently unusable for
recommendations. This table therefore starts being written in M10, one milestone
before anything reads it.

`skill_key` is deliberately a free-text dotted path rather than an enum — new content
introduces new skills constantly, and a migration per skill would make attribution the
slowest part of authoring content. The taxonomy lives in the `analysis` package.

**`skill_definitions`** (content data, not user data)
`skill_key` (PK), `display_name` ("Diminished chords"), `category` (nullable),
`min_observations` (int, default 12), `is_reportable` (bool). `min_observations` is per
skill because the threshold is not universal — a coarse skill needs fewer samples than
a narrow one to be meaningful. Below it, a skill is never shown as a weakness (PRD
F-10): reporting "64%" from three attempts is noise presented as a verdict.

**`practice_recommendations`**
`id`, `user_id → users`, `generated_at`, `skill_keys` (text[] — the two or three
targeted), `session_spec` (jsonb — the generator parameters, so the session is
reproducible and reviewable), `status` (enum: offered / accepted / completed /
dismissed), `resolved_at`. Keeping dismissals rather than deleting them is what lets
the recommender stop re-offering something the user has repeatedly declined.

**`attempt_analysis`** (derived, rebuildable)
`attempt_id → attempts` (PK), `timing_mean_ms` (signed — negative is rushing, positive
is dragging), `timing_stddev_ms`, `notes_early`, `notes_late`, `notes_missed`,
`hand` (nullable). The mean and the deviation are stored separately on purpose: they
diagnose different problems (a consistent rush versus scattered timing) that a single
rhythm percentage collapses together (PRD F-09).

