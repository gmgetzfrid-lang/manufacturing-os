# Synthetic test footage

Renders a virtual living room and hallway and flies five camera paths through
it, following the same shot list the app's capture guide prescribes. Use it to
exercise the reconstruction pipeline without filming anything.

```bash
pip install numpy opencv-python-headless imageio-ffmpeg
python make_test_capture.py --out ./clips
```

Options: `--width`, `--height`, `--fps`, `--scale` (shortens every clip),
`--only video-a video-c`, `--jitter` (handheld wobble multiplier).

Rendering is CPU-bound at roughly a second per frame, so rendering the clips in
parallel is worthwhile:

```bash
for c in video-a video-b video-c video-d video-e; do
  python make_test_capture.py --only $c --fps 15 --scale 0.6 &
done; wait
```

## Read this before trusting a result

This exists to prove the **code path** works — that frames extract, that poses
solve, that separate clips fuse into one model, that the viewer renders and
navigates. It does that honestly: the reconstruction has no idea the images are
synthetic and must solve everything from image content alone.

What it does **not** prove is that your phone footage will reconstruct. Real
capture adds rolling shutter, electronic stabilisation, genuine motion blur,
auto-exposure swings, and large flat surfaces with no texture. Every one of
those is a real failure mode that synthetic frames do not have.

The renderer is a small textured rasteriser with a true z-buffer. Surfaces carry
high-frequency procedural texture because a feature-based reconstructor needs
something to match — blank walls would fail here for reasons that have nothing
to do with the pipeline being tested. Wall paint is deliberately kept
low-contrast so the test is not easier than reality.

## Output

`video-a.mp4` … `video-e.mp4`, H.264, ready to drop into the app.

If your browser cannot decode H.264 (some Chromium builds ship without it),
transcode to VP9:

```bash
ffmpeg -i video-a.mp4 -c:v libvpx-vp9 -b:v 2M video-a-vp9.mp4
```
