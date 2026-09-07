# Keyvoria app icon

`keyvoria-icon.svg` is the master. The PNGs beside it are rendered from it —
regenerate rather than editing them.

## Full bleed, deliberately

The artwork reaches **all four edges**: no padding, no margin, no rounded
corners of its own, no transparency. This is not a style choice, it is what the
platforms require:

- **iOS** applies its own rounded-rectangle mask to the square you supply, and
  rejects icons with an alpha channel. Any margin you draw shows up as a gap
  inside the mask, and any corner rounding you bake in gets rounded a second
  time.
- **Android adaptive icons** crop the layers you supply to a circle, squircle or
  rounded square chosen by the launcher. A background layer that does not bleed
  leaves the corners empty in whatever shape the device picks.

So the white keys run from the top edge to the bottom edge, the key seams are
drawn *on* the keys rather than as gaps between them, and the black keys start
above `y=0` so they bleed off the top rather than stopping short of it.

## The design

Five white keys, three black. Seven would be a full octave and more literally
correct, but at 60px a seven-key icon collapses into stripes and stops reading
as a piano at all — five keys survive the smallest size that ships. One key is
lit in Keyvoria's orange, which is the app in one image: play the right note.

## Sizes

| File | Where it is used |
| --- | --- |
| `keyvoria-icon-1024.png` | App Store listing; the source for any size not here |
| `keyvoria-icon-512.png` | Google Play listing |
| `keyvoria-icon-192.png` | Android launcher (xxhdpi), PWA manifest |
| `keyvoria-icon-180.png` | iPhone home screen (@3x) |
| `keyvoria-icon-152.png` | iPad home screen (@2x) |
| `keyvoria-icon-120.png` | iPhone home screen (@2x) |
| `keyvoria-icon-87.png` | iPhone settings (@3x) |
| `keyvoria-icon-60.png` | iPhone notifications (@3x) |
| `keyvoria-icon-48.png` | Android launcher (mdpi) |
| `keyvoria-icon-32.png` | Favicon / web |

## Regenerating

The PNGs are rasterised from the SVG with headless Chromium at each size. There
is no build step in the repo yet; when the app project lands (roadmap M1) this
belongs in it.

## Still to do when the native apps exist

**Android adaptive icons need a second, separate export.** They take a
foreground and a background layer, and the launcher may crop up to ~33% of each
edge — so the foreground must keep its content inside the middle 66%. That is a
different composition from this one, not a re-export of it, and it should be
drawn when there is an Android project to put it in.
