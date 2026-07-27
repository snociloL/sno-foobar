# foobar2000 setup

My foobar2000 UI + theme configuration — a portable install running **Columns UI** + **Spider Monkey Panel** with marc2003's **js-smooth** theme, a custom redesigned player bar, an OpenLyrics tab, and Discord Rich Presence.

This repo holds only the **scripts and configs** — not the music library, and not the volatile foobar databases/caches.

## What's here

| Path | What it is |
|------|-----------|
| `smp_scripts/player_bar.js` | Custom-redesigned player bar (see below) |
| `smp_icons/` | PNG icons (legacy; the current bar uses Segoe MDL2 glyphs) |
| `js-smooth/{jssp,jssb,JScommon}.js` | The **edited** js-smooth theme scripts (playlist, album browser, shared helpers) |
| `configuration/*.cfg` | foobar component configs — Columns UI layout, Discord, SMP, OpenLyrics |

## Components to install first

Install these via **Preferences → Components**, then restore the files below:

- **Columns UI** (`foo_ui_columns`)
- **Spider Monkey Panel** (`foo_spider_monkey_panel`) — ships the js-smooth theme under its `samples/js-smooth/` folder
- **OpenLyrics** (`foo_openlyrics`)
- **Discord Rich Presence** (`foo_discord_rich`)

## Restore map

Let `PROFILE` = the foobar2000 profile folder (portable install: next to `foobar2000.exe`).

- `smp_scripts/player_bar.js` → `PROFILE\smp_scripts\`
- `smp_icons\*` → `PROFILE\smp_icons\`
- `js-smooth\*.js` → `PROFILE\user-components\foo_spider_monkey_panel\samples\js-smooth\js\` *(overwrite the stock files after the component is installed)*
- `configuration\*.cfg` → `PROFILE\configuration\`

Then restart foobar2000.

## Key customizations recorded here

**Player bar** (`player_bar.js`, full rewrite): transport icons from Windows' built-in Segoe MDL2 Assets font (scale crisp at any size); **accent color + soft blurred backdrop derived per-track from the album cover**; play/pause in an accent circle; full-width bottom line = seekbar (click/drag); fully responsive (art capped, content vertically centered, narrow drops extras).

**js-smooth theme scripts:**
- `jssp.js` (playlist): group-header date → year only + smaller font; genre no longer overlaps the cover; scroll tuned to a steady 60 fps; rating stars hidden (panel property).
- `jssb.js` (album browser): scroll tuned to 60 fps.
- `JScommon.js` (shared): fast interpolation while scrolling / crisp at rest; disk-cache cover cap raised **200 → 500 px** for sharp grid thumbnails (clear `PROFILE\smp_smooth_cache\` after changing).

**OpenLyrics** (in `foo_openlyrics.dll.cfg`): blurred album-art background, muted-grey text with a red highlighted current line, Segoe UI ~15 pt.

**Layout** (in `foo_ui_columns.dll.cfg`): a Columns UI Tab stack on the right with **Album Grid** (JS Smooth Browser) and **Lyrics** (OpenLyrics) tabs.

## Not included

- The music library (kept elsewhere; huge + not mine to distribute)
- foobar databases/caches: `metadb.sqlite`, `config.sqlite`, playlists, `smp_smooth_cache`, logs, the Discord artwork-uploader binary

> Note: the `.cfg` files are foobar's own binary format — they restore the exact setup but aren't human-diffable.
