# CRYSTAL 磨豆机 Decaid 插件

**简体中文** | [English](https://github.com/Sofronio/decaid-crystal-grinder/blob/main/README.md)

一个 [Decaid](https://github.com/decentespresso/decaid) 插件，添加 CRYSTAL
磨豆机。插件拥有设备协议；Decaid 负责设备发现、BLE 连接生命周期和 grinder
surface。

无需 Decaid 发版即可使用；添加其他设备也不需要 Decaid 发版。

## 驱动类型

CRYSTAL 声明 `grinder` 驱动类型。能力为 `startStop`、`grindSetting` 和
`rpmControl`，发布 `state`、`setting`、`rpm`、`observedSetting` 和
`observedRpm`。需要 Decaid 0.8.8 或更高版本，即引入 grinder 驱动类型的那一版。

插件 id 仍是 `crystal.reaplugin`：仓库已从 `decaid-crystal` 重命名为
`decaid-crystal-grinder`，但已安装插件的身份和设置不变。

## 安装

通过 Decaid REST API 安装仓库的最新 release：

```bash
curl -X POST http://localhost:8080/api/v1/plugins/install/github-release \
  -H 'content-type: application/json' \
  -d '{"repo": "Sofronio/decaid-crystal-grinder"}'
```

也可以在 Decaid 的 Plugins 设置页从仓库安装。

公共设备 ID 是 `plugin:crystal.reaplugin:crystal:<physical id>`。插件加载后会
接管该广播。

## 匹配

广播名包含 `crystal`（大小写不敏感），设备发送 `CRYSTAL-` 加 MAC 地址后四位
（例如 `CRYSTAL-E538`）。匹配器刻意声明 **没有** service UUIDs：实机扫描显示
设备的广播里完全没有 service 列表，所以 `serviceUuids` 约束永远不会匹配。

## 协议

服务 `7fa2d10c-12f3-4b9e-9d77-1a9b65432100`。六个特征是同一 UUID 把最后两位
换成通道号：

| 通道 | UUID 后缀 | 名称 | 访问 | 范围 |
| --- | --- | --- | --- | --- |
| `motorRpm` | `…01` | 电机转速 | 读/写/通知 | 0–1500 |
| `feedRpm` | `…02` | 下豆转速 | 读/写/通知 | 0–150 |
| `bootSign` | `…03` | 启动项 | 读/写/通知 | 0–10 |
| `sysState` | `…04` | 系统状态 | 读/通知 | 0 空闲，1 忙碌 |
| `servoAngle` | `…05` | 当前研磨度 | 读/通知 | 0–1500 |
| `targetAngle` | `…06` | 目标研磨度 | 读/写/通知 | 0–1500 |

**所有测量值都是 UInt16、大端、正好两个字节。** 实机读 499 返回
`0x01 0xF3`；按小端会解成 62209。协议文档仍把编码标为 `UNCONFIRMED`；大端是
硬件实测到的。`sysState` 在文档里写成一字节，驱动同时接受一字节和两字节，这样
固件即使和其他通道一样用两字节也能解。

`bootSign` 是命令而不是测量值：`1` 手动启动，`2` 定时启动，`3` 智能启动，`4`
停止，`5` 应用目标研磨度。空闲时读到 `0`。

`sysState` 是权威状态源。驱动订阅它，并用 `1 → 0` 作为研磨度调节完成的信号，
从不使用固定 sleep，也不比较 `servoAngle` 与 `targetAngle`。

## 本地配置

设备不持久化任何东西：每次上电后所有特征都读到 0。插件是权威配置存储，
`motorRpm`、`feedRpm`、`grindSize` 和 `bootMode`（manual、timed 或 smart）放在
Decaid 插件设置里。设置是默认值；控制页上的修改会写入插件存储并在重载后保留。
下次加载时，Decaid 设置里的改动优先于存储副本。

连接时不下发配置，也不会用上电的 0 覆盖它。配置只在开始研磨时发送：

1. 写入 `motorRpm`、`feedRpm` 和目标 `grindSize`。
2. 写 `bootSign = 5` 应用目标；驱动等待 `SYS_STATE` 走 `0 → 1 → 0`。
3. 从 `SYS_STATE` 回到 0 的那一刻起，强制等待 **1500 ms**。
4. 按配置的启动方式写入 `bootSign`（`1`、`2` 或 `3`）。

停止始终允许：写 `bootSign = 4`，然后等待 `SYS_STATE` 回到 0。设备忙碌时会拒绝
研磨度修改，而不是照发。

## 快照与 0 回读

驱动发布 `{state, setting, rpm, observedSetting, observedRpm}`：

| 字段 | 来源 | 映射 |
| --- | --- | --- |
| `state` | `sysState` 和最后一条命令 | idle、grinding、error；apply 进行中为 `unknown` |
| `setting` | `servoAngle` | 已知后的实时刀盘位置 |
| `rpm` | 插件配置 | 配置的电机转速 |
| `observedSetting` | `servoAngle` | 总是发布，用于诊断 |
| `observedRpm` | `motorRpm` | 实时的电机读数 |

**上电时的 0 不是用户的研磨度。** 皮肤的 Follow 和 `tile-sync` 会把 `setting`
写入 workflow，所以发布设备上电后的 0 会悄悄把 profile 和 override 清零。因此
驱动在位置已知前不发布 `setting`：要么看到过非 0 的 `servoAngle`，要么完成过一次
apply。只有这时才会出现 `tile-sync`。`observedSetting` 仍然带着原始读数，包括 0。

`rpm` 是配置速度，不是电机瞬时读数；后者由 observation 携带。

## 皮肤 Surface

插件用 `skin` endpoint 回答：

| Surface | 类型 | 位置 | 显示 |
| --- | --- | --- | --- |
| `crystal-page` | `header-button` | dashboard 顶部 | 控制页 |
| `crystal-saver` | `screensaver-button` | 屏保上方 | 控制页 |
| `crystal-state` | `tile-line` | Grind 标签下方 | 配置的 RPM 或 `warning`；研磨中高亮，点击打开皮肤的 RPM 数字键盘 |
| `crystal-step` | `tile-hint` | Grind tile 的 pill | 研磨度的粗/细 `±10` / `±1` 步进 |
| `crystal-sync` | `tile-sync` | Grind tile 自己的数值 | 已知后的实时刀盘位置；值变化时写回 workflow |

皮肤把 header 按钮、屏保按钮和状态行标成 **XTAL**（晶体学的常用缩写），以便放进
dashboard；页面和设备仍保留全名。所有 surface 只在 CRYSTAL 已连接时声明：断开的
磨豆机把皮肤唯一的 header 槽让给已连接的磨豆机，其页面仍可从 Decaid 设备管理打开。

两个按钮以 fitted `overlay` 打开 settings-only 视图，而不是同 frame 的 `page`：
窗口按可编辑卡片（配置（每行带发送按钮）、启动方式和 Start/Stop）调整大小，特征表
和日志不绘制；关闭后回到原样的 dashboard，不跳转也不重载皮肤。页面在加载时发
`streamline:ready`，用 `streamline:size` 上报内容尺寸，返回按钮发
`streamline:close`；皮肤自己也会画关闭按钮。

窗口里的 **Full / Compact** 切换会在皮肤允许的最大 overlay 尺寸下显示特征表和日志；
Compact 回到 fitted 卡片。真正的边到边 `size:"full"` overlay 在皮肤打开页面时就
固定了，所以 Full 使用 overlay 能请求的最大尺寸。如果皮肤退回成 page，或者页面从
Decaid 设备管理打开，返回按钮会使用 surface 协议的 `returnTo`。

`ui` 响应会发送 `Content-Security-Policy: frame-ancestors 'self'
<Origin/Referer origin>`，因为皮肤可能跑在另一个端口（平板上是 `:25123`），否则
overlay 的 iframe 会被 Decaid 的 `X-Frame-Options: SAMEORIGIN` 拒绝。

皮肤保持 `changed` websocket，并在 surface 显示的值真正变化时重新读取 `skin`，
每秒最多一次。

## 控制页

插件在 `/api/v1/plugins/crystal.reaplugin/ui` 提供实时控制页：

```
GET  /api/v1/plugins/crystal.reaplugin/ui            -> 页面
GET  /api/v1/plugins/crystal.reaplugin/ui?state=1    -> 缓存的 JSON 状态
POST /api/v1/plugins/crystal.reaplugin/ui            -> {commandId, params}
```

页面显示本地配置（研磨度在最前，然后是电机转速、下豆转速，每行带发送按钮）、
六个实时特征、Start / Stop 和读/写/通知日志。配置、特征和日志三列排列。它支持
中英文切换。轮询只读缓存值，不访问设备。

`?view=settings` 渲染 dashboard surface 使用的紧凑视图：特征表和日志隐藏，
只留配置（每行带发送按钮）和 Start/Stop。该视图里的 Full 切换会在皮肤允许的最大
overlay 尺寸下显示特征表和日志。设备管理里的 settings surface 打开完整页面。

| 命令 | 用途 |
| --- | --- |
| `getValues` | 返回最后已知值，不访问设备 |
| `getConfig` | 返回本地配置 |
| `readAll` | 重新读取设备的每个特征 |
| `setConfig` | 只改本地配置（保存，不下发） |
| `setAndApply` | 设置研磨度，写目标并应用，等待 `SYS_STATE` |
| `start` | 下发配置、应用研磨度、等待 1500 ms，然后启动 |
| `stop` | 写 `bootSign = 4` 并等待 `SYS_STATE` 回到 0 |
| `writeMotorRpm`、`writeFeedRpm`、`writeBootSign`、`writeTargetAngle` | 直接特征写入（每行的发送按钮使用） |

grinder 契约本身通过 `PUT /api/v1/grinder/setting`、`PUT /api/v1/grinder/rpm` 和
grinder 的 start/stop 控件暴露。

## 已知固件行为

设备上电后只短暂广播，然后安静下来，连接也不稳定——独立探测（Chrome Web
Bluetooth 和 Python bleak）看到它在一两秒后断开，macOS 上直接的 CoreBluetooth
探测也复现了 0.45 秒到 4.7 秒之间的断开。同一个探测在没有任何其他 Bluetooth
central 活跃时还保持过一条连接超过 30 秒，这说明至少有一部分原因是争用，而不只是
固件。

驱动订阅每个通道而不是轮询，并在连接时把每个通道读一次。如果链路断开，Decaid 的
重连策略会重新建立连接，驱动会重新订阅并重新读取。

实机把 `…05`（当前研磨度）报告为可写，而参考协议文档说它是只读。驱动跟随设备，
只订阅它而不写入。

## 发布

`scripts/package.sh` 生成 `dist/crystal.reaplugin-<version>.zip`。推送 `vX.Y.Z`
tag 会在 CI 里运行同一个脚本并发布 release。

Decaid 强制要求脚本保持同步的三件事：

- release tag 是 `X.Y.Z` 或 `vX.Y.Z`，且与 `manifest.version` 完全一致
- release 恰好带一个 `.zip` 资产
- 压缩包只有一个顶层 `crystal.reaplugin/` 目录，里面有 `manifest.json` 和
  `plugin.js`

## 许可证

尚未选择。在添加之前，本仓库默认保留所有权利。
