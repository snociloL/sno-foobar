'use strict';

// Modern player bar — cover-derived accent, Segoe MDL2 vector glyphs, fully responsive.
// Self-contained: no external includes. Icons come from Windows' built-in "Segoe MDL2
// Assets" font, so nothing extra needs installing and they stay crisp at any size.
window.DefineScript('Player Bar', { author: 'redesign', options: { grab_focus: false } });

// ---------- colour + math helpers ----------
function RGB(r, g, b)     { return (0xff000000 | (r << 16) | (g << 8) | b) >>> 0; }
function RGBA(r, g, b, a) { return (((a & 0xff) << 24) | (r << 16) | (g << 8) | b) >>> 0; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function lum(r, g, b)     { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// ---------- GdiDrawText flags ----------
var DT_LEFT = 0, DT_CENTER = 1, DT_RIGHT = 2, DT_TOP = 0, DT_VCENTER = 4, DT_BOTTOM = 8,
    DT_SINGLELINE = 0x20, DT_NOPREFIX = 0x800, DT_END_ELLIPSIS = 0x8000;
var TXT    = DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;
var ICON_C = DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX;

// ---------- Segoe MDL2 Assets glyphs (Windows built-in symbol font) ----------
var ICON_FONT = 'Segoe MDL2 Assets';
var G = { play: '\uE768', pause: '\uE769', prev: '\uE892', next: '\uE893',
          shuffle: '\uE8B1', repeatAll: '\uE8EE', repeatOne: '\uE8ED' };
var G_VOL = String.fromCharCode(0xE767), G_MUTE = String.fromCharCode(0xE74F);   // speaker glyphs (ASCII-safe)

// ---------- palette ----------
var C_BG      = RGB(24, 24, 27);
var C_TITLE   = RGB(240, 240, 242);
var C_ARTIST  = RGB(152, 152, 158);
var C_TIME    = RGB(140, 140, 146);
var C_ICON    = RGB(206, 206, 212);
var C_ICON_HI = RGB(245, 245, 248);
var C_ICON_LO = RGB(104, 104, 112);
var C_TRACK   = RGB(52, 52, 58);
var ACCENT    = RGB(224, 69, 74);   // fallback (theme red); replaced per track
var ACCENT_FG = RGB(255, 255, 255);

// ---------- title formats ----------
var TF = {
    title  : fb.TitleFormat('%title%'),
    artist : fb.TitleFormat('[%artist%]'),
    elapsed: fb.TitleFormat('%playback_time%'),
    total  : fb.TitleFormat('[%length%]')
};

// ---------- state ----------
var W = 0, H = 0, pad = 0;
var art = null, bg = null, artSize = 0, artX = 0, artY = 0;
var textX = 0, textW = 0;
var seekH = 3, seekHit = 14;                      // fallback bottom hairline (narrow bars)
var inlineSeek = false;                           // center inline seek bar with times + hover scrub
var seekX = 0, seekW = 0, seekCY = 0, seekRestH = 4, seekBigH = 7;
var elapsedTX = 0, elapsedTW = 0, totalTX = 0, totalTW = 0;
var seekHover = false, seekMX = 0;
var volShow = false, volSlX = 0, volSlW = 0, volCY = 0, volIconX = 0, volIconW = 0;
var volHover = false, volIconHover = false, volDragging = false, muted = false, savedVol = 0;
var iconSize = 20, playD = 34;
var btns = [];
var hoverId = '', dragging = false;
var shellTab = -1;   // which Content Shell tab is active (echoed via 'shell_tab'); -1 = unknown
var fTitle, fArtist, fTime, fIcon, fPlay, fBubble;

// ---------- accent extracted from the cover ----------
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

function loadArt(metadb) {
    art = null; bg = null;
    if (!metadb) { computeAccent(null); return; }
    var full = utils.GetAlbumArtV2(metadb, 0);
    computeAccent(full);
    if (full) {
        art = full.Width > 300
            ? full.Resize(300, Math.max(1, Math.round(full.Height * 300 / full.Width)), 2)
            : full;
        try { var _b = full.Resize(80, 80, 2); var _r = _b.StackBlur(40); bg = _r || _b; var _f = bg.RotateFlip(6); bg = _f || bg; } catch (e) { bg = full.Resize(8, 8, 2); }
    }
}

// ---------- fonts + layout ----------
function buildFonts() {
    fTitle  = gdi.Font('Segoe UI', clamp(Math.round(H * 0.20), 11, 21), 0);
    fArtist = gdi.Font('Segoe UI', clamp(Math.round(H * 0.155), 9, 16), 0);
    fTime   = gdi.Font('Segoe UI', clamp(Math.round(H * 0.15), 9, 15), 0);
    fIcon   = gdi.Font(ICON_FONT, clamp(Math.round(iconSize * 0.72), 10, 22), 0);
    fPlay   = gdi.Font(ICON_FONT, clamp(Math.round(playD * 0.42), 10, 22), 0);
    fBubble = gdi.Font('Segoe UI', clamp(Math.round(H * 0.16), 9, 13), 0);
}

function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    var m = Math.floor(s / 60), ss = s % 60;
    return m + ':' + (ss < 10 ? '0' + ss : ss);
}

function buildButtons(extra, rightEdge) {
    btns = [];
    var gapN = clamp(Math.round(iconSize * 0.85), 10, 22);
    var gapP = clamp(Math.round(iconSize * 0.60), 8, 16);
    var cy = Math.round(H / 2), x = rightEdge;
    function place(id, w) { x -= w; btns.unshift({ id: id, x: x, y: Math.round(cy - w / 2), w: w, h: w }); }
    if (extra) { place('repeat', iconSize); x -= gapN; }
    place('next', iconSize); x -= gapP;
    place('play', playD);    x -= gapP;
    place('prev', iconSize);
    if (extra) { x -= gapN; place('shuffle', iconSize); }
    x -= Math.round(gapN * 1.3); place('lyrics', iconSize);   // jumps the Content Shell to Lyrics
}

function on_size() {
    W = window.Width; H = window.Height;
    if (W <= 0 || H <= 0) return;
    pad     = clamp(Math.round(H * 0.16), 8, 16);
    artSize = clamp(Math.min(H - pad * 2, 60), 0, 64);
    artX    = pad; artY = Math.round((H - artSize) / 2);
    iconSize = clamp(Math.round(H * 0.42), 16, 26);
    playD    = Math.round(iconSize * 1.7);
    seekH    = clamp(Math.round(H * 0.05), 2, 4);
    seekHit  = clamp(Math.round(H * 0.22), 10, 20);
    seekRestH = clamp(Math.round(H * 0.055), 3, 5);
    seekBigH  = seekRestH + 3;
    seekCY    = Math.round(H / 2);
    buildFonts();

    // volume control reserved at the far right (only when there's room)
    volShow = W > 820;
    var clusterRight = W - pad;
    if (volShow) {
        volSlW  = clamp(Math.round(W * 0.06), 54, 96);
        volSlX  = W - pad - volSlW;
        volIconW = iconSize;
        volIconX = volSlX - 8 - volIconW;
        volCY    = Math.round(H / 2);
        clusterRight = volIconX - Math.round(iconSize * 0.9);
    }

    var extra = W > (artX + artSize + 360);
    buildButtons(extra, clusterRight);
    var groupLeft = btns.length ? btns[0].x : clusterRight;

    textX = artX + artSize + (artSize > 0 ? 12 : 0);
    var textBlockW = clamp(Math.round(W * 0.20), 110, 280);
    var regionL = textX + textBlockW + 24;
    var regionR = groupLeft - 20;
    var timeSlot = 46;
    inlineSeek = (regionR - regionL) > (timeSlot * 2 + 130);
    if (inlineSeek) {
        elapsedTX = regionL; elapsedTW = timeSlot;
        totalTW = timeSlot;  totalTX = regionR - totalTW;
        seekX = elapsedTX + elapsedTW + 12;
        seekW = totalTX - 12 - seekX;
        textW = textBlockW;
    } else {
        seekX = 0; seekW = 0;
        textW = Math.max(0, (groupLeft - 12) - textX);
    }
}

// ---------- paint ----------
function drawArt(gr, img, x, y, size) {
    var iw = img.Width, ih = img.Height, s = Math.min(iw, ih);
    var sx = Math.round((iw - s) / 2);
    gr.DrawImage(img, x, y, size, size, sx, 0, s, s, 0, 255);
    gr.DrawRect(x, y, size - 1, size - 1, 1, RGBA(255, 255, 255, 22));
}

function drawLyricsIcon(gr, b, col) {
    var lh = clamp(Math.round(b.h * 0.13), 2, 4);
    var gap = clamp(Math.round(b.h * 0.17), 2, 6);
    var widths = [1.0, 0.62, 0.86];
    var totalH = 3 * lh + 2 * gap;
    var y = b.y + Math.round((b.h - totalH) / 2);
    gr.SetSmoothingMode(2);
    for (var i = 0; i < 3; i++) {
        var w = Math.round(b.w * widths[i]);
        gr.FillRoundRect(b.x + Math.round((b.w - w) / 2), y, w, lh, lh / 2, lh / 2, col);
        y += lh + gap;
    }
}

function drawBtn(gr, b) {
    var hov = (hoverId === b.id);
    if (b.id === 'lyrics') {
        drawLyricsIcon(gr, b, (shellTab === 2) ? ACCENT : (hov ? C_ICON_HI : C_ICON_LO));
        return;
    }
    if (b.id === 'play') {
        gr.FillEllipse(b.x, b.y, b.w, b.h, ACCENT);
        var pl = fb.IsPlaying && !fb.IsPaused;
        gr.GdiDrawText(pl ? G.pause : G.play, fPlay, ACCENT_FG, b.x, b.y, b.w, b.h, ICON_C);
        return;
    }
    var col = hov ? C_ICON_HI : C_ICON, glyph;
    if (b.id === 'prev') glyph = G.prev;
    else if (b.id === 'next') glyph = G.next;
    else if (b.id === 'shuffle') { glyph = G.shuffle; col = isShuffle() ? ACCENT : (hov ? C_ICON_HI : C_ICON_LO); }
    else if (b.id === 'repeat') {
        var po = plman.PlaybackOrder;
        glyph = (po === 2) ? G.repeatOne : G.repeatAll;
        col = (po === 1 || po === 2) ? ACCENT : (hov ? C_ICON_HI : C_ICON_LO);
    }
    gr.GdiDrawText(glyph, fIcon, col, b.x, b.y, b.w, b.h, ICON_C);
}

function drawInlineSeek(gr) {
    var len = fb.PlaybackLength;
    var hovering = seekHover || dragging;
    var th = hovering ? seekBigH : seekRestH;
    var ty = seekCY - Math.round(th / 2);
    var pr = len > 0 ? clamp(fb.PlaybackTime / len, 0, 1) : 0;
    var cursorR = clamp((seekMX - seekX) / seekW, 0, 1);
    var fillR = (dragging && len > 0) ? cursorR : pr;

    gr.SetSmoothingMode(2);
    gr.FillRoundRect(seekX, ty, seekW, th, th / 2, th / 2, C_TRACK);
    var fw = Math.round(seekW * fillR);
    if (fw > 0) gr.FillRoundRect(seekX, ty, Math.max(fw, th), th, th / 2, th / 2, ACCENT);

    if (hovering && len > 0) {
        var kx = seekX + Math.round(seekW * cursorR), kd = th + 6;
        gr.FillEllipse(kx - kd / 2, seekCY - kd / 2, kd, kd, RGB(255, 255, 255));
    }

    if (len > 0) {
        var elapsed = (dragging ? fillR * len : fb.PlaybackTime);
        gr.GdiDrawText(fmtTime(elapsed), fTime, C_TIME, elapsedTX, 0, elapsedTW, H, DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        gr.GdiDrawText(fmtTime(len),     fTime, C_TIME, totalTX,   0, totalTW, H, DT_LEFT  | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }

    if (hovering && len > 0) {
        var bw = 46, bh = clamp(Math.round(H * 0.34), 16, 22);
        var bx = clamp(seekMX - bw / 2, seekX - 8, seekX + seekW - bw + 8);
        var by = Math.max(2, ty - bh - 7);
        gr.FillRoundRect(bx, by, bw, bh, 5, 5, RGBA(0, 0, 0, 210));
        gr.GdiDrawText(fmtTime(cursorR * len), fBubble, RGB(240, 240, 242), bx, by, bw, bh, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }
}

function volRatio() { return muted ? 0 : clamp((fb.Volume + 100) / 100, 0, 1); }

function drawVolume(gr) {
    if (!volShow) return;
    var ratio = volRatio();
    var glyph = (muted || ratio <= 0.001) ? G_MUTE : G_VOL;
    gr.GdiDrawText(glyph, fIcon, volIconHover ? C_ICON_HI : C_ICON, volIconX, 0, volIconW, H, ICON_C);
    var th = (volHover || volDragging) ? seekBigH : seekRestH;
    var ty = volCY - Math.round(th / 2);
    gr.SetSmoothingMode(2);
    gr.FillRoundRect(volSlX, ty, volSlW, th, th / 2, th / 2, C_TRACK);
    var fw = Math.round(volSlW * ratio);
    if (fw > 0) gr.FillRoundRect(volSlX, ty, Math.max(fw, th), th, th / 2, th / 2, ACCENT);
    if (volHover || volDragging) {
        var kd = th + 6;
        gr.FillEllipse(volSlX + fw - kd / 2, volCY - kd / 2, kd, kd, RGB(255, 255, 255));
    }
}

function on_paint(gr) {
    if (W <= 0 || H <= 0) return;
    if (bg) {
        gr.SetInterpolationMode(7);
        gr.DrawImage(bg, 0, 0, W, H, 0, 0, bg.Width, bg.Height, 0, 255);
        gr.FillSolidRect(0, 0, W, H, RGBA(26, 26, 30, 172));
    } else {
        gr.FillSolidRect(0, 0, W, H, C_BG);
    }
    gr.SetSmoothingMode(2);
    if (art && artSize > 0) drawArt(gr, art, artX, artY, artSize);
    if (textW > 4) {
        gr.GdiDrawText(TF.title.Eval(),  fTitle,  C_TITLE,  textX, 0,                    textW, Math.round(H * 0.52), DT_LEFT | DT_BOTTOM | TXT);
        gr.GdiDrawText(TF.artist.Eval(), fArtist, C_ARTIST, textX, Math.round(H * 0.48), textW, Math.round(H * 0.52), DT_LEFT | DT_TOP | TXT);
    }
    for (var i = 0; i < btns.length; i++) drawBtn(gr, btns[i]);
    drawVolume(gr);
    if (inlineSeek && seekW > 0) {
        drawInlineSeek(gr);
    } else {
        var sy = H - seekH;
        gr.FillSolidRect(0, sy, W, seekH, C_TRACK);
        if (fb.PlaybackLength > 0) {
            var ratio = clamp(fb.PlaybackTime / fb.PlaybackLength, 0, 1);
            gr.FillSolidRect(0, sy, Math.round(W * ratio), seekH, ACCENT);
        }
    }
}

// ---------- playback order ----------
function isShuffle() { var o = plman.PlaybackOrder; return o === 3 || o === 4 || o === 5 || o === 6; }
function toggleShuffle() { plman.PlaybackOrder = isShuffle() ? 0 : 4; window.Repaint(); }
function cycleRepeat() { var o = plman.PlaybackOrder; plman.PlaybackOrder = (o === 1) ? 2 : (o === 2 ? 0 : 1); window.Repaint(); }

// ---------- mouse ----------
function hit(b, x, y) { var m = Math.round(iconSize * 0.35); return x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m; }
function btnAt(x, y) { for (var i = 0; i < btns.length; i++) if (hit(btns[i], x, y)) return btns[i]; return null; }

function inSeek(x, y) {
    if (!inlineSeek || seekW <= 0) return false;
    var v = clamp(Math.round(H * 0.34), 10, 22);
    return x >= seekX - 6 && x <= seekX + seekW + 6 && y >= seekCY - v && y <= seekCY + v;
}
function seekTo(x) { if (fb.PlaybackLength > 0) fb.PlaybackTime = clamp((x - seekX) / seekW, 0, 1) * fb.PlaybackLength; }

function inVolSlider(x, y) {
    if (!volShow) return false;
    var v = clamp(Math.round(H * 0.34), 10, 22);
    return x >= volSlX - 6 && x <= volSlX + volSlW + 6 && y >= volCY - v && y <= volCY + v;
}
function inVolIcon(x, y) {
    if (!volShow) return false;
    var v = clamp(Math.round(H * 0.34), 10, 22);
    return x >= volIconX - 4 && x <= volIconX + volIconW + 4 && y >= volCY - v && y <= volCY + v;
}
function setVol(x) { fb.Volume = clamp((x - volSlX) / volSlW, 0, 1) * 100 - 100; muted = false; }
function toggleMute() {
    if (muted) { fb.Volume = savedVol; muted = false; }
    else { savedVol = fb.Volume; fb.Volume = -100; muted = true; }
    window.Repaint();
}

function on_mouse_move(x, y) {
    seekMX = x;
    var b = btnAt(x, y), id = b ? b.id : '', rp = false;
    if (id !== hoverId) { hoverId = id; rp = true; }
    var vh = !b && inVolSlider(x, y), vih = !b && inVolIcon(x, y);
    if (vh !== volHover) { volHover = vh; rp = true; }
    if (vih !== volIconHover) { volIconHover = vih; rp = true; }
    if (volDragging) { setVol(x); rp = true; }
    var hov = !b && !vh && !vih && inSeek(x, y);
    if (hov !== seekHover) { seekHover = hov; rp = true; }
    if (dragging) { seekTo(x); rp = true; }
    else if (seekHover) rp = true;   // keep the knob + time bubble tracking the cursor
    if (rp) window.Repaint();
}
function on_mouse_leave() {
    if (hoverId || seekHover || volHover || volIconHover) { hoverId = ''; seekHover = false; volHover = false; volIconHover = false; window.Repaint(); }
}
function on_mouse_lbtn_down(x, y) {
    if (btnAt(x, y)) return;
    if (inVolSlider(x, y)) { volDragging = true; setVol(x); window.Repaint(); return; }
    seekMX = x;
    if (inlineSeek) {
        if (inSeek(x, y) && fb.PlaybackLength > 0) { dragging = true; seekHover = true; seekTo(x); window.Repaint(); }
    } else if (y >= H - seekHit && fb.PlaybackLength > 0) {
        dragging = true; fb.PlaybackTime = clamp(x / W, 0, 1) * fb.PlaybackLength;
    }
}
function on_mouse_lbtn_up(x, y) {
    if (dragging) { dragging = false; window.Repaint(); return; }
    if (volDragging) { volDragging = false; window.Repaint(); return; }
    var b = btnAt(x, y);
    if (b) {
        if (b.id === 'prev') fb.Prev();
        else if (b.id === 'next') fb.Next();
        else if (b.id === 'play') fb.PlayOrPause();
        else if (b.id === 'shuffle') toggleShuffle();
        else if (b.id === 'repeat') cycleRepeat();
        else if (b.id === 'lyrics') window.NotifyOthers('shell_nav', shellTab === 2 ? 1 : 2);
        return;
    }
    if (inVolIcon(x, y)) { toggleMute(); return; }
    if (inlineSeek ? (!inSeek(x, y) && !inVolSlider(x, y)) : (y < H - seekHit)) fb.RunMainMenuCommand('View/Show now playing in playlist');
}
function on_mouse_wheel(s) { if (s > 0) fb.VolumeUp(); else fb.VolumeDown(); }

// ---------- callbacks ----------
function on_playback_new_track(m) { loadArt(m); window.Repaint(); }
function on_playback_time(t)      { window.Repaint(); }
function on_playback_pause(p)     { window.Repaint(); }
function on_playback_stop(r)      { window.Repaint(); }
function on_playback_starting(c, p) { window.Repaint(); }
function on_playback_seek(t)      { window.Repaint(); }
function on_playback_order_changed(o) { window.Repaint(); }
function on_notify_data(name, info) { if (name === 'shell_tab') { shellTab = info | 0; window.Repaint(); } }
function on_volume_change(v) { if (v > -99.9) muted = false; window.Repaint(); }

// ---------- init ----------
loadArt(fb.GetNowPlaying());
try { window.NotifyOthers('shell_query', 1); } catch (e) {}   // ask the Content Shell which tab is active
