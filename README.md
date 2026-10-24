# CRYSTAL Grinder for Decaid

[简体中文](https://github.com/Sofronio/decaid-crystal-grinder/blob/main/README.zh-CN.md) | **English**

A [Decaid](https://github.com/decentespresso/decaid) plugin that adds the
CRYSTAL grinder. The plugin owns the device protocol; Decaid owns discovery, the
BLE connection lifecycle, and the grinder surface.

No Decaid release is needed to use this, and none is needed to add support for
another device.

## Driver type

The CRYSTAL declares the `grinder` driver type. It claims `startStop`,
`grindSetting` and `rpmControl`, and publishes `state`, `setting`, `rpm`,
`observedSetting` and `observedRpm`. It needs Decaid 0.8.8 or later, the release
that introduced the grinder driver type.

The plugin id is still `crystal.reaplugin`: the repository was renamed from
`decaid-crystal` to `decaid-crystal-grinder`, but installed plugins keep their
identity and settings.

## Install

From the Decaid REST API, which installs the repository's latest release:

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "Sofronio/decaid-crystal-grinder"}'
```

Or open the Plugins settings screen in Decaid and install from the repository.

The public device ID is `plugin:crystal.reaplugin:crystal:<physical id>`. When
the plugin is loaded it takes ownership of the advertisement.

## Matching

An advertisement whose name contains `crystal` (case-insensitive), which the
device sends as `CRYSTAL-` plus the last four MAC digits (for example
`CRYSTAL-E538`). The matcher deliberately declares **no** service UUIDs: a scan
of a physical unit shows it advertises no service list at all, so a
`serviceUuids` constraint would never match.

## Protocol

Service `7fa2d10c-12f3-4b9e-9d77-1a9b65432100`. The six characteristics are the
same UUID with the final two digits replaced by the channel number:

| Channel | UUID suffix | Name | Access | Range |
| --- | --- | --- | --- | --- |
| `motorRpm` | `…01` | Motor RPM | read/write/notify | 0–1500 |
| `feedRpm` | `…02` | Feed RPM | read/write/notify | 0–150 |
| `bootSign` | `…03` | Boot sign | read/write/notify | 0–10 |
| `sysState` | `…04` | System state | read/notify | 0 idle, 1 busy |
| `servoAngle` | `…05` | Current grind size | read/notify | 0–1500 |
| `targetAngle` | `…06` | Target grind size | read/write/notify | 0–1500 |

**Every measured value is a UInt16, big-endian, exactly two bytes.** A physical
unit reading 499 returns `0x01 0xF3`; little-endian would decode that as 62209.
The protocol document is still marked `UNCONFIRMED` on encoding; big-endian is
the one measured on hardware. `sysState` is documented as one byte, and the
driver accepts either a one-byte or two-byte value so a firmware that uses the
same width as the other channels still decodes.

`bootSign` is a command rather than a measurement: `1` manual start, `2` timed
start, `3` smart start, `4` stop, `5` apply the target grind size. It reads `0`
when idle.

`sysState` is the authoritative state source. The driver subscribes to it and
uses `1 → 0` as the signal that a grind-size change has finished, never a fixed
sleep or a comparison of `servoAngle` with `targetAngle`.

## Local configuration

The device persists nothing: after every power-up all characteristics read 0.
The plugin is the authoritative configuration store, with
`motorRpm`, `feedRpm`, `grindSize` and `bootMode` (manual, timed or smart) in the
Decaid plugin settings. The settings are the defaults; changes made on the
control page are written to plugin storage and survive a reload. A change in the
Decaid settings takes precedence over the stored copy on the next load.

The device is not configured on connect and is not overwritten with its
power-up zeroes. The configuration is sent only when a grind starts:

1. `motorRpm`, `feedRpm`, and the target `grindSize` are written.
2. `bootSign = 5` applies the target; the driver waits for `SYS_STATE` to go
   `0 → 1 → 0`.
3. It waits a forced **1500 ms** from the moment `SYS_STATE` returns to 0.
4. `bootSign` is written with the configured start mode (`1`, `2` or `3`).

Stopping is always allowed: `bootSign = 4`, then wait for `SYS_STATE` to return
to 0. A grind-size change while the device is busy is rejected rather than sent.

## Snapshot and the 0 readback

The driver publishes `{state, setting, rpm, observedSetting, observedRpm}`:

| Field | Source | Mapping |
| --- | --- | --- |
| `state` | `sysState` and the last command | idle, grinding, error; an apply in progress is `unknown` |
| `setting` | `servoAngle` | the live burr position, once it is known |
| `rpm` | plugin config | the configured motor RPM |
| `observedSetting` | `servoAngle` | always published for diagnostics |
| `observedRpm` | `motorRpm` | the live motor reading |

**A power-up 0 is not the user's grind size.** The skin's Follow and `tile-sync`
write `setting` into the workflow, so publishing the device's post-power-up 0
would silently zero the profile and its override. The driver therefore omits
`setting` until the position is known: it has seen a non-zero `servoAngle`, or an
apply has completed. Only then does `tile-sync` appear. `observedSetting` still
carries the raw reading, including 0.

`rpm` is the configured speed, not the motor's momentary reading; the
observation carries the latter.

## Surfaces

The plugin answers the skin's `skin` endpoint with:

| Surface | Kind | Where | Shows |
| --- | --- | --- | --- |
| `crystal-page` | `header-button` | the dashboard header | the control page |
| `crystal-saver` | `screensaver-button` | over the screensaver | the control page |
| `crystal-state` | `tile-line` | under the Grind label | the configured RPM, or `warning`; active while grinding, and a tap opens the skin's RPM numpad |
| `crystal-step` | `tile-hint` | the Grind tile's pill | a coarse/fine `±10` / `±1` step for the grind setting |
| `crystal-sync` | `tile-sync` | the Grind tile's own value | the live burr position, once known; a changed value is written into the workflow |

The skin labels the header button, the screensaver button and the status line
`XTAL` (the crystallography abbreviation) so they fit the dashboard; the page
and the device keep the full name.
All surfaces are declared only while the CRYSTAL is connected: a disconnected
grinder leaves the skin's single header slot to the grinder that is connected,
and its page stays reachable from Decaid's device management.

The two buttons open a settings-only view in a fitted `overlay`, not as a
same-frame `page`: the window is sized to the editable cards (configuration,
start mode and Apply/Start/Stop), the read-only readout, characteristic table
and log are not drawn, and closing it returns to the dashboard as it was left,
with no navigation and no skin reload. The page posts `streamline:ready` on
load and `streamline:size` with its content size, and `streamline:close` from
its back button; the skin draws its own close button too.

A **Full / Compact** toggle in the window shows the read-only cards at the
skin's maximum overlay size; Compact returns to the fitted card. A true
edge-to-edge `size:"full"` overlay is fixed when the skin opens the page, so
Full uses the largest size an overlay may request. If a skin falls back to a
page open, or the page is opened from Decaid's device management, the back
button uses the surface protocol's `returnTo`.

The `ui` response sends `Content-Security-Policy: frame-ancestors 'self'
<Origin/Referer origin>` because a skin served from another port — the tablet's
is `:25123` — would otherwise be refused by Decaid's `X-Frame-Options:
SAMEORIGIN` on the overlay's iframe.

The skin holds the `changed` websocket open and re-reads `skin` when a value a
surface shows actually moves, at most once a second.

## Control page

The plugin serves a live control page at
`/api/v1/plugins/crystal.reaplugin/ui`:

```
GET  /api/v1/plugins/crystal.reaplugin/ui            -> the page
GET  /api/v1/plugins/crystal.reaplugin/ui?state=1    -> cached JSON state
POST /api/v1/plugins/crystal.reaplugin/ui            -> {commandId, params}
```

It shows the six live characteristics, the current position and target, the
local configuration (motor RPM, feed RPM, grind size, start mode), Apply /
Start / Stop, and a read/write/notify log. It toggles between English and
Chinese. Polling reads the cached values and never touches the device.

`?view=settings` renders the compact view the dashboard surfaces use: the
read-only readout, characteristic table and log are hidden, leaving the
configuration and Apply/Start/Stop. The Full toggle in that view shows the
read-only cards at the skin's maximum overlay size. The device-management
settings surface opens the full page.

| Command | Purpose |
| --- | --- |
| `getValues` | Return the last known values without touching the device |
| `getConfig` | Return the local configuration |
| `readAll` | Re-read every characteristic from the device |
| `setConfig` | Change local configuration only (saved, not sent) |
| `setAndApply` | Save the grind size, then apply it and wait for `SYS_STATE` |
| `start` | Send the configuration, apply the grind, wait 1500 ms, then start |
| `stop` | Send `bootSign = 4` and wait for `SYS_STATE` to return to 0 |
| `writeMotorRpm`, `writeFeedRpm`, `writeBootSign`, `writeTargetAngle` | Direct characteristic writes for diagnostics |

The grinder contract itself is exposed through `PUT /api/v1/grinder/setting`,
`PUT /api/v1/grinder/rpm`, and the grinder start/stop controls.

## Known firmware behaviour

The device broadcasts only briefly after power-on and then goes silent, and its
connection is fragile — independent probes (Chrome Web Bluetooth and Python
bleak) see it drop after one to two seconds, and a direct CoreBluetooth probe on
macOS reproduced drops between 0.45 s and 4.7 s. The same probe also held one
connection open for over 30 seconds with no other Bluetooth central active,
which suggests contention is at least part of it rather than the firmware alone.

The driver subscribes to every channel instead of polling, and reads each one
once at connect. If the link drops, Decaid's reconnect policy re-establishes it
and the driver re-subscribes and re-reads.

The physical unit reports `…05` (current grind size) as writable, while the
reference protocol notes describe it as read-only. The driver mirrors the device
and subscribes without writing it.

## Releasing

`scripts/package.sh` builds `dist/crystal.reaplugin-<version>.zip`. Pushing a
`vX.Y.Z` tag runs the same script in CI and publishes the release.

Decaid enforces three things the script keeps in sync:

- the release tag is `X.Y.Z` or `vX.Y.Z` and equals `manifest.version` exactly
- the release carries exactly one `.zip` asset
- the archive holds a single top-level `crystal.reaplugin/` directory containing
  `manifest.json` and `plugin.js`

## License

Not yet chosen. Until one is added, this repository is all rights reserved by
default.
