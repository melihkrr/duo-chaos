-- ============================================================================
-- DUO CHAOS — 0001 schema
-- Core tables for rooms, players, coins, chaos events and progression.
-- All game state is authoritative on the server; clients only read snapshots.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type duo_phase as enum ('lobby', 'countdown', 'battle', 'results', 'matchover');
exception when duplicate_object then null; end $$;

do $$ begin
  create type duo_coin_type as enum ('gold', 'blue', 'red', 'emerald', 'diamond');
exception when duplicate_object then null; end $$;

do $$ begin
  create type duo_objective_kind as enum ('collect', 'steal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type duo_chaos_event as enum ('gold-rush', 'blackout', 'magnet', 'swap', 'jackpot');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- rooms — one row per match room
-- ---------------------------------------------------------------------------
create table if not exists duo_rooms (
  code            text primary key,
  phase           duo_phase   not null default 'lobby',
  round           int         not null default 1,
  -- deadlines are stored as absolute epoch milliseconds
  countdown_ends_at bigint    not null default 0,
  ends_at         bigint      not null default 0,
  -- chaos event currently active (null when none)
  chaos_event     duo_chaos_event,
  chaos_ends_at   bigint      not null default 0,
  -- server-decided winner player id ('p1' | 'p2' | null)
  winner          text,
  -- per-round and cumulative scores keyed by player id
  round_scores    jsonb       not null default '{}'::jsonb,
  match_scores    jsonb       not null default '{}'::jsonb,
  -- deterministic seed used to generate objectives / spawns for the round
  round_seed      text        not null default '',
  -- last time the room was touched (used for expiry / cleanup)
  updated_at      timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- players — exactly two slots per room, identified by an opaque token
-- ---------------------------------------------------------------------------
create table if not exists duo_players (
  room_code       text        not null references duo_rooms(code) on delete cascade,
  slot            int         not null check (slot in (1, 2)),
  player_id       text        not null,               -- 'p1' | 'p2'
  token           text        not null,               -- opaque session token
  name            text        not null default '',
  x               numeric     not null default 50,
  y               numeric     not null default 50,
  coins           int         not null default 0,
  stolen          int         not null default 0,
  collected_types jsonb       not null default '{}'::jsonb,
  score           int         not null default 0,
  round_score     int         not null default 0,
  total_score     int         not null default 0,
  -- objective assigned for the current round
  objective       jsonb,
  mission_done    boolean     not null default false,
  rematch         boolean     not null default false,
  -- Guess/Read mechanic state
  scout_charges   int         not null default 2,
  scout_used_at   bigint      not null default 0,
  -- revealed hint about the opponent's objective (null until scouted)
  revealed_hint   jsonb,
  -- cosmetics chosen by the player for this match
  emote           text        not null default '',
  trail           text        not null default '',
  -- bump / slow debuff deadline
  slowed_until    bigint      not null default 0,
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  primary key (room_code, slot),
  unique (room_code, player_id),
  unique (room_code, token)
);

create index if not exists duo_players_token_idx on duo_players (token);

-- ---------------------------------------------------------------------------
-- coins — shared, limited resources inside a room
-- ---------------------------------------------------------------------------
create table if not exists duo_coins (
  room_code    text          not null references duo_rooms(code) on delete cascade,
  coin_id      int           not null,
  x            numeric       not null,
  y            numeric       not null,
  type         duo_coin_type not null,
  collected_by text,
  collected_at bigint        not null default 0,
  primary key (room_code, coin_id)
);

-- ---------------------------------------------------------------------------
-- events — audit log of chaos events per round (server-authoritative)
-- ---------------------------------------------------------------------------
create table if not exists duo_events (
  id          bigserial primary key,
  room_code   text           not null references duo_rooms(code) on delete cascade,
  round       int            not null,
  event       duo_chaos_event not null,
  started_at  bigint         not null,
  ends_at     bigint         not null,
  created_at  timestamptz    not null default now()
);

create index if not exists duo_events_room_idx on duo_events (room_code, round);

-- ---------------------------------------------------------------------------
-- progression — long-term XP / level / cosmetics, keyed by a stable client id
-- ---------------------------------------------------------------------------
create table if not exists duo_progression (
  client_id   text primary key,
  xp          int         not null default 0,
  level       int         not null default 1,
  title       text        not null default 'Rookie',
  unlocks     jsonb       not null default '[]'::jsonb,
  emote       text        not null default '',
  trail       text        not null default '',
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security — the client only ever talks through RPCs, so we deny
-- direct table access entirely and let SECURITY DEFINER functions do the work.
-- ---------------------------------------------------------------------------
alter table duo_rooms       enable row level security;
alter table duo_players     enable row level security;
alter table duo_coins       enable row level security;
alter table duo_events      enable row level security;
alter table duo_progression enable row level security;

-- No policies are created on purpose: anon/authenticated get no direct access.
