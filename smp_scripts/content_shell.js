'use strict';

// Content Shell - a single SMP panel that owns the whole content area and draws its
// own tab bar (Browse / Now Playing / Lyrics), switching between three self-hosted
// views. Replaces the Columns UI tab stack (which can't be restyled or driven by SMP).
//   - Browse      - clean album grid over the library, double-click plays an album.
//   - Now Playing - big cover over a blurred backdrop of itself.
//   - Lyrics      - synced .lrc reader (reads OpenLyrics' saved files), current line lit.
// The player bar sends window.NotifyOthers('shell_nav', <tabIndex>) to jump here;
// this panel echoes 'shell_tab' so the bar can light its lyrics button.
window.DefineScript('Content Shell', { author: 'redesign', options: { grab_focus: false } });

// ---------- colour + math helpers ----------
function RGB(r, g, b)     { return (0xff000000 | (r << 16) | (g << 8) | b) >>> 0; }
function RGBA(r, g, b, a) { return (((a & 0xff) << 24) | (r << 16) | (g << 8) | b) >>> 0; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function lum(r, g, b)     { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// ---------- GdiDrawText flags ----------
var DT_LEFT = 0, DT_CENTER = 1, DT_RIGHT = 2, DT_TOP = 0, DT_VCENTER = 4, DT_BOTTOM = 8,
    DT_WORDBREAK = 0x10, DT_SINGLELINE = 0x20, DT_NOPREFIX = 0x800, DT_END_ELLIPSIS = 0x8000;
var TXT   = DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;
var CTR   = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;

// ---------- palette (matches the player bar) ----------
var C_BG     = RGB(20, 20, 22);
var C_TABBAR = RGB(26, 26, 29);
var C_TITLE  = RGB(238, 238, 242);
var C_SUB    = RGB(150, 150, 156);
var C_DIM    = RGB(96, 96, 104);
var C_CELL   = RGB(34, 34, 38);
var C_LINE   = RGBA(255, 255, 255, 18);
var ACCENT   = RGB(224, 69, 74);
var ACCENT_FG= RGB(255, 255, 255);

// ---------- tabs ----------
var TABS = [{ id: 'browse', label: 'Browse' },
            { id: 'now',    label: 'Now Playing' },
            { id: 'lyrics', label: 'Lyrics' }];
var activeTab = clamp(window.GetProperty('shell.activeTab', 0), 0, 2);
var tabRects = [];              // hit rects, filled during paint
var tabHover = -1;

// ---------- Browse "play all" actions (right side of the tab bar) ----------
var ICON_FONT = 'Segoe MDL2 Assets';
var G_PLAY = '\uE768', G_SHUF = '\uE8B1';
var actionRects = [], actionHover = '';

// ---------- geometry ----------
var W = 0, H = 0, TABBAR_H = 46;
var grid = { x: 0, y: 0, w: 0, h: 0, cols: 1, cellW: 0, coverH: 0, labelH: 46, gap: 20, rowH: 0, top: 18, max: 0, selHover: -1 };

// ---------- fonts ----------
var fTab, fGridLabel, fGridSub, fNpTitle, fNpArtist, fNpAlbum, fLyric, fLyricCur, fMsg, fPlaceholder, fRow, fRowHi, fAction, fActionIcon, fHdr, fHdrSub, fAlbumTitle;

// ---------- now-playing artwork ----------
var npFull = null, npArt = null, npBg = null, npBgVer = 0, npMaskImg = null, npMaskKey = '';

// ---------- now-playing track list ----------
var npList = null, npPlaylist = -1, npPlayingItem = -1;
var npListScroll = 0, npListScrollTo = 0, npRowH = 30, npListMax = 0;
var npListGeo = { x: 0, y: 0, w: 0, h: 0 };
var npListHover = -1, npCenterPending = false;
var npRows = [];                // display rows: {type:'header',album,artist} | {type:'track',i,y,h}
var npRight = window.GetProperty('shell.npRight', 'queue');   // 'queue' | 'lyrics' - right pane of Now Playing
var npTogQ = null, npTogL = null, npTogHover = '';

// ---------- Browse album detail (drill-down) ----------
var browseView = 'grid';        // 'grid' | 'album'
var albumSel = null;            // the album object being viewed
var albumScroll = 0, albumScrollTo = 0, albumRowH = 30, albumMax = 0;
var albumHover = -1, albumBtnHover = '';
var albumGeo = { x: 0, y: 0, w: 0, h: 0 };
var albumBackRect = null, albumPlayRect = null, albumShufRect = null;

// ---------- title formats ----------
var TF = {
    npTitle : fb.TitleFormat('%title%'),
    npArtist: fb.TitleFormat('[%artist%]'),
    npAlbum : fb.TitleFormat('[%album%]'),
    artist  : fb.TitleFormat('[%artist%]'),
    albumArt: fb.TitleFormat('[%album artist%]'),
    row     : fb.TitleFormat('[%tracknumber%. ]%title%'),
    rowLen  : fb.TitleFormat('%length%'),
    rowKey  : fb.TitleFormat('[%album artist%]^^[%album%]'),
    year    : fb.TitleFormat('$year(%date%)'),
    genre   : fb.TitleFormat('[%genre%]'),
    path    : fb.TitleFormat('%path%^^[%tracknumber%]'),
    filepath: fb.TitleFormat('%path%'),
    lyricsTag: fb.TitleFormat('[%syncedlyrics%][%lyrics%][%unsynced lyrics%][%unsyncedlyrics%]')
};

// ---------- library / albums ----------
var lib = null;                 // sorted MetadbHandleList
var albums = [];                // [{ artist, album, start, count, art, tried }]

// ---------- lyrics ----------
var LYRICS_DIR = fb.ProfilePath + 'lyrics\\';
var lyricsMap = null;           // normalized "artist - title" -> full path
var lyrics = [];                // [{ t, text }] synced, or plain lines with t = -1
var lyricSynced = false;
var lyricIndex = -1;
var lyricScroll = 0, lyricScrollTo = 0, lyricLineH = 30;
var lyricMsg = '';
// per-song sync offset (seconds): +ve = lyrics earlier, -ve = later. Persisted per track.
var lyricOffset = 0, lyricOffMap = null;
var OFFSET_FILE = fb.ProfilePath + 'smp_scripts\\lyric_offsets.json';
var lyricOffMinusRect = null, lyricOffPlusRect = null, lyricOffHover = '';

// ---------- animation ----------
var anim = null;
var gridScroll = 0, gridScrollTo = 0;
var scrolling = false;          // true while a scroll is easing -> use fast interpolation

function startAnim() { if (!anim) anim = window.SetInterval(tick, 16); }
function stopAnim()  { if (anim) { window.ClearInterval(anim); anim = null; } }
function lyricsActive() { return activeTab === 2 || (activeTab === 1 && npRight === 'lyrics'); }
function setNpRight(m) { if (npRight === m) return; npRight = m; window.SetProperty('shell.npRight', m); startAnim(); window.Repaint(); }

// =====================================================================
//  ACCENT
// =====================================================================
function computeAccent(src) {
    ACCENT = RGB(224, 69, 74); ACCENT_FG = RGB(255, 255, 255);
    if (!src) return;
    try {
        var small = src.Resize(72, 72, 2);
        var arr = JSON.parse(small.GetColourSchemeJSON(14));
        var best = null, bestScore = -1;
        for (var i = 0; i < arr.length; i++) {
            var c = arr[i].col, r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
            var mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = lum(r, g, b);
            var sat = mx === 0 ? 0 : (mx - mn) / mx;
            if (L < 42 || L > 214 || sat < 0.2) continue;
            var score = sat + (arr[i].freq || 0) * 0.4;
            if (score > bestScore) { bestScore = score; best = { r: r, g: g, b: b, L: L }; }
        }
        if (best) {
            var f = best.L < 74 ? (100 / Math.max(best.L, 1)) * 0.85 : 1;
            var r = clamp(Math.round(best.r * f), 0, 255),
                g = clamp(Math.round(best.g * f), 0, 255),
                b = clamp(Math.round(best.b * f), 0, 255);
            ACCENT = RGB(r, g, b);
            ACCENT_FG = lum(r, g, b) > 150 ? RGB(22, 22, 24) : RGB(255, 255, 255);
        }
    } catch (e) {}
}

// =====================================================================
//  NOW-PLAYING ARTWORK
// =====================================================================
function loadNpArt(metadb) {
    npFull = null; npArt = null; npBg = null; npBgVer++;
    if (!metadb) { computeAccent(null); return; }
    try {
        var full = utils.GetAlbumArtV2(metadb, 0);
        computeAccent(full);
        if (full) {
            npFull = full;
            npArt = full.Width > 1000
                ? full.Resize(1000, Math.max(1, Math.round(full.Height * 1000 / full.Width)), 2)
                : full;
            try { var b = full.Resize(80, 80, 2); var r = b.StackBlur(40); npBg = (r || b).RotateFlip(6) || (r || b); }
            catch (e) { npBg = full.Resize(8, 8, 2); }
        }
    } catch (e) {}
}

function buildNpList() {
    npList = null; npPlaylist = -1; npPlayingItem = -1; npRows = [];
    try {
        var loc = plman.GetPlayingItemLocation();
        var pl = (loc && loc.IsValid) ? loc.PlaylistIndex : plman.ActivePlaylist;
        if (pl < 0) return;
        npPlaylist = pl;
        npList = plman.GetPlaylistItems(pl);
        npPlayingItem = (loc && loc.IsValid) ? loc.PlaylistItemIndex : -1;
        var prev = null;
        for (var i = 0; i < npList.Count; i++) {
            var hi = npList[i];
            var key = TF.rowKey.EvalWithMetadb(hi);
            if (key !== prev) {
                var parts = key.split('^^');
                npRows.push({ type: 'header', album: parts[1] || 'Unknown album', artist: parts[0] || '',
                              year: TF.year.EvalWithMetadb(hi), genre: TF.genre.EvalWithMetadb(hi),
                              firstIdx: i, art: null, tried: false });
                prev = key;
            }
            npRows.push({ type: 'track', i: i, y: 0, h: 0 });
        }
        npCenterPending = true;
    } catch (e) { npList = null; npRows = []; }
}

function loadHeaderArt(e) {
    e.tried = true;
    try {
        var img = utils.GetAlbumArtV2(npList[e.firstIdx], 0);
        if (img) e.art = img.Width > 160 ? img.Resize(160, Math.max(1, Math.round(img.Height * 160 / img.Width)), 2) : img;
    } catch (ex) {}
}

// On a track change, only rebuild the whole list if the playlist actually changed;
// otherwise just move the highlight (keeps the header art cache warm).
function refreshNp() {
    try {
        var loc = plman.GetPlayingItemLocation();
        var pl = (loc && loc.IsValid) ? loc.PlaylistIndex : plman.ActivePlaylist;
        if (!npList || pl !== npPlaylist || npList.Count !== plman.PlaylistItemCount(pl)) {
            buildNpList();
        } else {
            npPlayingItem = (loc && loc.IsValid) ? loc.PlaylistItemIndex : -1;
            npCenterPending = true;
        }
    } catch (e) { buildNpList(); }
}

// =====================================================================
//  LIBRARY / ALBUMS
// =====================================================================
function buildAlbums() {
    albums = []; lib = null;
    try {
        lib = fb.GetLibraryItems();
        if (!lib || !lib.Count) return;
        lib.OrderByFormat(fb.TitleFormat('%album artist%^^%date%^^%album%^^%discnumber%^^%tracknumber%'), 1);
        var keyTf = fb.TitleFormat('%album artist%^^%album%');
        var prevKey = null, cur = null;
        for (var i = 0; i < lib.Count; i++) {
            var h = lib[i];
            var key = keyTf.EvalWithMetadb(h);
            if (key !== prevKey) {
                var parts = key.split('^^');
                cur = { artist: parts[0] || '?', album: parts[1] || '?', start: i, count: 0, art: null, tried: false };
                albums.push(cur); prevKey = key;
            }
            cur.count++;
        }
    } catch (e) { albums = []; }
}

function loadAlbumArt(a) {
    a.tried = true;
    try {
        if (!lib) return;
        var img = utils.GetAlbumArtV2(lib[a.start], 0);
        if (img) a.art = img.Width > 400 ? img.Resize(400, Math.max(1, Math.round(img.Height * 400 / img.Width)), 2) : img;
    } catch (e) {}
}

// Pre-render a cover cropped to a square and scaled to the exact cell size, once,
// so the grid can blit it 1:1 every frame (no per-frame rescale) while scrolling.
function buildCell(a) {
    try {
        if (!a.art || grid.cellW <= 0) return;
        var iw = a.art.Width, ih = a.art.Height, s = Math.min(iw, ih), cw = grid.cellW;
        var img = gdi.CreateImage(cw, cw), g = img.GetGraphics();
        g.SetInterpolationMode(7);
        g.DrawImage(a.art, 0, 0, cw, cw, Math.round((iw - s) / 2), 0, s, s, 0, 255);
        img.ReleaseGraphics(g);
        a.artCell = img; a.artCellW = cw;
    } catch (e) { a.artCell = null; }
}

function playAll(shuffle) {
    try {
        if (!lib || !lib.Count) return;
        var all = lib.Clone();                 // lib is already sorted by album artist / date / album
        var pl = plman.FindOrCreatePlaylist('Album View', true);
        plman.ActivePlaylist = pl;
        plman.ClearPlaylist(pl);
        plman.InsertPlaylistItems(pl, 0, all);
        if (shuffle) {
            plman.PlaybackOrder = 4;           // shuffle (tracks)
            plman.ExecutePlaylistDefaultAction(pl, Math.floor(Math.random() * all.Count));
        } else {
            plman.ExecutePlaylistDefaultAction(pl, 0);
        }
    } catch (e) {}
}

function playAlbum(a, startIdx, shuffle) {
    try {
        if (!lib || !a) return;
        var sub = lib.Clone();
        var tail = a.start + a.count;
        if (lib.Count - tail > 0) sub.RemoveRange(tail, lib.Count - tail);
        if (a.start > 0) sub.RemoveRange(0, a.start);
        var pl = plman.FindOrCreatePlaylist('Album View', true);
        plman.ActivePlaylist = pl;
        plman.ClearPlaylist(pl);
        plman.InsertPlaylistItems(pl, 0, sub);
        if (shuffle) { plman.PlaybackOrder = 4; plman.ExecutePlaylistDefaultAction(pl, Math.floor(Math.random() * sub.Count)); }
        else plman.ExecutePlaylistDefaultAction(pl, startIdx || 0);
    } catch (e) {}
}

// =====================================================================
//  LYRICS
// =====================================================================
function normKey(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function buildLyricsIndex() {
    lyricsMap = {};
    try {
        var files = utils.Glob(LYRICS_DIR + '*.lrc').concat(utils.Glob(LYRICS_DIR + '*.txt'));
        for (var i = 0; i < files.length; i++) {
            var p = files[i];
            var base = p.replace(/^.*[\\\/]/, '').replace(/\.(lrc|txt)$/i, '');
            var k = normKey(base);
            if (!(k in lyricsMap) || /\.lrc$/i.test(p)) lyricsMap[k] = p;  // prefer .lrc
        }
    } catch (e) { lyricsMap = {}; }
}

function tryRead(path) { try { var t = utils.ReadTextFile(path, 65001); return t || ''; } catch (e) { return ''; } }

function findInLyricsFolder(metadb) {
    var title = TF.npTitle.EvalWithMetadb(metadb);
    var artist = TF.artist.EvalWithMetadb(metadb);
    var aartist = TF.albumArt.EvalWithMetadb(metadb);
    var cands = [artist + ' - ' + title, aartist + ' - ' + title, title];
    for (var i = 0; i < cands.length; i++) {
        var k = normKey(cands[i]);
        if (k && lyricsMap && lyricsMap[k]) return lyricsMap[k];
    }
    return null;
}

// Returns lyric text from the best available source, or '' if none yet.
function readLyricSource(metadb) {
    if (!metadb) return '';
    try {                                    // 1) .lrc / .txt next to the audio file
        var ap = TF.filepath.EvalWithMetadb(metadb);
        if (ap) {
            var base = ap.replace(/\.[^.\\\/]+$/, '');
            var t = tryRead(base + '.lrc'); if (t) return t;
            t = tryRead(base + '.txt'); if (t) return t;
        }
    } catch (e) {}
    var p = findInLyricsFolder(metadb);      // 2) OpenLyrics' save folder (profile\lyrics)
    if (p) { var t2 = tryRead(p); if (t2) return t2; }
    try {                                    // 3) lyrics stored in the track's tags
        var tg = TF.lyricsTag.EvalWithMetadb(metadb);
        if (tg && tg.length > 4) return tg;
    } catch (e) {}
    return '';
}

function parseLrc(text) {
    var out = [];
    var lines = text.replace(/\r/g, '').split('\n');
    var re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i], m, stamps = [];
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
            var frac = m[3] ? parseInt((m[3] + '00').substring(0, 3), 10) / 1000 : 0;
            stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
        }
        var body = line.replace(re, '').trim();
        for (var s = 0; s < stamps.length; s++) out.push({ t: stamps[s], text: body });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
}

function applyLyricsText(text) {
    lyrics = []; lyricSynced = false;
    if (!text) return false;
    if (text.charCodeAt(0) === 0xFEFF) text = text.substring(1);    // strip any BOM
    if (/\[\d{1,2}:\d{1,2}/.test(text)) {
        lyrics = parseLrc(text);
        lyricSynced = lyrics.length > 0;
    }
    if (!lyricSynced) {
        var plain = text.replace(/\r/g, '').replace(/\[[^\]]*\]/g, '').split('\n');
        lyrics = [];
        for (var i = 0; i < plain.length; i++) lyrics.push({ t: -1, text: plain[i].trim() });
        while (lyrics.length && !lyrics[0].text) lyrics.shift();
        while (lyrics.length && !lyrics[lyrics.length - 1].text) lyrics.pop();
    }
    return lyrics.length > 0;
}

var lyricRetry = null;
function clearLyricRetry() { if (lyricRetry) { try { window.ClearTimeout(lyricRetry); } catch (e) {} lyricRetry = null; } }
function trackKeyOf(m) { try { return m ? TF.filepath.EvalWithMetadb(m) : ''; } catch (e) { return ''; } }

// OpenLyrics fetches online and saves a .lrc a moment later; keep re-checking briefly so
// the shell catches that save instead of showing "No lyrics" for tracks not yet cached.
function scheduleLyricRetry(metadb, n) {
    clearLyricRetry();
    if (n > 6) { lyricMsg = 'No lyrics found'; if (lyricsActive()) window.Repaint(); return; }
    var key = trackKeyOf(metadb);
    lyricRetry = window.SetTimeout(function () {
        lyricRetry = null;
        var np = fb.GetNowPlaying();
        if (!np || trackKeyOf(np) !== key) return;      // track changed -> stop retrying
        buildLyricsIndex();
        if (applyLyricsText(readLyricSource(np))) {
            lyricMsg = ''; lyricIndex = -1; lyricScroll = 0; lyricScrollTo = 0;
            if (lyricsActive()) startAnim();
            window.Repaint();
        } else scheduleLyricRetry(metadb, n + 1);
    }, 2500);
}

function loadLyrics(metadb) {
    clearLyricRetry();
    lyrics = []; lyricSynced = false; lyricIndex = -1; lyricScroll = 0; lyricScrollTo = 0; lyricMsg = '';
    if (!metadb) { lyricMsg = 'Nothing playing'; return; }
    applyStoredOffset(metadb);                 // per-song sync nudge (remembered)
    buildLyricsIndex();                        // fresh scan every track (catches newly-saved files)
    if (applyLyricsText(readLyricSource(metadb))) return;
    lyricMsg = 'Searching...';                  // OpenLyrics may still be fetching -> retry a few times
    scheduleLyricRetry(metadb, 1);
}

function currentLyric(time) {
    if (!lyricSynced) return -1;
    var tt = time + lyricOffset;
    var idx = -1;
    for (var i = 0; i < lyrics.length; i++) { if (lyrics[i].t <= tt) idx = i; else break; }
    return idx;
}

function loadOffsetMap() {
    if (lyricOffMap) return;
    lyricOffMap = {};
    try { var t = utils.ReadTextFile(OFFSET_FILE, 65001); if (t) lyricOffMap = JSON.parse(t) || {}; } catch (e) { lyricOffMap = {}; }
}
function saveOffsetMap() { try { utils.WriteTextFile(OFFSET_FILE, JSON.stringify(lyricOffMap)); } catch (e) {} }
function offsetKeyFor(metadb) { return trackKeyOf(metadb); }
function applyStoredOffset(metadb) { loadOffsetMap(); lyricOffset = lyricOffMap[offsetKeyFor(metadb)] || 0; }
function adjustOffset(delta) {
    lyricOffset = Math.round((lyricOffset + delta) * 100) / 100;
    if (lyricOffset < -30) lyricOffset = -30; else if (lyricOffset > 30) lyricOffset = 30;
    var np = fb.GetNowPlaying();
    if (np) { loadOffsetMap(); var k = offsetKeyFor(np); if (lyricOffset === 0) delete lyricOffMap[k]; else lyricOffMap[k] = lyricOffset; saveOffsetMap(); }
    lyricIndex = -1;                       // force resync on next tick
    if (lyricsActive()) startAnim();
    window.Repaint();
}

// =====================================================================
//  FONTS + LAYOUT
// =====================================================================
function buildFonts() {
    fTab        = gdi.Font('Segoe UI Semibold', clamp(Math.round(TABBAR_H * 0.36), 13, 19), 0);
    fAction     = gdi.Font('Segoe UI Semibold', clamp(Math.round(TABBAR_H * 0.28), 11, 15), 0);
    fActionIcon = gdi.Font(ICON_FONT, clamp(Math.round(TABBAR_H * 0.26), 10, 15), 0);
    fGridLabel  = gdi.Font('Segoe UI Semibold', 14, 0);
    fGridSub    = gdi.Font('Segoe UI', 12, 0);
    fPlaceholder= gdi.Font('Segoe UI Semibold', 30, 0);
    fNpTitle    = gdi.Font('Segoe UI Semibold', clamp(Math.round(H * 0.036), 18, 30), 0);
    fNpArtist   = gdi.Font('Segoe UI', clamp(Math.round(H * 0.026), 13, 21), 0);
    fNpAlbum    = gdi.Font('Segoe UI', clamp(Math.round(H * 0.022), 12, 18), 0);
    fLyric      = gdi.Font('Segoe UI', clamp(Math.round(H * 0.030), 15, 24), 0);
    fLyricCur   = gdi.Font('Segoe UI Semibold', clamp(Math.round(H * 0.036), 18, 30), 0);
    fMsg        = gdi.Font('Segoe UI', 16, 0);
    fRow        = gdi.Font('Segoe UI', clamp(Math.round(H * 0.021), 12, 16), 0);
    fRowHi      = gdi.Font('Segoe UI Semibold', clamp(Math.round(H * 0.021), 12, 16), 0);
    fHdr        = gdi.Font('Segoe UI Semibold', clamp(Math.round(H * 0.026), 15, 22), 0);
    fHdrSub     = gdi.Font('Segoe UI', clamp(Math.round(H * 0.020), 12, 16), 0);
    fAlbumTitle = gdi.Font('Segoe UI Semibold', clamp(Math.round(H * 0.040), 20, 34), 0);
    lyricLineH  = clamp(Math.round(H * 0.060), 30, 52);
    npRowH      = clamp(Math.round(H * 0.050), 26, 40);
}

function layoutGrid() {
    grid.x = 24; grid.y = TABBAR_H; grid.w = W - 48; grid.h = H - TABBAR_H;
    grid.gap = 20; grid.labelH = 48; grid.top = 20;
    var target = 200;
    grid.cols = Math.max(2, Math.floor((grid.w + grid.gap) / (target + grid.gap)));
    grid.cellW = Math.floor((grid.w - (grid.cols - 1) * grid.gap) / grid.cols);
    grid.coverH = grid.cellW;
    grid.rowH = grid.coverH + grid.labelH + grid.gap;
    var rows = Math.ceil(albums.length / grid.cols);
    grid.max = Math.max(0, rows * grid.rowH + grid.top + 8 - grid.h);
    gridScrollTo = clamp(gridScrollTo, 0, grid.max);
    gridScroll = clamp(gridScroll, 0, grid.max);
}

function on_size() {
    W = window.Width; H = window.Height;
    if (W <= 0 || H <= 0) return;
    TABBAR_H = clamp(Math.round(H * 0.075), 42, 54);
    buildFonts();
    layoutGrid();
    startAnim();   // rebuild cover cell-caches at the new cell size
}

// =====================================================================
//  ANIMATION TICK
// =====================================================================
function tick() {
    var repaint = false, keep = false;
    scrolling = false;

    // grid scroll easing
    if (activeTab === 0 && browseView === 'grid') {
        if (Math.abs(gridScrollTo - gridScroll) > 0.5) {
            gridScroll += (gridScrollTo - gridScroll) / 5;
            repaint = true; keep = true; scrolling = true;
        } else if (gridScroll !== gridScrollTo) { gridScroll = gridScrollTo; repaint = true; }
    }

    // album detail tracklist scroll easing
    if (activeTab === 0 && browseView === 'album') {
        if (Math.abs(albumScrollTo - albumScroll) > 0.5) {
            albumScroll += (albumScrollTo - albumScroll) / 5;
            repaint = true; keep = true; scrolling = true;
        } else if (albumScroll !== albumScrollTo) { albumScroll = albumScrollTo; repaint = true; }
    }

    // now-playing list scroll easing
    if (activeTab === 1) {
        if (Math.abs(npListScrollTo - npListScroll) > 0.5) { npListScroll += (npListScrollTo - npListScroll) / 5; repaint = true; keep = true; scrolling = true; }
        else if (npListScroll !== npListScrollTo) { npListScroll = npListScrollTo; repaint = true; }
    }

    // Background preload of ALL images (grid cover cells + now-playing header thumbnails),
    // regardless of the active tab, so tabs are ready to scroll the moment you switch.
    // Paused only during an active fling so it never competes with scrolling.
    if (!scrolling) {
        var budget = 3;
        for (var gi = 0; gi < albums.length && budget > 0; gi++) {
            var ga = albums[gi];
            if (!ga.tried) { loadAlbumArt(ga); if (ga.art) buildCell(ga); budget--; }
            else if (ga.art && ga.artCellW !== grid.cellW) { buildCell(ga); budget--; }
        }
        for (var hi = 0; hi < npRows.length && budget > 0; hi++) {
            if (npRows[hi].type === 'header' && !npRows[hi].tried) { loadHeaderArt(npRows[hi]); budget--; }
        }
        if (budget < 3) repaint = true;
    }
    var pending = false;
    for (var pi = 0; pi < albums.length; pi++) {
        var pa = albums[pi];
        if (!pa.tried || (pa.art && pa.artCellW !== grid.cellW)) { pending = true; break; }
    }
    if (!pending) {
        for (var ph = 0; ph < npRows.length; ph++) {
            if (npRows[ph].type === 'header' && !npRows[ph].tried) { pending = true; break; }
        }
    }
    if (pending) keep = true;

    // lyrics sync + auto-scroll (Lyrics tab OR Now Playing right pane set to Lyrics)
    if (lyricsActive() && lyricSynced) {
        var ni = currentLyric(fb.PlaybackTime);
        if (ni !== lyricIndex) {
            lyricIndex = ni;
            lyricScrollTo = Math.max(0, ni) * lyricLineH;
            repaint = true;
        }
        if (Math.abs(lyricScrollTo - lyricScroll) > 0.5) { lyricScroll += (lyricScrollTo - lyricScroll) / 5; repaint = true; keep = true; }
        else lyricScroll = lyricScrollTo;
        if (fb.IsPlaying && !fb.IsPaused) keep = true;
    } else if (lyricsActive()) {
        if (Math.abs(lyricScrollTo - lyricScroll) > 0.5) { lyricScroll += (lyricScrollTo - lyricScroll) / 5; repaint = true; keep = true; }
        else if (lyricScroll !== lyricScrollTo) { lyricScroll = lyricScrollTo; repaint = true; }
    }

    if (repaint) window.Repaint();
    if (!keep) stopAnim();
}

// =====================================================================
//  PAINT
// =====================================================================
function paintBackdrop(gr) {
    if ((activeTab === 1 || activeTab === 2) && npBg) {
        gr.SetInterpolationMode(7);
        gr.DrawImage(npBg, 0, 0, W, H, 0, 0, npBg.Width, npBg.Height, 0, 255);
        gr.FillSolidRect(0, 0, W, H, RGBA(16, 16, 18, activeTab === 2 ? 205 : 150));
    } else {
        gr.FillSolidRect(0, 0, W, H, C_BG);
    }
}

function drawPill(gr, id, glyph, label, rightX, y, h, primary) {
    var iconSize = Math.round(h * 0.64), iconGap = 5, padX = Math.round(h * 0.52);
    var lw = 0;
    try { lw = Math.ceil(gr.MeasureString(label, fAction, 0, 0, 1000, 100).Width); } catch (e) { lw = label.length * 8; }
    var w = padX * 2 + iconSize + iconGap + lw, x = rightX - w, hov = (actionHover === id);
    gr.SetSmoothingMode(2);
    if (primary) {
        gr.FillRoundRect(x, y, w, h, h / 2, h / 2, ACCENT);
        if (hov) gr.FillRoundRect(x, y, w, h, h / 2, h / 2, RGBA(255, 255, 255, 26));
    } else {
        gr.FillRoundRect(x, y, w, h, h / 2, h / 2, RGBA(255, 255, 255, hov ? 34 : 18));
    }
    gr.SetSmoothingMode(0);
    var fg = primary ? ACCENT_FG : C_TITLE;
    gr.GdiDrawText(glyph, fActionIcon, fg, x + padX, y - 1, iconSize + 3, h, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    gr.GdiDrawText(label, fAction, fg, x + padX + iconSize + iconGap, y, lw + 4, h, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    actionRects.push({ id: id, x: x, y: y, w: w, h: h });
    return x;
}

function paintTabBar(gr) {
    gr.FillSolidRect(0, 0, W, TABBAR_H, C_TABBAR);
    gr.FillSolidRect(0, TABBAR_H - 1, W, 1, C_LINE);
    tabRects = [];
    var padX = 18, gap = 10;
    var widths = [], total = 0;
    for (var i = 0; i < TABS.length; i++) {
        var tw0;
        try { tw0 = Math.ceil(gr.MeasureString(TABS[i].label, fTab, 0, 0, 1000, 100).Width); }
        catch (e) { tw0 = TABS[i].label.length * 9; }
        widths.push(tw0); total += tw0 + padX * 2;
    }
    total += gap * (TABS.length - 1);
    var x = Math.round((W - total) / 2);
    if (x < 20) x = 20;
    for (i = 0; i < TABS.length; i++) {
        var tw = widths[i], w = tw + padX * 2;
        var active = (i === activeTab), hov = (i === tabHover);
        var col = active ? C_TITLE : (hov ? RGB(200, 200, 206) : C_SUB);
        gr.GdiDrawText(TABS[i].label, fTab, col, x, 0, w, TABBAR_H, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        if (active) { var uw = tw + 10; gr.FillSolidRect(x + (w - uw) / 2, TABBAR_H - 3, uw, 3, ACCENT); }
        tabRects.push({ x: x, w: w });
        x += w + gap;
    }
    // Browse-only "play everything" pills on the right
    actionRects = [];
    if (activeTab === 0 && browseView === 'grid' && albums.length && W > 860) {
        var ph = Math.round(TABBAR_H * 0.58), py = Math.round((TABBAR_H - ph) / 2);
        var lx = drawPill(gr, 'play_all', G_PLAY, 'Play all', W - 18, py, ph, true);
        drawPill(gr, 'shuffle_all', G_SHUF, 'Shuffle', lx - 8, py, ph, false);
    }
}

function roundPlaceholder(gr, x, y, w, h, a) {
    gr.SetSmoothingMode(2);
    gr.FillRoundRect(x, y, w, h, 8, 8, C_CELL);
    var ini = (a.album || '?').substring(0, 1).toUpperCase();
    gr.GdiDrawText(ini, fPlaceholder, RGBA(255, 255, 255, 40), x, y, w, h, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    gr.SetSmoothingMode(0);
}

function paintBrowse(gr) {
    if (!albums.length) {
        gr.GdiDrawText('Library is empty', fMsg, C_SUB, 0, TABBAR_H, W, H - TABBAR_H, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        return;
    }
    gr.SetInterpolationMode(scrolling ? 3 : 7);   // Bilinear while scrolling, HQ bicubic at rest
    var top = grid.y + grid.top - gridScroll;
    for (var i = 0; i < albums.length; i++) {
        var r = Math.floor(i / grid.cols), c = i % grid.cols;
        var cx = grid.x + c * (grid.cellW + grid.gap);
        var cy = top + r * grid.rowH;
        if (cy + grid.rowH < grid.y || cy > H) continue;    // cull offscreen
        var a = albums[i];
        if (a.artCell && a.artCellW === grid.cellW) {
            gr.DrawImage(a.artCell, cx, cy, grid.cellW, grid.coverH, 0, 0, a.artCell.Width, a.artCell.Height, 0, 255);
        } else if (a.art) {
            var iw = a.art.Width, ih = a.art.Height, s = Math.min(iw, ih);
            gr.DrawImage(a.art, cx, cy, grid.cellW, grid.coverH, Math.round((iw - s) / 2), 0, s, s, 0, 255);
        } else {
            roundPlaceholder(gr, cx, cy, grid.cellW, grid.coverH, a);
        }
        if (i === grid.selHover) {
            gr.SetSmoothingMode(2);
            gr.DrawRect(cx, cy, grid.cellW - 1, grid.coverH - 1, 2, ACCENT);
            gr.SetSmoothingMode(0);
        }
        gr.GdiDrawText(a.album, fGridLabel, C_TITLE, cx + 2, cy + grid.coverH + 6, grid.cellW - 4, 20, DT_LEFT | DT_TOP | TXT);
        gr.GdiDrawText(a.artist, fGridSub, C_SUB, cx + 2, cy + grid.coverH + 26, grid.cellW - 4, 18, DT_LEFT | DT_TOP | TXT);
    }
    // top fade so covers scroll under the tab bar cleanly
    gr.FillSolidRect(0, TABBAR_H, W, 10, RGBA(20, 20, 22, 160));
}

// ---------- album detail view ----------
function fmtLen(secs) {
    secs = Math.max(0, Math.round(secs));
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    var mm = (h > 0 && m < 10) ? '0' + m : '' + m, ss = s < 10 ? '0' + s : '' + s;
    return (h > 0) ? (h + ':' + mm + ':' + ss) : (m + ':' + ss);
}

function curNowKey() { var np = fb.GetNowPlaying(); return np ? TF.path.EvalWithMetadb(np) : ''; }

function openAlbum(a) {
    albumSel = a; browseView = 'album';
    albumScroll = 0; albumScrollTo = 0; albumHover = -1; albumBtnHover = '';
    try {
        var first = lib[a.start];
        a.dYear = TF.year.EvalWithMetadb(first);
        a.dGenre = TF.genre.EvalWithMetadb(first);
        var secs = 0, lenTf = fb.TitleFormat('%length_seconds%');
        for (var i = 0; i < a.count; i++) secs += (Number(lenTf.EvalWithMetadb(lib[a.start + i])) || 0);
        a.dTotal = fmtLen(secs);
        var img = utils.GetAlbumArtV2(first, 0);
        if (img) {
            a.dcover = img.Width > 900 ? img.Resize(900, Math.max(1, Math.round(img.Height * 900 / img.Width)), 2) : img;
            try { var b = img.Resize(80, 80, 2); var r = b.StackBlur(40); a.dbg = (r || b).RotateFlip(6) || (r || b); } catch (e) { a.dbg = img.Resize(8, 8, 2); }
        } else { a.dcover = a.art || null; a.dbg = null; }
    } catch (e) {}
    startAnim(); window.Repaint();
}

function drawBackButton(gr, hover) {
    var bx = 20, by = TABBAR_H + 12, bw = 88, bh = 30;
    gr.SetSmoothingMode(2);
    gr.FillRoundRect(bx, by, bw, bh, bh / 2, bh / 2, RGBA(255, 255, 255, hover ? 34 : 16));
    var cx = bx + 20, cy = by + bh / 2;
    gr.DrawLine(cx + 3, cy - 6, cx - 3, cy, 2, C_TITLE);
    gr.DrawLine(cx - 3, cy, cx + 3, cy + 6, 2, C_TITLE);
    gr.GdiDrawText('Back', fAction, C_TITLE, bx + 32, by, bw - 36, bh, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    albumBackRect = { x: bx, y: by, w: bw, h: bh };
}

function drawAlbumPill(gr, x, y, h, glyph, label, primary, hover) {
    var iconSize = Math.round(h * 0.6), iconGap = 5, padX = Math.round(h * 0.6), lw = 0;
    try { lw = Math.ceil(gr.MeasureString(label, fAction, 0, 0, 1000, 100).Width); } catch (e) { lw = label.length * 8; }
    var w = padX * 2 + iconSize + iconGap + lw;
    gr.SetSmoothingMode(2);
    if (primary) { gr.FillRoundRect(x, y, w, h, h / 2, h / 2, ACCENT); if (hover) gr.FillRoundRect(x, y, w, h, h / 2, h / 2, RGBA(255, 255, 255, 26)); }
    else gr.FillRoundRect(x, y, w, h, h / 2, h / 2, RGBA(255, 255, 255, hover ? 40 : 22));
    var fg = primary ? ACCENT_FG : C_TITLE;
    gr.GdiDrawText(glyph, fActionIcon, fg, x + padX, y - 1, iconSize + 3, h, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    gr.GdiDrawText(label, fAction, fg, x + padX + iconSize + iconGap, y, lw + 4, h, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    return w;
}

function drawAlbumTracks(gr, x, y, w, h) {
    albumGeo = { x: x, y: y, w: w, h: h };
    albumRowH = clamp(Math.round(H * 0.048), 26, 40);
    var n = albumSel.count;
    albumMax = Math.max(0, n * albumRowH - h);
    albumScrollTo = clamp(albumScrollTo, 0, albumMax);
    var nowKey = curNowKey();
    var ar = (ACCENT >> 16) & 255, ag = (ACCENT >> 8) & 255, ab = ACCENT & 255;
    var top = y - albumScroll;
    for (var i = 0; i < n; i++) {
        var ry = top + i * albumRowH;
        if (ry + albumRowH < y || ry > y + h) continue;
        var hnd = lib[albumSel.start + i];
        var playing = nowKey && (TF.path.EvalWithMetadb(hnd) === nowKey), hov = (i === albumHover);
        if (playing) { gr.SetSmoothingMode(2); gr.FillRoundRect(x - 6, ry + 1, w + 12, albumRowH - 2, 5, 5, RGBA(ar, ag, ab, 34)); gr.SetSmoothingMode(0); }
        else if (hov) gr.FillSolidRect(x - 6, ry + 1, w + 12, albumRowH - 2, RGBA(255, 255, 255, 12));
        gr.GdiDrawText(TF.row.EvalWithMetadb(hnd), playing ? fRowHi : fRow, playing ? ACCENT : C_TITLE, x + 4, ry, w - 58, albumRowH, DT_LEFT | DT_VCENTER | TXT);
        gr.GdiDrawText(TF.rowLen.EvalWithMetadb(hnd), fRow, playing ? ACCENT : C_SUB, x + w - 52, ry, 48, albumRowH, DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }
}

function paintAlbum(gr) {
    if (!albumSel || !lib) { browseView = 'grid'; return; }
    var a = albumSel, areaY = TABBAR_H, areaH = H - TABBAR_H, padX = 28;
    if (a.dbg) { gr.SetInterpolationMode(7); gr.DrawImage(a.dbg, 0, 0, W, H, 0, 0, a.dbg.Width, a.dbg.Height, 0, 255); gr.FillSolidRect(0, 0, W, H, RGBA(18, 18, 20, 205)); }
    else gr.FillSolidRect(0, 0, W, H, C_BG);

    drawBackButton(gr, albumBtnHover === 'back');

    var leftW = Math.round(W * 0.42), topY = areaY + 56;
    var coverSize = clamp(Math.min(leftW - padX * 2, areaH - 56 - 180), 120, 440);
    var coverX = padX + Math.round((leftW - padX * 2 - coverSize) / 2), coverY = topY;
    var cimg = a.dcover || a.art;
    if (cimg) {
        var iw = cimg.Width, ih = cimg.Height, s = Math.min(iw, ih);
        gr.SetInterpolationMode(7); gr.SetSmoothingMode(2);
        gr.FillSolidRect(coverX + 6, coverY + 10, coverSize, coverSize, RGBA(0, 0, 0, 70));
        gr.DrawImage(cimg, coverX, coverY, coverSize, coverSize, Math.round((iw - s) / 2), 0, s, s, 0, 255);
    }
    var tX = padX, tW = leftW - padX * 2, tY = coverY + coverSize + 18;
    gr.GdiDrawText(a.album, fAlbumTitle, C_TITLE, tX, tY, tW, Math.round(H * 0.06), DT_LEFT | DT_TOP | TXT);
    gr.GdiDrawText(a.artist, fNpArtist, ACCENT, tX, tY + Math.round(H * 0.058), tW, Math.round(H * 0.04), DT_LEFT | DT_TOP | TXT);
    var parts = [a.dYear, a.dGenre, a.count + (a.count === 1 ? ' song' : ' songs'), a.dTotal];
    var info = [];
    for (var p = 0; p < parts.length; p++) if (parts[p]) info.push(parts[p]);
    gr.GdiDrawText(info.join('   -   '), fHdrSub, C_SUB, tX, tY + Math.round(H * 0.098), tW, Math.round(H * 0.035), DT_LEFT | DT_TOP | TXT);

    var by = tY + Math.round(H * 0.145), bh = clamp(Math.round(H * 0.05), 28, 40);
    var pw = drawAlbumPill(gr, tX, by, bh, G_PLAY, 'Play', true, albumBtnHover === 'play');
    albumPlayRect = { x: tX, y: by, w: pw, h: bh };
    var sx = tX + pw + 10;
    var sw = drawAlbumPill(gr, sx, by, bh, G_SHUF, 'Shuffle', false, albumBtnHover === 'shuffle');
    albumShufRect = { x: sx, y: by, w: sw, h: bh };

    drawAlbumTracks(gr, leftW + padX, topY, W - leftW - padX * 2, areaH - 56 - 22);
}

function albumBtnAt(x, y) {
    function inR(r) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    if (inR(albumBackRect)) return 'back';
    if (inR(albumPlayRect)) return 'play';
    if (inR(albumShufRect)) return 'shuffle';
    return '';
}

function albumRowAt(x, y) {
    var g = albumGeo;
    if (!albumSel || g.w <= 0) return -1;
    if (x < g.x - 6 || x > g.x + g.w + 6 || y < g.y || y > g.y + g.h) return -1;
    var i = Math.floor((y - g.y + albumScroll) / albumRowH);
    return (i >= 0 && i < albumSel.count) ? i : -1;
}

function drawCover(gr, img, boxX, boxY, boxW, boxH) {
    var s = Math.min(boxW / img.Width, boxH / img.Height);
    var w = Math.round(img.Width * s), h = Math.round(img.Height * s);
    var x = Math.round(boxX + (boxW - w) / 2), y = Math.round(boxY + (boxH - h) / 2);
    gr.SetSmoothingMode(2);
    gr.FillSolidRect(x + 6, y + 10, w, h, RGBA(0, 0, 0, 70));   // soft drop shadow
    gr.DrawImage(img, x, y, w, h, 0, 0, img.Width, img.Height, 0, 255);
}

function layoutNpRows() {
    var headerH = Math.round(npRowH * 2.35), firstH = Math.round(npRowH * 2.0), y = 0;
    for (var k = 0; k < npRows.length; k++) {
        var e = npRows[k];
        e.h = (e.type === 'header') ? (k === 0 ? firstH : headerH) : npRowH;
        e.y = y; y += e.h;
    }
    return y;
}

function drawNpList(gr, x, y, w, h) {
    npListGeo = { x: x, y: y, w: w, h: h };
    if (!npRows.length) return;
    var total = layoutNpRows();
    npListMax = Math.max(0, total - h);
    if (npCenterPending && npPlayingItem >= 0) {
        var py0 = 0;
        for (var k0 = 0; k0 < npRows.length; k0++) { if (npRows[k0].type === 'track' && npRows[k0].i === npPlayingItem) { py0 = npRows[k0].y; break; } }
        npListScroll = clamp(py0 - h / 2 + npRowH / 2, 0, npListMax);
        npListScrollTo = npListScroll; npCenterPending = false;
    }
    npListScrollTo = clamp(npListScrollTo, 0, npListMax);
    var ar = (ACCENT >> 16) & 255, ag = (ACCENT >> 8) & 255, ab = ACCENT & 255;
    var top = y - npListScroll;
    for (var k = 0; k < npRows.length; k++) {
        var e = npRows[k], ry = top + e.y;
        if (ry + e.h < y || ry > y + h) continue;
        if (e.type === 'header') {
            if (k !== 0) gr.FillSolidRect(x + 2, ry + 3, w - 4, 1, C_LINE);
            var pad = Math.round(npRowH * 0.30), thumb = e.h - pad * 2, tx = x + 2, tyy = ry + pad;
            if (e.art) {
                var iw = e.art.Width, ih = e.art.Height, ss = Math.min(iw, ih);
                gr.SetInterpolationMode(scrolling ? 3 : 7);
                gr.DrawImage(e.art, tx, tyy, thumb, thumb, Math.round((iw - ss) / 2), 0, ss, ss, 0, 255);
            } else {
                gr.SetSmoothingMode(2); gr.FillRoundRect(tx, tyy, thumb, thumb, 5, 5, C_CELL); gr.SetSmoothingMode(0);
            }
            var rightW = Math.round(w * 0.32), rcx = x + w - rightW;
            gr.GdiDrawText(e.year, fHdrSub, C_SUB, rcx, tyy, rightW, Math.round(thumb * 0.5), DT_RIGHT | DT_TOP | TXT);
            if (e.genre) gr.GdiDrawText(e.genre, fHdrSub, C_SUB, rcx, tyy + Math.round(thumb * 0.5), rightW, Math.round(thumb * 0.5), DT_RIGHT | DT_BOTTOM | TXT);
            var htX = tx + thumb + 14, htW = rcx - htX - 10;
            if (htW > 20) {
                gr.GdiDrawText(e.artist || e.album, fHdr, C_TITLE, htX, tyy, htW, Math.round(thumb * 0.56), DT_LEFT | DT_BOTTOM | TXT);
                gr.GdiDrawText('> ' + e.album, fHdrSub, C_SUB, htX, tyy + Math.round(thumb * 0.56), htW, Math.round(thumb * 0.44), DT_LEFT | DT_TOP | TXT);
            }
        } else {
            var i = e.i, playing = (i === npPlayingItem), hov = (i === npListHover);
            if (playing) { gr.SetSmoothingMode(2); gr.FillRoundRect(x - 6, ry + 1, w + 12, npRowH - 2, 5, 5, RGBA(ar, ag, ab, 34)); gr.SetSmoothingMode(0); }
            else if (hov) gr.FillSolidRect(x - 6, ry + 1, w + 12, npRowH - 2, RGBA(255, 255, 255, 12));
            var hi = npList[i];
            gr.GdiDrawText(TF.row.EvalWithMetadb(hi), playing ? fRowHi : fRow, playing ? ACCENT : C_TITLE, x + 4, ry, w - 58, npRowH, DT_LEFT | DT_VCENTER | TXT);
            gr.GdiDrawText(TF.rowLen.EvalWithMetadb(hi), fRow, playing ? ACCENT : C_SUB, x + w - 52, ry, 48, npRowH, DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        }
    }
}

function paintNowPlaying(gr) {
    var haveList = npList && npList.Count;
    if (!npArt && !haveList) {
        gr.GdiDrawText('Nothing playing', fMsg, C_SUB, 0, TABBAR_H, W, H - TABBAR_H, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        return;
    }
    var areaY = TABBAR_H, areaH = H - TABBAR_H;
    gr.SetInterpolationMode(7);
    var wide = (W >= 760 && haveList);
    var paneW = wide ? Math.round(W * 0.52) : W;
    var pad = Math.round(Math.min(paneW, areaH) * 0.07);
    var textH = Math.round(areaH * (wide ? 0.16 : 0.18));
    if (npArt) drawCover(gr, npArt, pad, areaY + pad, paneW - pad * 2, areaH - textH - pad * 2);
    var ty = areaY + areaH - textH;
    gr.GdiDrawText(TF.npTitle.Eval(),  fNpTitle,  C_TITLE, 24, ty,                            paneW - 48, Math.round(textH * 0.44), DT_CENTER | DT_BOTTOM | TXT);
    gr.GdiDrawText(TF.npArtist.Eval(), fNpArtist, ACCENT,  24, ty + Math.round(textH * 0.46), paneW - 48, Math.round(textH * 0.30), DT_CENTER | DT_TOP | TXT);
    if (!wide || areaH > 360)
        gr.GdiDrawText(TF.npAlbum.Eval(), fNpAlbum, C_SUB, 24, ty + Math.round(textH * 0.74), paneW - 48, Math.round(textH * 0.26), DT_CENTER | DT_TOP | TXT);
    if (wide) {
        var rx = paneW + 22, rw = W - paneW - 44;
        var togY = areaY + 14, togH = clamp(Math.round(H * 0.032), 22, 30);
        var cy0 = togY + togH + 14, ch = areaH - (cy0 - areaY) - 16;
        if (npRight === 'lyrics') { npListGeo = { x: 0, y: 0, w: 0, h: 0 }; drawLyricsPane(gr, rx, cy0, rw, ch); }
        else { lyricOffMinusRect = null; lyricOffPlusRect = null; drawNpList(gr, rx, cy0, rw, ch); }
        maskStrip(gr, rx - 8, areaY, rw + 16, cy0 - areaY - 4);   // hide list rows scrolled up behind the toggle
        drawNpToggle(gr, rx, togY, rw, togH);
    } else { npListGeo = { x: 0, y: 0, w: 0, h: 0 }; npTogQ = npTogL = null; }
}

// Re-paints the Now Playing backdrop over a rect so scrolled content behind the toggle is hidden.
// Renders through a cached offscreen so it's a pixel-exact 1:1 copy of the backdrop (no re-scale seam).
function maskStrip(gr, sx, sy, sw, sh) {
    if (sh <= 0 || sw <= 0) return;
    if (!npBg) { gr.FillSolidRect(sx, sy, sw, sh, C_BG); return; }
    var key = sx + '_' + sy + '_' + sw + '_' + sh + '_' + W + '_' + H + '_' + npBgVer;
    if (key !== npMaskKey || !npMaskImg) {
        try {
            var img = gdi.CreateImage(sw, sh), g2 = img.GetGraphics();
            g2.SetInterpolationMode(7);
            g2.DrawImage(npBg, -sx, -sy, W, H, 0, 0, npBg.Width, npBg.Height, 0, 255);   // same scale as the full backdrop, shifted so the strip lands at 0,0
            g2.FillSolidRect(0, 0, sw, sh, RGBA(16, 16, 18, 150));
            img.ReleaseGraphics(g2);
            npMaskImg = img; npMaskKey = key;
        } catch (e) { npMaskImg = null; }
    }
    if (npMaskImg) gr.DrawImage(npMaskImg, sx, sy, sw, sh, 0, 0, sw, sh, 0, 255);
    else {
        gr.SetInterpolationMode(7);
        gr.DrawImage(npBg, sx, sy, sw, sh, npBg.Width * sx / W, npBg.Height * sy / H, npBg.Width * sw / W, npBg.Height * sh / H, 0, 255);
        gr.FillSolidRect(sx, sy, sw, sh, RGBA(16, 16, 18, 150));
    }
}

function drawNpToggle(gr, x, y, w, h) {
    var lw = Math.round(w / 2), rw2 = w - lw;
    var qOn = npRight !== 'lyrics';
    var ar = (ACCENT >> 16) & 255, ag = (ACCENT >> 8) & 255, ab = ACCENT & 255;
    gr.SetSmoothingMode(2);
    gr.FillRoundRect(x, y, w, h, h / 2, h / 2, RGBA(255, 255, 255, 14));
    gr.FillRoundRect(qOn ? x : x + lw, y, qOn ? lw : rw2, h, h / 2, h / 2, RGBA(ar, ag, ab, 60));
    gr.SetSmoothingMode(0);
    gr.GdiDrawText('Up next', fRow, qOn ? C_TITLE : C_SUB, x, y, lw, h, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    gr.GdiDrawText('Lyrics', fRow, qOn ? C_SUB : C_TITLE, x + lw, y, rw2, h, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    npTogQ = { x: x, y: y, w: lw, h: h };
    npTogL = { x: x + lw, y: y, w: rw2, h: h };
}

// Renders the lyrics view (synced or plain) + the per-song offset control inside any rect.
function drawLyricsPane(gr, ax, ay, aw, ah) {
    lyricOffMinusRect = null; lyricOffPlusRect = null;
    var midY = ay + ah / 2, lm = Math.max(20, Math.round(aw * 0.07));
    if (!lyrics.length) {
        gr.GdiDrawText(lyricMsg || 'No lyrics', fMsg, C_SUB, ax, ay, aw, ah, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        return;
    }
    if (!lyricSynced) {
        var yy = ay + 24 - lyricScroll;
        for (var i = 0; i < lyrics.length; i++) {
            var ly = yy + i * lyricLineH;
            if (ly > ay - lyricLineH && ly < ay + ah)
                gr.GdiDrawText(lyrics[i].text, fLyric, C_SUB, ax + lm, ly, aw - lm * 2, lyricLineH, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
        }
        return;
    }
    var base = midY - lyricScroll - lyricLineH / 2;
    for (var j = 0; j < lyrics.length; j++) {
        var y = base + j * lyricLineH;
        if (y < ay - lyricLineH || y > ay + ah) continue;
        if (!lyrics[j].text) continue;
        var cur = (j === lyricIndex), dist = Math.abs(j - lyricIndex);
        // Keep off lines readable: gentle fade to a legible floor; current stands out by weight + size + brightness.
        var lv = cur ? 240 : clamp(208 - dist * 12, 162, 208);
        var col = cur ? C_TITLE : RGB(lv, lv, Math.min(255, lv + 5));
        gr.GdiDrawText(lyrics[j].text, cur ? fLyricCur : fLyric, col,
            ax + lm, y, aw - lm * 2, lyricLineH + 6, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS);
    }
    var oh = clamp(Math.round(H * 0.032), 22, 30), oy = ay + 10, bw = oh, pad = 12, lblW = 54;
    var px = ax + aw - pad - bw, lx = px - 6 - lblW, mx = lx - 6 - bw;
    var lbl = (lyricOffset > 0 ? '+' : '') + lyricOffset.toFixed(1) + 's';
    gr.SetSmoothingMode(2);
    gr.FillRoundRect(mx, oy, bw, oh, 6, 6, RGBA(255, 255, 255, lyricOffHover === 'minus' ? 46 : 18));
    gr.GdiDrawText('-', fRowHi, C_TITLE, mx, oy - 2, bw, oh, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    gr.GdiDrawText(lbl, fRow, lyricOffset !== 0 ? ACCENT : C_SUB, lx, oy, lblW, oh, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    gr.FillRoundRect(px, oy, bw, oh, 6, 6, RGBA(255, 255, 255, lyricOffHover === 'plus' ? 46 : 18));
    gr.GdiDrawText('+', fRowHi, C_TITLE, px, oy - 2, bw, oh, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    gr.SetSmoothingMode(0);
    lyricOffMinusRect = { x: mx, y: oy, w: bw, h: oh };
    lyricOffPlusRect = { x: px, y: oy, w: bw, h: oh };
}

function paintLyrics(gr) { drawLyricsPane(gr, 0, TABBAR_H, W, H - TABBAR_H); }

function on_paint(gr) {
    if (W <= 0 || H <= 0) return;
    try { paintBackdrop(gr); } catch (e) { gr.FillSolidRect(0, 0, W, H, C_BG); }
    try {
        if (activeTab === 0) { if (browseView === 'album') paintAlbum(gr); else paintBrowse(gr); }
        else if (activeTab === 1) paintNowPlaying(gr);
        else paintLyrics(gr);
    } catch (e) {}
    try { paintTabBar(gr); } catch (e) {}
}

// =====================================================================
//  TAB SWITCHING
// =====================================================================
function setTab(n) {
    n = clamp(n, 0, 2);
    if (n === activeTab) { window.NotifyOthers('shell_tab', n); return; }
    activeTab = n;
    window.SetProperty('shell.activeTab', n);
    window.NotifyOthers('shell_tab', n);
    if (n === 2 && !lyrics.length && !lyricMsg) loadLyrics(fb.GetNowPlaying());
    startAnim();
    window.Repaint();
}

// =====================================================================
//  MOUSE
// =====================================================================
function tabAt(x, y) {
    if (y > TABBAR_H) return -1;
    for (var i = 0; i < tabRects.length; i++) {
        if (x >= tabRects[i].x && x <= tabRects[i].x + tabRects[i].w) return i;
    }
    return -1;
}

function actionAt(x, y) {
    for (var i = 0; i < actionRects.length; i++) {
        var r = actionRects[i];
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
    }
    return '';
}

function gridAt(x, y) {
    if (y <= TABBAR_H || activeTab !== 0) return -1;
    var relY = y - grid.y - grid.top + gridScroll;
    var r = Math.floor(relY / grid.rowH);
    if (r < 0) return -1;
    var relX = x - grid.x;
    var colStep = grid.cellW + grid.gap;
    var c = Math.floor(relX / colStep);
    if (c < 0 || c >= grid.cols) return -1;
    if (relX - c * colStep > grid.cellW) return -1;    // in the gutter
    var yInRow = relY - r * grid.rowH;
    if (yInRow > grid.coverH + grid.labelH) return -1;
    var idx = r * grid.cols + c;
    return (idx >= 0 && idx < albums.length) ? idx : -1;
}

function npRowAt(x, y) {
    var g = npListGeo;
    if (activeTab !== 1 || !npRows.length || g.w <= 0) return -1;
    if (x < g.x - 6 || x > g.x + g.w + 6 || y < g.y || y > g.y + g.h) return -1;
    var ry = y - g.y + npListScroll;
    for (var k = 0; k < npRows.length; k++) {
        var e = npRows[k];
        if (ry >= e.y && ry < e.y + e.h) return (e.type === 'track') ? e.i : -1;
    }
    return -1;
}

function lyricOffAt(x, y) {
    function inR(r) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    if (inR(lyricOffMinusRect)) return 'minus';
    if (inR(lyricOffPlusRect)) return 'plus';
    return '';
}
function npTogAt(x, y) {
    function inR(r) { return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }
    if (inR(npTogQ)) return 'queue';
    if (inR(npTogL)) return 'lyrics';
    return '';
}

function on_mouse_move(x, y) {
    var t = tabAt(x, y);
    if (t !== tabHover) { tabHover = t; window.Repaint(); }
    var ah = actionAt(x, y);
    if (ah !== actionHover) { actionHover = ah; window.Repaint(); }
    var lo = lyricOffAt(x, y);                    // offset control (Lyrics tab or NP right pane)
    if (lo !== lyricOffHover) { lyricOffHover = lo; window.Repaint(); }
    if (activeTab === 0) {
        if (browseView === 'grid') {
            var g = gridAt(x, y);
            if (g !== grid.selHover) { grid.selHover = g; window.Repaint(); }
        } else {
            var abh = albumBtnAt(x, y), atr = (abh === '') ? albumRowAt(x, y) : -1;
            if (abh !== albumBtnHover || atr !== albumHover) { albumBtnHover = abh; albumHover = atr; window.Repaint(); }
        }
    } else if (activeTab === 1) {
        var tg = npTogAt(x, y);
        if (tg !== npTogHover) { npTogHover = tg; window.Repaint(); }
        var r = (npRight === 'queue') ? npRowAt(x, y) : -1;
        if (r !== npListHover) { npListHover = r; window.Repaint(); }
    }
}

function on_mouse_leave() {
    if (tabHover !== -1 || grid.selHover !== -1 || npListHover !== -1 || actionHover !== '' || albumHover !== -1 || albumBtnHover !== '' || lyricOffHover !== '' || npTogHover !== '') {
        tabHover = -1; grid.selHover = -1; npListHover = -1; actionHover = ''; albumHover = -1; albumBtnHover = ''; lyricOffHover = ''; npTogHover = ''; window.Repaint();
    }
}

function on_mouse_lbtn_up(x, y) {
    var a = actionAt(x, y);
    if (a) { if (a === 'play_all') playAll(false); else if (a === 'shuffle_all') playAll(true); setTab(1); return; }
    var t = tabAt(x, y);
    if (t !== -1) {
        if (t === 0 && activeTab === 0 && browseView === 'album') { browseView = 'grid'; window.Repaint(); }
        setTab(t); return;
    }
    var lo = lyricOffAt(x, y);                    // offset control (Lyrics tab or NP right pane)
    if (lo === 'minus') { adjustOffset(-0.1); return; }
    if (lo === 'plus') { adjustOffset(0.1); return; }
    if (activeTab === 1) {
        var tg = npTogAt(x, y);
        if (tg) { setNpRight(tg); return; }
    }
    if (activeTab === 0) {
        if (browseView === 'grid') {
            var g = gridAt(x, y);
            if (g !== -1) openAlbum(albums[g]);
        } else {
            var bh = albumBtnAt(x, y);
            if (bh === 'back') { browseView = 'grid'; window.Repaint(); }
            else if (bh === 'play') { playAlbum(albumSel, 0, false); setTab(1); }
            else if (bh === 'shuffle') { playAlbum(albumSel, 0, true); setTab(1); }
        }
    }
}

function on_mouse_lbtn_dblclk(x, y) {
    if (activeTab === 0 && browseView === 'album') {
        var tr = albumRowAt(x, y);
        if (tr !== -1) { playAlbum(albumSel, tr, false); setTab(1); }
    } else if (activeTab === 1 && npRight === 'queue') {
        var r = npRowAt(x, y);
        if (r !== -1) { try { plman.ExecutePlaylistDefaultAction(npPlaylist, r); } catch (e) {} }
    }
}

function on_mouse_wheel(step) {
    if (activeTab === 0) {
        if (browseView === 'album') albumScrollTo = clamp(albumScrollTo - step * Math.round((albumGeo.h || 400) * 0.34), 0, albumMax);
        else gridScrollTo = clamp(gridScrollTo - step * Math.round(grid.rowH * 0.9), 0, grid.max);
        startAnim();
    } else if (lyricsActive() && lyricSynced && lyricOffHover !== '') {
        adjustOffset(step > 0 ? 0.1 : -0.1);          // wheel over the offset control = quick nudge
    } else if (lyricsActive() && !lyricSynced && lyrics.length) {
        var maxL = Math.max(0, lyrics.length * lyricLineH - (H - TABBAR_H) + 40);
        lyricScrollTo = clamp(lyricScrollTo - step * lyricLineH, 0, maxL);
        startAnim();
    } else if (activeTab === 1 && npRight === 'queue' && npList && npList.Count) {
        npListScrollTo = clamp(npListScrollTo - step * Math.round((npListGeo.h || 400) * 0.34), 0, npListMax);
        startAnim();
    }
}

// =====================================================================
//  CALLBACKS
// =====================================================================
function on_playback_new_track(metadb) {
    loadNpArt(metadb);
    loadLyrics(metadb);
    refreshNp();
    lyricScroll = 0; lyricScrollTo = 0; lyricIndex = -1;
    if (activeTab === 1 || activeTab === 2) startAnim();
    window.Repaint();
}
function on_playback_time(t) {
    if (lyricsActive() && lyricSynced) {
        var ni = currentLyric(t);
        if (ni !== lyricIndex) { lyricIndex = ni; lyricScrollTo = Math.max(0, ni) * lyricLineH; }
        startAnim();
    }
}
function on_playlist_switch()          { buildNpList(); if (activeTab === 1) { startAnim(); window.Repaint(); } }
function on_playlist_items_added(p)    { buildNpList(); if (activeTab === 1) window.Repaint(); }
function on_playlist_items_removed(p)  { buildNpList(); if (activeTab === 1) window.Repaint(); }
function on_playlist_items_reordered(p){ buildNpList(); if (activeTab === 1) window.Repaint(); }
function on_playback_stop(reason) {
    if (reason !== 2) { loadNpArt(null); lyrics = []; lyricMsg = 'Nothing playing'; window.Repaint(); }
}
function on_library_items_added()   { buildAlbums(); layoutGrid(); if (activeTab === 0) { startAnim(); window.Repaint(); } }
function on_library_items_removed() { buildAlbums(); layoutGrid(); if (activeTab === 0) { startAnim(); window.Repaint(); } }
function on_library_items_changed() { buildAlbums(); layoutGrid(); if (activeTab === 0) { startAnim(); window.Repaint(); } }

function on_notify_data(name, info) {
    if (name === 'shell_nav') setTab(info | 0);
    else if (name === 'shell_query') window.NotifyOthers('shell_tab', activeTab);
}

// =====================================================================
//  INIT
// =====================================================================
grid.selHover = -1;
buildAlbums();
buildLyricsIndex();
loadNpArt(fb.GetNowPlaying());
loadLyrics(fb.GetNowPlaying());
buildNpList();
try { window.NotifyOthers('shell_tab', activeTab); } catch (e) {}
startAnim();
