-- Keyvoria — M7 (billing) and M7a (competition) tables.
-- Matches docs/04-database-schema.md §4.10b and §4.11a.

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                 text NOT NULL CHECK (provider IN ('stripe','apple_app_store','google_play')),
  provider_subscription_id text NOT NULL,
  purchase_platform        text NOT NULL CHECK (purchase_platform IN ('web','ios','android')),
  status                   text NOT NULL CHECK (status IN
                             ('active','cancel_pending','grace_period','billing_retry','expired')),
  price_cents              integer NOT NULL CHECK (price_cents > 0),
  currency                 text NOT NULL DEFAULT 'usd',
  current_period_start     timestamptz NOT NULL,
  current_period_end       timestamptz NOT NULL,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  cancelled_at             timestamptz,
  grace_ends_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);

-- The sweep (webhooks.js) reads exactly this predicate; without the index it
-- degrades into a full scan once the table is large.
CREATE INDEX IF NOT EXISTS subscriptions_sweep_idx
  ON subscriptions (current_period_end, grace_ends_at)
  WHERE status <> 'expired';

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);

-- Webhook idempotency. Providers retry, and a replayed "renewed" would hand out
-- a free month. The primary key IS the guard.
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id     text PRIMARY KEY,
  provider     text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- competition

CREATE TABLE IF NOT EXISTS competition_matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Three games share this table: 'reading' (race the passage, first to finish
  -- wins), 'chords' (name the quality, last standing wins) and 'keys' (name the
  -- key signature, last standing then sudden death). They have different ladder
  -- lengths, hence the per-game level check below.
  game            text NOT NULL DEFAULT 'reading' CHECK (game IN ('reading','chords','keys')),
  level           smallint NOT NULL CHECK (level BETWEEN 1 AND 5),
  -- 8 is the hard cap (roadmap M7a). Enforced in the database as well as the
  -- service, so no future code path can quietly seat a ninth player.
  player_count    smallint NOT NULL CHECK (player_count BETWEEN 2 AND 8),
  lobby_kind      text NOT NULL CHECK (lobby_kind IN ('matched','private')),
  join_code       text,
  -- Reading-race only: a chord round has neither a key signature nor a clef.
  key_signature   text,
  clef            text CHECK (clef IN ('treble','bass')),
  seed            bigint NOT NULL,
  passage         jsonb NOT NULL,
  started_at      timestamptz,
  ends_at         timestamptz,
  ended_at        timestamptz,
  winner_user_id  uuid REFERENCES users(id),
  end_reason      text CHECK (end_reason IN
                    ('completed','all_eliminated','timeout','last_standing','sudden_death','draw')),
  -- How many tiebreak rounds ran (Key Signature Race only). 0 for a match that
  -- never needed one; capped in code so this cannot grow without bound.
  sudden_death_rounds smallint NOT NULL DEFAULT 0 CHECK (sudden_death_rounds BETWEEN 0 AND 3),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT private_lobbies_have_a_code
    CHECK ((lobby_kind = 'private') = (join_code IS NOT NULL)),
  -- The chord ladder is three levels, not five. Without this a level 5 chord
  -- match would be storable and then ungeneratable.
  CONSTRAINT level_is_on_this_game_s_ladder
    CHECK (level <= CASE game WHEN 'chords' THEN 3 WHEN 'keys' THEN 3 ELSE 5 END),
  -- Only the reading race is read off a staff.
  CONSTRAINT reading_rounds_have_a_staff
    CHECK ((game = 'reading') = (clef IS NOT NULL AND key_signature IS NOT NULL)),
  -- Only the Key Signature Race has a tiebreak, so only it may record rounds of
  -- one. A 'draw' is likewise reachable from nowhere else.
  CONSTRAINT only_the_key_race_has_a_tiebreak
    CHECK (game = 'keys' OR (sudden_death_rounds = 0 AND end_reason IS DISTINCT FROM 'draw'
                             AND end_reason IS DISTINCT FROM 'sudden_death'))
);

CREATE UNIQUE INDEX IF NOT EXISTS competition_open_join_code_idx
  ON competition_matches (join_code) WHERE ended_at IS NULL AND join_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS competition_entrants (
  match_id            uuid NOT NULL REFERENCES competition_matches(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Notes in the reading race, chords named in Chord Race: one counter, since
  -- the engine treats both as "answers correct so far".
  notes_correct       smallint NOT NULL DEFAULT 0,
  eliminated_at_note  smallint,
  finished_at         timestamptz,
  -- Measured on the player's own device from passage render to completion, and
  -- validated server-side. Ranking uses THIS, not server arrival time: with
  -- players spread geographically, arrival order ranks pings, not musicians.
  client_elapsed_ms   integer CHECK (client_elapsed_ms IS NULL OR client_elapsed_ms > 0),
  -- Sudden death is scored separately because it is a count race, not an
  -- elimination: a wrong answer there costs the question and nothing else.
  sd_answered         smallint NOT NULL DEFAULT 0,
  sd_correct          smallint NOT NULL DEFAULT 0 CHECK (sd_correct <= sd_answered),
  sd_elapsed_ms       integer CHECK (sd_elapsed_ms IS NULL OR sd_elapsed_ms > 0),
  placement           smallint,
  PRIMARY KEY (match_id, user_id)
);

-- Competition writes NO xp_events rows (PRD F-13): a result depends on who else
-- was in the match, and XP is only ever earned for a user's own correct work.
