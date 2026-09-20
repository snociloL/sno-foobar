'use strict';

// Now Playing cover — full cover centered over a soft blurred backdrop of itself.
window.DefineScript('Now Playing Art', { author: 'redesign', options: { grab_focus: false } });

function RGBA(r, g, b, a) { return (((a & 0xff) << 24) | (r << 16) | (g << 8) | b) >>> 0; }
var C_BG = RGBA(20, 20, 22, 255);
var img = null, bg = null, W = 0, H = 0;

function load(metadb) {
    img = null; bg = null;
    if (metadb) {
        var full = utils.GetAlbumArtV2(metadb, 0);
        if (full) {
            img = full.Width > 1000
                ? full.Resize(1000, Math.max(1, Math.round(full.Height * 1000 / full.Width)), 2)
                : full;
            bg = full.Resize(8, 8, 2);
        }
    }
    window.Repaint();
}

function on_size() { W = window.Width; H = window.Height; }

function on_paint(gr) {
    if (W <= 0 || H <= 0) return;
    gr.SetInterpolationMode(7);
    if (bg) {
        gr.DrawImage(bg, 0, 0, W, H, 0, 0, bg.Width, bg.Height, 0, 255);
        gr.FillSolidRect(0, 0, W, H, RGBA(16, 16, 18, 188));
    } else {
        gr.FillSolidRect(0, 0, W, H, C_BG);
    }
    if (img) {
        var pad = Math.round(Math.min(W, H) * 0.06);
        var aw = W - pad * 2, ah = H - pad * 2;
        if (aw > 0 && ah > 0) {
            var s = Math.min(aw / img.Width, ah / img.Height);
            var w = Math.round(img.Width * s), h = Math.round(img.Height * s);
            var x = Math.round((W - w) / 2), y = Math.round((H - h) / 2);
            gr.SetSmoothingMode(2);
            gr.DrawImage(img, x, y, w, h, 0, 0, img.Width, img.Height, 0, 255);
        }
    }
}

function on_playback_new_track(metadb) { load(metadb); }

load(fb.GetNowPlaying());
