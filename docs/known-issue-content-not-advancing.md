# Known issue — content doesn't advance / update on the Android player

**Status: log-based diagnosis, NOT yet reproduced under capture. No code fix.**
This note records the investigation done 2026-08-27 so it isn't repeated from
scratch. It is the tracked companion to the `TEMP_DEBUG` comments already sitting
in `IntroScreen.kt` and `PlaylistController.kt` from earlier passes at what is
very likely the same bug.

## Symptom

On a real device the playing content gets **stuck** instead of moving on:

- a fullscreen playlist stays on item 1 and never shows item 2 (earlier report:
  "2-item fullscreen playlist stuck on item 1"), and/or
- a newly-assigned/edited item never actually reaches ExoPlayer — the screen
  keeps showing the previous item (earlier report: "FloFoam never loads, always
  reverting to Bata").

The screen is not blank or erroring — it simply holds the wrong/old item. This
points at the advance/refresh control flow (`PlaylistController` + `IntroScreen`),
not at download or decode.

Single-zone / fullscreen layout path only (`Layout: SINGLE/FULLSCREEN`,
[MainActivity.kt:486](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L486)).
Multi-zone goes through `ZoneManager` and is out of scope for this note.

## Logging availability (release build)

All three suspect paths are observable in a **release** APK via `adb logcat` — no
debug build needed:

- `DebugLog.i/w/e()` call `android.util.Log.*` unconditionally
  ([DebugLog.kt:16-19](../android/app/src/main/java/com/remotedisplay/player/util/DebugLog.kt#L16-L19)).
  The `enabled` flag only gates the dashboard socket stream (`send()`), not logcat.
- Release does **not** minify (`isMinifyEnabled = false`,
  [build.gradle.kts:35](../android/app/build.gradle.kts#L35)), so nothing strips
  `Log.*`. `proguard-rules.pro` has no `-assumenosideeffects` block.

So both the `TEMP_DEBUG` (`DebugLog.*`) lines and the plain `Log.i/Log.w` lines
in `PlaylistController.kt` / `MainActivity.kt` are all visible.

## Suspect code path 1 — `IntroScreen.cancel()` drops `onDone()`

Every fullscreen video is started **inside** the intro-screen completion callback:

```
introScreen.show { mediaPlayer.playVideo(file, item.muted) }
```

[MainActivity.kt:707](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L707),
[:716](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L716),
[:760](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L760).

`show()` posts a `DURATION_MS` (4 s) delayed runnable; that runnable is the only
thing that calls `onDone()` — i.e. the only thing that ever starts the video
([IntroScreen.kt:62-68](../android/app/src/main/java/com/remotedisplay/player/player/IntroScreen.kt#L62-L68)).

If `cancel()` runs during that 4 s window, `removeCallbacks` kills the pending
runnable and `onDone()` is **never called** — the video for that item never
starts and the screen holds whatever was there before
([IntroScreen.kt:72-79](../android/app/src/main/java/com/remotedisplay/player/player/IntroScreen.kt#L72-L79)).

`cancel()` is reachable from:
- `onPlaylistEmpty` and `onNothingScheduled` callbacks
  ([MainActivity.kt:181](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L181),
  [:183](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L183))
- the `suspended` branch of `onPlaylistUpdate`
  ([MainActivity.kt:416](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L416))

**Log signature (already instrumented):**

```
IntroScreen  TEMP_DEBUG cancel(): cancelling a PENDING intro - onDone() will NOT be called for it
```

[IntroScreen.kt:75](../android/app/src/main/java/com/remotedisplay/player/player/IntroScreen.kt#L75).
If this line appears **immediately before** the screen freezes (and with no
following `TEMP_DEBUG show(): ...elapsed, invoking onDone() now` for that item),
this path is the cause.

## Suspect path 2 — `updatePlaylist()` refresh-race force-jumps to item 1

`next()` requests a playlist refresh on **every** advance
(`onRequestRefresh?.invoke()`,
[PlaylistController.kt:278](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L278)),
so a fresh `updatePlaylist()` can land a beat after the index was just moved to a
new item — while that item is still mid-startup.

In `updatePlaylist()`
([PlaylistController.kt:104-210](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L104-L210)):

1. If the playlist signature changed, it tries to keep the current item by
   matching `contentId` against the new list
   ([:182-183](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L182-L183)).
2. On miss, it falls back to the stable DB row id `assignmentId`
   ([:187-193](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L187-L193)).
3. If **both** miss, it treats the item as genuinely removed and force-jumps:
   `currentIndex = firstActiveIndex(); playCurrentItem()`
   ([:202-206](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L202-L206))
   — which restarts playback at the first item (the "reverting to Bata" effect).

An unstable/empty/mismatched `content_id` between two reads of the same playlist
would make step 1 (and possibly step 2) fail spuriously and trigger the force-jump.

**Log signatures (already instrumented):**

```
PlaylistController  Playlist changed: <X> -> <Y> items
PlaylistController  TEMP_DEBUG matching currentlyPlaying: contentId='...' assignmentId=... filename=... against newItems=[...]
PlaylistController  content_id match failed for <file> (had contentId='...'), recovered via assignmentId=... at index N     <- W level
PlaylistController  Current item still in playlist at index N, not interrupting
```

[:152](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L152),
[:178-180](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L178-L180),
[:190-191](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L190-L191),
[:198](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L198).

Interpretation:
- `content_id match failed ... recovered via assignmentId` then `not interrupting`
  → the fallback saved it; annoying but not the freeze.
- `TEMP_DEBUG matching currentlyPlaying` followed by **neither** a `recovered via
  assignmentId` **nor** a `not interrupting` line, then a `Playing: <first item>`
  → the genuine-removal branch fired and force-jumped to `firstActiveIndex()`.
  This path is the cause.

## Suspect path 3 — `startIfNeeded()` guard bypass

After every `updatePlaylist()`, `onPlaylistUpdate` also calls
`playlistController.startIfNeeded()`
([MainActivity.kt:243-244](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L243-L244),
also [:539](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L539)).

`startIfNeeded()` is meant to be a no-op when something valid is already playing
(`isRunning && currentIndex in 0..items.size`), otherwise it calls `start()`,
which unconditionally jumps to `firstActiveIndex()`
([PlaylistController.kt:241-260](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L241-L260),
[:226-239](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L226-L239)).

If the guard is bypassed at the wrong moment (e.g. `currentIndex` transiently
`-1`, or `isRunning` briefly false during a refresh), `start()` resets playback to
item 1 — same visible effect as path 2, different trigger.

**Log signatures (already instrumented):**

```
PlaylistController  TEMP_DEBUG startIfNeeded(): guard held, already playing <file> at index N, not restarting
PlaylistController  TEMP_DEBUG startIfNeeded(): guard bypassed (isRunning=..., currentIndex=..., items.size=...) -> calling start()
PlaylistController  TEMP_DEBUG start(): firstActiveIndex()=<idx> -> <file> (assignmentId=...)
```

[:252](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L252),
[:258](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L258),
[:237](../android/app/src/main/java/com/remotedisplay/player/player/PlaylistController.kt#L237).
`guard bypassed` appearing on a routine playlist update (when an item *was*
playing fine) is the tell for this path.

## Exact next step

Capture logs on a **USB-connected** device (wireless ADB port 5555 is closed on
the field device; USB-debugging pairing was unavailable on 2026-08-27), then
match the capture against the three signatures above **before** touching any code.

```sh
adb devices                 # confirm the device is listed
adb logcat -c               # clear the buffer
adb logcat -v time -s \
  IntroScreen:V PlaylistController:V Player:V MainActivity:V DebugLog:V ZoneManager:V \
  | tee content-stuck-$(date +%Y%m%d-%H%M%S).log
```

Tag notes:
- `Player` is the tag `DebugLog` emits under for `playItem:` and `Layout:` lines
  ([MainActivity.kt:486](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L486),
  [:691](../android/app/src/main/java/com/remotedisplay/player/MainActivity.kt#L691)).
- `ZoneManager` included to confirm the stuck case is on the single-zone path and
  not being handled behind zones.
- `DebugLog` as a literal tag is not currently used, but is harmless to include.

Then, while capturing, reproduce the stuck state on the device and check, in order:

1. Does `cancel(): cancelling a PENDING intro` appear right before the freeze,
   with no matching `onDone()` for that item? → **path 1**.
2. Does `content_id match failed` / the `assignmentId` fallback appear, and does it
   then reach the genuine-removal branch and force-jump via `firstActiveIndex()`
   (a `Playing: <first item>` with no `not interrupting`/`recovered` line)? → **path 2**.
3. Does `startIfNeeded(): guard bypassed` fire on a routine update while an item
   was playing fine, followed by `start(): firstActiveIndex()=...`? → **path 3**.

Report which signature(s) actually fired, with the real log excerpt, before
proposing a fix — more than one path may be present; fix the one that fires.
