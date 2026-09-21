# Better screencast preview

This frontend is platform-independent. Capture cadence, target-size acquisition,
delta production and static gating depend on the connected SDK capabilities.
The current toolbar requests JPEG; it does not start a scrcpy process. Existing
H.264 decoder/protocol support from the earlier experiment is retained for
compatible frame events, but is not selected by these controls.

## Controls and quality

- Old / New sends enableBetterScreencast. New is selected by default. The SDK
  decides the old/new capture implementation; this is not a screencast on/off switch.
- Native / FSR enables WebGL2 EASU upscaling followed by RCAS sharpening. FSR is
  opt-in and requires New. Rendering falls back to the composed image on failure.
- SD FSR requests 0.6 of the presentation edge lengths and JPEG quality 40;
  HD FSR requests 0.8 and quality 70. Native requests full presentation dimensions
  with SD quality 20 or HD quality 100. Dimensions account for devicePixelRatio.
- The static-skip control sends enableFrameSignalGate, defaults to false and is
  disabled under Old. Unsupported SDKs may ignore it. Window-frame coverage and
  safety polling are SDK concerns; the frontend does not infer scene stillness.
- Frame rate limit defaults to Auto. ACK follows decode and presentation rather
  than an unconditional extra fixed delay. Optional limits account for elapsed
  pipeline time. Slow element-highlight RPCs do not delay frame presentation.

## Frame handling

JPEG delta regions are composed onto a persistent full-frame canvas before FSR.
Frame/base IDs and dimensions prevent a patch from being applied to the wrong
reference. Only full frames are cached across restarts. A missing base causes the
patch to be ignored until a full frame arrives; the SDK must provide full refresh.
Stream generations invalidate stale presentation/ACK callbacks. The legacy image
path remains available, and optional stream metadata supports capable backends.

Session visibility events help restore the active page during back navigation.
Trace loading reports read/save errors and clears its loading state in finally.
Debug driver listener registration survives delayed connection establishment.
The connector dependency is updated to 0.0.18-alpha.1.

## Upstream integration and validation

Based on upstream/fork main 5effdcc. Three-way integration preserved Network and
GlobalProps panel changes, including their generated protocol entries; no manual
text-conflict resolution was required.

Use Node 20.19.0 for the verified build commands:

    node scripts/build-lynx-devtools.js
    BUILD_ELECTRON_RENDERER=true LDT_BUILD_TYPE=offline MODERN_ENV=offline node_modules/.bin/modern build --config modern.renderer.config.ts
    node --test scripts/tests/screencast-model.test.cjs

The tests cover ACK after decode, stale ACK suppression on stop, delta cache
safety, failed-consumer recovery and pause/resume. They are model tests with CDP
stubs, not end-to-end device or shader visual tests. Earlier Android device
validation does not establish iOS or Harmony capture support.
