# RunForm

A personal web app that analyzes running form from video, built for Safari on iPhone.
All processing happens on the device. There's no backend, no accounts, and no upload.
Pose estimation uses MediaPipe PoseLandmarker. The model files and the WASM runtime are
bundled with the app and precached by the service worker, so after the first load the app
works offline.

**Status:** import, slow-mo timing and auto-trim, pose extraction (WebCodecs with a seek
fallback), gait event detection, Pose Method scoring with coaching feedback and drills,
annotated key frames, and a slow-motion player with a live skeleton overlay.

## What the report measures (side view)

The stride is scored in the Pose Method's three parts. Each part averages its metrics, and
each metric scores 100 inside its guide range, falling to 60 at the edge of the "close"
range and to 0 beyond it. Ranges live in `src/analysis/posemethod.ts`.

| Part | Metrics |
|---|---|
| **Pose** | landing distance ahead of the hips, shin angle at landing, foot strike, knee bend at landing, trunk lean |
| **Fall** | fall angle (ball of foot → hips as the heel lifts), push-off angle at toe-off, vertical bounce |
| **Pull** | swing ankle position in the Pose, heel pull height (peak swing knee bend), ground contact time, cadence |

Front/back clips report crossover, hip drop, step width, contact time and cadence.

Foot contacts come from foot height above a local ground level (hysteresis, scaled by leg
length), validated by the foot moving backward relative to the hips. Landmark trajectories
are low-pass filtered (zero-phase Butterworth: 8 Hz for angles, 16 Hz for events), short
left/right leg swaps from the tracker are corrected, and distances are scaled from the
runner's height (thigh + shank ≈ 0.491 × height, Winter 2009).

## Recording a good clip

- **Camera:** use a tripod at hip height, 3–5 m from the runner, with the camera
  perpendicular to the direction of travel for sagittal (side) clips. For frontal clips,
  put it directly in front of or behind the runner.
- **Frame rate:** use the native Camera app's Slo-mo mode (240 fps works best).
- **Lighting:** bright, even light. Slow-mo uses short exposures, so low light adds
  sensor noise and motion blur, and both hurt landmark accuracy (heels and toes most of all).
- **Clothing:** wear clothes that contrast with the background, with legs and feet clearly
  visible. Avoid baggy shorts and dark shoes on a dark belt.
- **Duration:** on a treadmill, record 15–20 s at a steady pace. Overground, record
  several passes. Each pass only captures 1–2 strides at 3–5 m. Combining passes comes
  in phase 7.
- **Framing:** keep the whole body in frame for the full analysis window, with some
  margin above the head and below the feet.

## Importing: save to Files first

Picking a video from Photos through a browser file input can make iOS transcode or
compress it, and that can drop frames or change the timing. Instead:

1. In Photos, open the clip and tap **Share → Save to Files**.
2. In RunForm, tap **Choose video…** and pick the clip from the **Files** browser.

The diagnostics panel shows exactly what the file contains. If the sample count or the
interval histogram looks wrong, re-export it via Files.

## Slow-mo timing

iPhone slow-mo clips can reach the app in two forms. The diagnostics panel tells you which
one you have:

| What the file contains | Diagnostics show | Settings |
|---|---|---|
| Original high-rate samples on a real-time timeline | ~4.17 ms intervals, ~240 fps | capture 240 fps, factor **1** (detected automatically) |
| Export retimed to a 30 fps playback timeline | ~33.3 ms intervals | capture 240 fps, factor **8** (default when slow-mo metadata is found; otherwise set it yourself) |

- The slow-mo factor means "file seconds per real second." Every timing value is
  converted to real time with `real = (t − t_start) / factor`.
- In a retimed export, only the middle section has a constant factor. The speed ramps at
  the start and end have variable timing. Use the trim controls to exclude them. **Auto:
  longest uniform section** finds the longest run of constant intervals. The histogram
  for the trimmed window should show a single bar.
- The readout compares the capture fps implied by the window's timing and your factor
  against the capture fps you entered, and flags any mismatch.
- **Duplicate frames:** on import, every frame is decoded and reduced to a 64×36
  grayscale hash, and only the hash is kept. A frame counts as a duplicate of the one
  before it when no hash pixel differs by more than the threshold (default 3). The test
  uses the maximum difference, not the mean. With a static background, real consecutive
  240 fps frames differ only where the runner is, so their mean difference can be tiny.
  The panel shows the distribution of differences, so you can judge whether the threshold
  makes sense.

## Frame extraction

- **Primary path:** mp4box.js parses only the `moov` box. The `mdat` payload is skipped,
  and sample bytes are read from the File on demand in 8 MB blocks. WebCodecs
  `VideoDecoder` decodes every sample in the trim window, starting from the keyframe
  before it. Each `VideoFrame` is drawn with the track's rotation applied, hashed, and then
  `close()`d **before** inference runs. At most ~3 decoded frames and ~4 queued chunks
  exist at any time. If any frame in the window never comes out of the decoder, the run
  fails with an error. Frames are never skipped silently.
- **Fallback:** if `VideoDecoder.isConfigSupported()` rejects the codec, the app seeks a
  hidden `<video>` frame by frame. Each seek targets a point a quarter of the way into the
  frame and is checked against `requestVideoFrameCallback`'s `mediaTime`. Each frame gets
  one retry, and the result reports how many seeks couldn't be verified. You can also
  force this path for testing.
- PoseLandmarker runs in VIDEO mode with real-time timestamps. It tries the GPU delegate
  first and falls back to CPU, including when GPU inference fails mid-run.
- Landmarks are stored as `Float32Array`s laid out frame × landmark × (x, y, z, visibility).
  There are three arrays: normalized, pixel, and world (metres). IndexedDB stores them as
  typed arrays.
- **Wake lock:** the app holds a Screen Wake Lock while processing and re-acquires it if
  it's released. **If the page is hidden, extraction pauses.** Tap Resume to continue
  from the next unprocessed frame. Decoding restarts from the nearest keyframe, so no
  progress is lost.

## iOS / Safari notes and workarounds

- The `<video>` element used for seeking has to be in the DOM (it's placed off-screen),
  and it needs `playsinline` and `muted`. Otherwise iOS won't decode frames for it.
- Decoded `VideoFrame`s don't have the track's rotation applied. The app reads the
  `tkhd` matrix and rotates when drawing. The `<video>` element (seek path) already
  presents the rotated frame.
- The app watches `visibilitychange` because iOS can suspend the tab or reclaim the
  decoder or GPU context in the background. Each resume creates a fresh decoder.
- iOS can clear website storage. Session backup/export comes in phase 7. Until then,
  treat saved sessions as temporary.
- Precached assets total about 65 MB: the heavy model (~30 MB), the full model (~9 MB),
  and the SIMD and non-SIMD WASM builds (~13 MB each). Load the page once while online.
  Then Add to Home Screen.

## Development

```sh
npm install
npm run dev        # copies WASM + downloads models into public/, starts Vite
npm test           # Vitest: pure analysis modules
npm run build      # typecheck + production build (dist/)
```

`scripts/prepare-assets.mjs` copies the MediaPipe WASM fileset from `node_modules`. It
also downloads the pinned `float16/1` pose models into `public/`. Both are gitignored and
rebuilt in CI.

Code layout:

- `src/analysis/`: pure TypeScript with no DOM: timing, frame-hash comparison, and
  landmark layout. It's unit-tested in `tests/`.
- `src/media/`: demuxing, sample-table math (`clipmath.ts`, which is pure and tested),
  WebCodecs decoding, the seek fallback, and the duplicate scan.
- `src/pose/`: the landmarker setup and the resumable extractor.
- `src/store/`: IndexedDB via `idb`.

## Native iOS app (Capacitor)

`ios/` is an Xcode project that wraps the same web build in a native app.
The models and WASM are bundled inside the app, so it runs fully offline.
Building it needs a Mac with Xcode, plus Node.js 22+ (`brew install node`).

One-time setup and every update:

```sh
git clone https://github.com/whwellbo-spec/RunForm.git && cd RunForm   # first time
git pull                                                                 # later updates
npm install
npm run ios        # builds the web app, copies it into ios/, opens Xcode
```

In Xcode:

1. Select the **App** target, open **Signing & Capabilities**, and choose your Apple ID
   under **Team**. If you have none listed, add one under **Xcode → Settings → Accounts**.
   If the bundle ID `com.whwellbo.runform` is taken, change it to anything unique.
2. Plug in the iPhone, unlock it, and pick it as the run destination in the toolbar.
3. Press **Run** (⌘R).
4. The first time only, open **Settings → General → VPN & Device Management** on the
   iPhone, trust your developer certificate, and turn on **Developer Mode** if asked
   (**Settings → Privacy & Security**).

With a free Apple ID, the app expires after 7 days. Run it from Xcode again to renew it.
A paid Apple Developer account extends that to a year.

Native-app notes:
- The app keeps the screen awake with the `@capacitor-community/keep-awake` plugin
  (an idle-timer switch) instead of the web Screen Wake Lock API.
- The service worker isn't used inside the app because the files are already local.
- The deployment target is iOS 17, for WebCodecs support in WKWebView. If WebCodecs
  can't decode a clip, the app falls back to seek-based extraction, as on the web.
- Pick clips with **Choose File → Files** rather than the photo library. The photo
  picker can transcode the video.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` runs the tests, builds with
`BASE_PATH=/<repo-name>/`, and deploys `dist/` to Pages on every push to `main`.
To set it up once, open the repo's **Settings → Pages** and set **Source** to
**GitHub Actions**.
