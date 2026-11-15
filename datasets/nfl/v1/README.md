# NFL play-by-play subset v1

Fixed nflverse data for the Oneshotbench NFL What If prompt: all 147,928 source rows from 855 games in the 2023–2025 regular seasons and playoffs, covering all 32 teams. This is a **column subset**, not a sample of plays. Each season retains 41 play fields and nine game fields. No records are invented or imputed.

Public manifest: https://emh.io/oneshotbench/datasets/nfl/v1/manifest.json

The three season files are `2023.json`, `2024.json`, and `2025.json`, relative to the manifest. Each is approximately 12.4 MB before HTTP compression (approximately 2.3 MB with gzip). Load each file once, show progress, and reuse the parsed data. Keep these large files out of localStorage.

## Format

Each file has `{ schemaVersion: 1, season, columns, games, rows }`. `columns` is an ordered array of field names. Each item in `rows` is an array with values in that same order. The `games` array contains objects with `game_id`, `season`, `season_type`, `week`, `game_date`, `home_team`, `away_team`, `home_score`, and `away_score`. Join plays to games by `game_id`.

```js
const base = 'https://emh.io/oneshotbench/datasets/nfl/v1/';
const response = await fetch(base + '2025.json', { credentials: 'omit' });
if (!response.ok) throw new Error(`Data request failed: ${response.status}`);
const data = await response.json();
const col = Object.fromEntries(data.columns.map((name, index) => [name, index]));
const games = new Map(data.games.map(game => [game.game_id, game]));
const row = data.rows.find(row => row[col.play_type] === 'run');
const game = games.get(row[col.game_id]);
console.log(game.game_date, row[col.posteam], row[col.yards_gained]);
```

Numbers remain numbers; empty/NA source cells become `null`. Source row order is retained. Use the pair `(game_id, play_id)` to identify a play. Do not convert missing numbers to zero. Administrative rows, penalties, no-plays, kneels, spikes, kicks, and overtime remain present; filter deliberately for each analysis.

Useful fields include:

| Fields | Meaning |
| --- | --- |
| `posteam`, `defteam` | Possession team and opposing defense; either can be null on administrative rows. |
| `qtr`, `down`, `ydstogo`, `yardline_100` | Quarter, down, yards to first down, and distance to the opponent's end zone. |
| `game_seconds_remaining`, `quarter_seconds_remaining` | Remaining game and quarter clocks from the source. Handle overtime separately; do not assume a fifth quarter has a positive regulation-game clock. |
| `posteam_score`, `defteam_score`, `score_differential` | Pre-play scores and differential from the possession team's perspective. |
| `posteam_score_post`, `defteam_score_post` | Post-play scores for those teams. |
| `posteam_timeouts_remaining`, `defteam_timeouts_remaining` | Timeouts available in the source state. |
| `play_type`, `yards_gained`, `first_down` | Observed play classification and outcomes. |
| `touchdown`, `td_team`, `interception`, `fumble_lost`, `safety` | Scoring and turnover outcomes. |
| `field_goal_result`, `extra_point_result`, `two_point_conv_result` | Kick and conversion outcomes. |
| `epa`, `success` | nflverse expected-points-added and success fields. `success` denotes positive EPA; these are historical outcomes, not causal estimates of an alternative decision. |
| `penalty`, `penalty_yards`, `play_deleted`, `qb_kneel`, `qb_spike` | Flags needed to choose a suitable empirical cohort. |
| `desc` | Original play description. |

The [nflverse field dictionary](https://nflreadr.nflverse.com/articles/dictionary_pbp.html) is authoritative for all retained fields. The manifest lists the complete column order.

## Analysis scope

Use earlier games to estimate an alternative decision in a selected game. The 2025 season has two complete preceding seasons in this snapshot. Do not use the selected game's later plays or final score as training observations or as simulated outcomes. Final scores in `games` support historical display and checking only. Account for small opponent-specific cohorts and disclose fallbacks. The dataset supplies observations, not a precomputed simulation or predictive accuracy guarantee.

## Attribution and reproducibility

Data: [nflverse contributors](https://github.com/nflverse/nflverse-data), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See [LICENSE.txt](LICENSE.txt). Oneshotbench selected columns, factored game metadata into `games`, converted numeric cells to JSON numbers and missing cells to null, and serialized rows as arrays. No endorsement by nflverse is implied.

`manifest.json` records official download URLs, SHA-256 hashes of the original compressed CSVs, output hashes, byte counts, row counts, and coverage. Rebuild using the pinned source files:

```sh
node scripts/prepare-nfl-data.mjs /path/to/nflverse-downloads
```

The builder uses Node's built-in modules and refuses changed source or output hashes for an existing version. Keep `v1` immutable; revised data belongs at a new versioned path. Both gallery preparation and static export copy this directory. The local app serves it under `/datasets/nfl/v1/` and `/gallery/datasets/nfl/v1/` with public CORS headers.
