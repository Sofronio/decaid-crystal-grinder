# Tests

These tests live here because the driver owns its protocol coverage, but they
**cannot run standalone**: they exercise the plugin through Decaid's shared
plugin harness, not a copy of it.

The imports resolve against a Decaid checkout, not this repository:

- `../helpers/plugin_ble_fixture.dart` — the fake BLE transport and platform
- `plugin_test_helpers.dart` — `FakeKeyValueStoreService` and manifest helpers

Both belong to Decaid's test tree because other plugin tests use them too, and
duplicating them here would drift.

## Running

From a Decaid checkout, overlay this directory onto its `test/` tree and run
the suite there:

```bash
cp -r test/helpers/crystal_plugin_fixture.dart <decaid>/test/helpers/
cp -r test/plugins/crystal_plugin_test.dart    <decaid>/test/plugins/
cd <decaid> && flutter test test/plugins/crystal_plugin_test.dart
```

The plugin source is read from `examples/plugins/crystal.reaplugin/` by
relative path, so the copy must sit beside that directory. Keep the two in sync
when either changes — `scripts/package.sh` in this repository builds the
released archive from `crystal.reaplugin/`, and the Decaid copy is what the
tests load.

## What the fixture covers

`crystal_plugin_fixture.dart` models the device as six independent
characteristics with no framing or checksum layer. The measured channels carry a
UInt16 big-endian, so the documented `0x01 0xF3` for 499 is what the tests
assert — a switch to little-endian would decode that as 62209 and fail here
rather than only against hardware. `SYS_STATE` is one byte in the fixture, which
exercises the driver's tolerance for both widths. Writes land in the device's
value the way a later read would observe them, and `notify` pushes a change the
way the firmware does.

The tests also cover the grinder contract: the snapshot and 0-readback guard,
the `SYS_STATE` 0→1→0 sequence around an apply, the forced 1500 ms wait before
start, the local configuration, the surfaces, and the overlay/CSP page headers.
