import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:reaprime/src/models/device/grinder_device.dart';
import 'package:reaprime/src/plugins/plugin_ble_registry.dart';
import 'package:reaprime/src/plugins/plugin_grinder.dart';
import 'package:reaprime/src/plugins/plugin_manager.dart';
import 'package:reaprime/src/plugins/plugin_manifest.dart';

import '../helpers/crystal_plugin_fixture.dart';
import 'plugin_test_helpers.dart';

BleAdvertisementEvidence crystalEvidence() =>
    BleAdvertisementEvidence(name: 'CRYSTAL-E538');

Future<PluginGrinder> createCrystalGrinder(
  PluginManager manager,
  CrystalPluginTransport transport, {
  BleAdvertisementEvidence? evidence,
}) async {
  final resolved = evidence ?? crystalEvidence();
  return await manager.bleService.createCandidate(
        driver: manager.bleService.registry.decide(resolved).drivers.single,
        physicalId: 'AA:BB',
        evidence: resolved,
        admit: () => true,
        createTransport: () => transport,
      )
      as PluginGrinder;
}

Future<PluginGrinder> connectCrystal(
  PluginManager manager,
  CrystalPluginTransport transport,
) async {
  final grinder = await createCrystalGrinder(manager, transport);
  await grinder.onConnect();
  return grinder;
}

Future<Map<String, dynamic>> pluginHttp(
  PluginManager manager, {
  String endpoint = 'ui',
  String method = 'GET',
  Map<String, String> query = const {},
  Map<String, String> headers = const {},
  Object? body,
}) async {
  final requestId = 'req-${DateTime.now().microsecondsSinceEpoch}';
  final response = manager.registerPendingHttp(crystalManifest().id, requestId);
  manager.dispatchEvent(crystalManifest().id, 'httpRequest', {
    'requestId': requestId,
    'endpoint': endpoint,
    'method': method,
    'headers': headers,
    'body': body,
    'query': query,
  });
  return response;
}

Future<List<Map<String, dynamic>>> skinSurfaces(PluginManager manager) async {
  final response = await pluginHttp(manager, endpoint: 'skin');
  expect(response['status'], 200);
  final answer = jsonDecode(response['body'] as String) as Map<String, dynamic>;
  expect(answer['version'], 1);
  return (answer['surfaces'] as List)
      .cast<Map<String, dynamic>>()
      .toList(growable: false);
}

Map<String, dynamic> surfaceOf(
  List<Map<String, dynamic>> surfaces,
  String kind,
) => surfaces.singleWhere((surface) => surface['kind'] == kind);

Future<void> waitForWrite(
  CrystalPluginTransport transport,
  String key,
  int count,
) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (transport.writesTo(key).length < count) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('timed out waiting for $count writes to $key');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  test('CRYSTAL manifest declares a grinder with its controls and surfaces', () {
    final driver = crystalManifest().drivers.single;
    expect(driver.id, 'crystal');
    expect(driver.type, PluginDriverType.grinder);
    expect(driver.grinderCapabilities, {
      PluginGrinderCapability.startStop,
      PluginGrinderCapability.grindSetting,
      PluginGrinderCapability.rpmControl,
    });
    expect(driver.grinderObservations, {
      GrinderObservation.setting,
      GrinderObservation.rpm,
    });
    expect(driver.controls['grindSetting']!.min, 0);
    expect(driver.controls['grindSetting']!.max, 1500);
    expect(driver.controls['rpmControl']!.min, 0);
    expect(driver.controls['rpmControl']!.max, 1500);
    expect(driver.surfaces.single.role, 'settings');
    expect(driver.surfaces.single.endpoint, 'ui');
    // The device advertises no service UUIDs, so a serviceUuids constraint
    // would never match.
    expect(driver.ble!.serviceUuids, isNull);
    expect(driver.ble!.nameValue, 'crystal');
  });

  test('CRYSTAL advertisement without the name is not claimed', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final decision = manager.bleService.registry.decide(
      BleAdvertisementEvidence(name: 'ACME GRINDER'),
    );
    expect(decision.drivers, isEmpty);
  });

  test(
    'CRYSTAL connect subscribes every channel and reads their values',
    () async {
      final manager = PluginManager(kvStore: FakeKeyValueStoreService());
      addTearDown(manager.dispose);
      await loadCrystalPlugin(manager);
      final transport = CrystalPluginTransport(
        'AA:BB',
        initial: {'servoAngle': 499},
      );
      final grinder = await connectCrystal(manager, transport);
      expect(transport.discoverServicesCalls, 1);
      expect(transport.subscribedChannels, hasLength(6));
      final snapshot = await grinder.currentSnapshot.first;
      expect(snapshot.state, GrinderState.idle);
      expect(snapshot.setting, '499');
      expect(snapshot.observedSetting, '499');
      expect(snapshot.rpm, 850);
      await grinder.disconnect();
    },
  );

  test('CRYSTAL decodes values as big-endian UInt16', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    // 499 on the wire is 0x01 0xF3; little-endian would give 62209.
    expect(crystalBytes(499), [0x01, 0xF3]);
    final transport = CrystalPluginTransport(
      'AA:BB',
      initial: {'servoAngle': 499},
    );
    final grinder = await connectCrystal(manager, transport);
    expect((await grinder.currentSnapshot.first).observedSetting, '499');
    await grinder.disconnect();
  });

  test('CRYSTAL keeps a power-up 0 out of the synced setting', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final transport = CrystalPluginTransport('AA:BB');
    final grinder = await connectCrystal(manager, transport);
    final fresh = await grinder.currentSnapshot.first;
    expect(fresh.setting, isNull);
    expect(fresh.observedSetting, '0');
    var surfaces = await skinSurfaces(manager);
    expect(
      surfaces.where((surface) => surface['kind'] == 'tile-sync'),
      isEmpty,
    );

    transport.notify('servoAngle', 499);
    await Future<void>.delayed(const Duration(milliseconds: 80));
    final moved = await grinder.currentSnapshot.first;
    expect(moved.setting, '499');
    surfaces = await skinSurfaces(manager);
    expect(surfaceOf(surfaces, 'tile-sync')['value'], 499);
    await grinder.disconnect();
  });

  test('CRYSTAL writes motor RPM as two big-endian bytes', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final transport = CrystalPluginTransport('AA:BB');
    final grinder = await connectCrystal(manager, transport);
    await grinder.setRpm(1000);
    expect(transport.writesTo('motorRpm'), isEmpty);
    expect((await grinder.currentSnapshot.first).rpm, 1000);
    await grinder.disconnect();
  });

  test('CRYSTAL setGrindSetting applies the target and waits for SYS_STATE', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final transport = CrystalPluginTransport('AA:BB');
    final grinder = await connectCrystal(manager, transport);
    final pending = grinder.setGrindSetting('650');
    await waitForWrite(transport, 'targetAngle', 1);
    await waitForWrite(transport, 'bootSign', 1);
    transport.notify('sysState', 1);
    transport.notify('servoAngle', 650);
    transport.notify('sysState', 0);
    await pending;
    expect(transport.writesTo('targetAngle'), [
      [0x02, 0x8A],
    ]);
    expect(transport.writesTo('bootSign'), [
      [0x00, 0x05],
    ]);
    final snapshot = await grinder.currentSnapshot.first;
    expect(snapshot.setting, '650');
    expect(snapshot.state, GrinderState.idle);
    await grinder.disconnect();
  });

  test('CRYSTAL start sends the config, waits 1500 ms and starts', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(
      manager,
      settings: {
        'motorRpm': 900,
        'feedRpm': 25,
        'grindSize': 650,
        'bootMode': 'smart',
      },
    );
    final transport = CrystalPluginTransport('AA:BB');
    final grinder = await connectCrystal(manager, transport);
    final pending = grinder.start();
    await waitForWrite(transport, 'bootSign', 1);
    transport.notify('sysState', 1);
    transport.notify('servoAngle', 650);
    transport.notify('sysState', 0);
    await waitForWrite(transport, 'bootSign', 2);
    await pending;
    expect(transport.writesTo('motorRpm'), [
      [0x03, 0x84],
    ]);
    expect(transport.writesTo('feedRpm'), [
      [0x00, 0x19],
    ]);
    expect(transport.writesTo('targetAngle'), [
      [0x02, 0x8A],
    ]);
    expect(transport.writesTo('bootSign'), [
      [0x00, 0x05],
      [0x00, 0x03],
    ]);

    transport.notify('sysState', 1);
    await Future<void>.delayed(const Duration(milliseconds: 80));
    expect((await grinder.currentSnapshot.first).state, GrinderState.grinding);
    final stopping = grinder.stop();
    await waitForWrite(transport, 'bootSign', 3);
    transport.notify('sysState', 0);
    await stopping;
    expect((await grinder.currentSnapshot.first).state, GrinderState.idle);
    await grinder.disconnect();
  });

  test('CRYSTAL HTTP handler serves the control page with framing headers', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final response = await pluginHttp(manager);
    expect(response['status'], 200);
    expect(response['headers']['Content-Type'], contains('text/html'));
    expect(
      response['headers']['Content-Security-Policy'],
      "frame-ancestors 'self'",
    );
    final page = response['body'] as String;
    expect(page, contains('id="config-card"'));
    expect(page, contains('id="table"'));
    expect(page, contains('class="send"'));
    expect(page, contains('class="app"'));
    expect(page, contains('id="back"'));
    expect(page, contains('id="expand"'));
    expect(page, contains('setExpanded'));
    expect(page, contains('streamline:ready'));
    expect(page, contains('streamline:close'));
    expect(page, contains('streamline:size'));
    expect(page, contains('returnTo'));
  });

  test('CRYSTAL HTTP state reports values and config without writes', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final transport = CrystalPluginTransport(
      'AA:BB',
      initial: {'servoAngle': 500},
    );
    final grinder = await connectCrystal(manager, transport);
    transport.writes.clear();
    final response = await pluginHttp(manager, query: const {'state': '1'});
    final state =
        jsonDecode(response['body'] as String) as Map<String, dynamic>;
    expect(state['connected'], isTrue);
    expect((state['values'] as Map)['servoAngle'], 500);
    expect((state['config'] as Map)['motorRpm'], 850);
    expect(state['setting'], '500');
    expect(transport.writes, isEmpty);
    await grinder.disconnect();
  });

  test('CRYSTAL HTTP POST setConfig changes the grinder config', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final transport = CrystalPluginTransport('AA:BB');
    final grinder = await connectCrystal(manager, transport);
    final response = await pluginHttp(
      manager,
      method: 'POST',
      body: const {
        'commandId': 'setConfig',
        'params': {'motorRpm': 1000, 'bootMode': 'manual'},
      },
    );
    final payload =
        jsonDecode(response['body'] as String) as Map<String, dynamic>;
    expect(payload['ok'], isTrue);
    expect(payload['result']['motorRpm'], 1000);
    expect(payload['result']['bootMode'], 'manual');
    expect((await grinder.currentSnapshot.first).rpm, 1000);
    await grinder.disconnect();
  });

  test('CRYSTAL skin opens an overlay and syncs the live grind size', () async {
    final manager = PluginManager(kvStore: FakeKeyValueStoreService());
    addTearDown(manager.dispose);
    await loadCrystalPlugin(manager);
    final idle = await skinSurfaces(manager);
    // A disconnected grinder leaves the skin's single header slot to the
    // grinder that is connected.
    expect(idle, isEmpty);
    final transport = CrystalPluginTransport(
      'AA:BB',
      initial: {'servoAngle': 650},
    );
    final grinder = await connectCrystal(manager, transport);
    final surfaces = await skinSurfaces(manager);
    final pageAction = {
      'type': 'open',
      'view': 'settings',
      'presentation': 'overlay',
      'fit': true,
    };
    expect(surfaceOf(surfaces, 'header-button')['label'], 'XTAL');
    expect(surfaceOf(surfaces, 'header-button')['action'], pageAction);
    expect(surfaceOf(surfaces, 'screensaver-button')['label'], 'XTAL');
    expect(surfaceOf(surfaces, 'screensaver-button')['action'], pageAction);
    expect(surfaceOf(surfaces, 'tile-line')['text'], 'XTAL · 850 rpm');
    expect(surfaceOf(surfaces, 'tile-hint')['action'], {
      'type': 'stepsize',
      'field': 'grinderSetting',
      'sizes': [10, 1],
    });
    expect(surfaceOf(surfaces, 'tile-sync')['value'], 650);
    expect(surfaceOf(surfaces, 'tile-sync')['label'], 'XTAL');
    await grinder.disconnect();
  });
}
