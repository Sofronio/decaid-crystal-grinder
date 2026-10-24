import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:reaprime/src/plugins/plugin_manifest.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';

import 'plugin_ble_fixture.dart';

const crystalPluginPath = 'examples/plugins/crystal.reaplugin';
const crystalServiceUuid = '7fa2d10c-12f3-4b9e-9d77-1a9b65432100';

/// The six characteristics are the service UUID with its last two digits
/// replaced by the channel number.
const crystalChannelUuids = <String, String>{
  'motorRpm': '7fa2d10c-12f3-4b9e-9d77-1a9b65432101',
  'feedRpm': '7fa2d10c-12f3-4b9e-9d77-1a9b65432102',
  'bootSign': '7fa2d10c-12f3-4b9e-9d77-1a9b65432103',
  'sysState': '7fa2d10c-12f3-4b9e-9d77-1a9b65432104',
  'servoAngle': '7fa2d10c-12f3-4b9e-9d77-1a9b65432105',
  'targetAngle': '7fa2d10c-12f3-4b9e-9d77-1a9b65432106',
};

const crystalChannelOrder = [
  'motorRpm',
  'feedRpm',
  'bootSign',
  'sysState',
  'servoAngle',
  'targetAngle',
];

PluginManifest crystalManifest() => PluginManifest.fromJson(
  jsonDecode(File('$crystalPluginPath/manifest.json').readAsStringSync()),
);

Future<void> loadCrystalPlugin(
  PluginManager manager, {
  Map<String, dynamic> settings = const {},
}) => manager.loadPlugin(
  id: crystalManifest().id,
  manifest: crystalManifest(),
  settings: settings,
  jsCode: File('$crystalPluginPath/plugin.js').readAsStringSync(),
);

/// Every measured CRYSTAL value is a UInt16, big-endian, exactly two bytes. The
/// physical unit reads 499 as `0x01 0xF3`; little-endian would decode it as
/// 62209. SYS_STATE is documented as one byte, and the plugin accepts both.
List<int> crystalBytes(int value) => [(value >> 8) & 0xFF, value & 0xFF];

List<int> crystalChannelBytes(String key, int value) =>
    key == 'sysState' ? [value & 0xFF] : crystalBytes(value);

class CrystalPluginTransport extends PluginBleFixtureTransport {
  CrystalPluginTransport(super.physicalId, {Map<String, int>? initial})
    : deviceValues = {
        for (final key in crystalChannelOrder)
          crystalChannelUuids[key]!: initial?[key] ?? 0,
      };

  /// What the fake device would return from a read, keyed by characteristic.
  final Map<String, int> deviceValues;

  final subscribed = Completer<void>();
  final subscribedChannels = <String>[];
  int discoverServicesCalls = 0;

  @override
  Future<List<String>> discoverServices() async {
    discoverServicesCalls++;
    return [crystalServiceUuid];
  }

  @override
  Future<Uint8List> read(
    String serviceUUID,
    String characteristicUUID, {
    Duration? timeout,
  }) async {
    if (serviceUUID != crystalServiceUuid) {
      throw StateError('Unexpected CRYSTAL service $serviceUUID');
    }
    final value = deviceValues[characteristicUUID];
    if (value == null) {
      throw StateError('Unexpected CRYSTAL read $characteristicUUID');
    }
    final key = crystalChannelUuids.entries
        .firstWhere((entry) => entry.value == characteristicUUID)
        .key;
    return Uint8List.fromList(crystalChannelBytes(key, value));
  }

  @override
  Future<void> subscribe(
    String service,
    String characteristic,
    void Function(Uint8List) callback,
  ) async {
    if (service != crystalServiceUuid) {
      throw StateError('Unexpected CRYSTAL subscription $service');
    }
    if (!crystalChannelUuids.containsValue(characteristic)) {
      throw StateError('Unexpected CRYSTAL characteristic $characteristic');
    }
    subscribers[characteristic] = callback;
    subscribedChannels.add(characteristic);
    if (subscribedChannels.length == crystalChannelUuids.length &&
        !subscribed.isCompleted) {
      subscribed.complete();
    }
  }

  @override
  Future<void> write(
    String serviceUUID,
    String characteristicUUID,
    Uint8List data, {
    bool withResponse = true,
    Duration? timeout,
  }) async {
    if (serviceUUID != crystalServiceUuid) {
      throw StateError('Unexpected CRYSTAL write $serviceUUID');
    }
    if (!crystalChannelUuids.containsValue(characteristicUUID)) {
      throw StateError('Unexpected CRYSTAL write $characteristicUUID');
    }
    if (characteristicUUID == crystalChannelUuids['sysState']) {
      throw StateError('SYS_STATE is read-only');
    }
    if (data.length != 2) {
      throw StateError(
        'CRYSTAL writes are exactly two bytes, got ${data.length}',
      );
    }
    // A write lands in the device's value, which a later read would observe.
    deviceValues[characteristicUUID] = (data[0] << 8) | data[1];
    await super.write(
      serviceUUID,
      characteristicUUID,
      data,
      withResponse: withResponse,
      timeout: timeout,
    );
  }

  /// Pushes a notification for a channel, as the firmware does on change.
  void notify(String key, int value) {
    final uuid = crystalChannelUuids[key]!;
    deviceValues[uuid] = value;
    final callback = subscribers[uuid];
    if (callback == null) {
      throw StateError('CRYSTAL channel $key is not subscribed');
    }
    callback(Uint8List.fromList(crystalChannelBytes(key, value)));
  }

  /// The bytes written to a channel, in order.
  List<List<int>> writesTo(String key) {
    final uuid = crystalChannelUuids[key]!;
    return writes
        .where((write) => write.characteristicUUID == uuid)
        .map((write) => write.data.toList())
        .toList();
  }
}
