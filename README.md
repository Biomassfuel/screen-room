# 投屏房间

一个零依赖的 WebRTC 投屏 MVP：房主创建房间并设置密码，观众输入房间号和密码后观看房主屏幕。

## 本地运行

```bash
npm start
```

打开：

```text
http://localhost:3000
```

同一局域网其他设备访问时，把 `localhost` 换成运行服务那台机器的局域网 IP。

例如服务端机器 IP 是 `192.168.1.20`：

```text
http://192.168.1.20:3000
```

注意：局域网 IP 的 HTTP 地址可以打开页面，但浏览器通常不会允许屏幕共享。真正投屏需要 HTTPS，只有 `localhost` / `127.0.0.1` 是开发例外。

## 部署到另一台本地服务器

1. 在服务器安装 Node.js 20 或更高版本。
2. 把整个项目目录复制到服务器。
3. 在项目目录执行 `npm start`。
4. 在服务器防火墙放行 TCP `3000` 端口。
5. 局域网内其他设备访问 `http://服务器IP:3000`。

这个地址适合验证页面和房间功能。如果要点击“开始投屏”，请给服务配置 HTTPS 后访问 `https://...`。

## HTTPS 要求

浏览器的屏幕共享 API `navigator.mediaDevices.getDisplayMedia()` 只在安全上下文可用：

- `https://域名`
- `http://localhost`
- `http://127.0.0.1`

如果使用 `http://192.168.x.x:3000` 这类局域网地址，页面可能能打开，但点击“开始投屏”会失败，常见报错是：

```text
Cannot read properties of undefined (reading 'getDisplayMedia')
```

解决方式：

- 正式使用：给服务配置域名和 HTTPS，推荐用 Caddy 或 Nginx 反向代理到 `http://127.0.0.1:3000`。
- 局域网测试：可以使用自签名证书或 mkcert，但每台访问设备都需要信任证书。
- 临时调试：浏览器 flags 可以把某个 HTTP 来源临时视为安全来源，但不建议正式使用。

## TURN 配置

项目默认会给浏览器下发两个公共 STUN 服务。如果两端网络无法直连，可以配置 TURN，让 WebRTC 在直连失败时走中继。

注意：这里是“接入 TURN 使用能力”，TURN 服务器本身需要单独部署或购买第三方服务，例如 coturn。

PowerShell 示例：

```powershell
$env:TURN_URLS="turn:turn.example.com:3478,turns:turn.example.com:5349"
$env:TURN_USERNAME="screen-room"
$env:TURN_CREDENTIAL="your-turn-password"
node server.js
```

Linux/macOS 示例：

```bash
TURN_URLS="turn:turn.example.com:3478,turns:turn.example.com:5349" \
TURN_USERNAME="screen-room" \
TURN_CREDENTIAL="your-turn-password" \
node server.js
```

如果要强制所有 WebRTC 流量都走 TURN，用来验证中继是否真的可用：

```bash
ICE_TRANSPORT_POLICY=relay node server.js
```

更复杂的 ICE 配置可以用 `ICE_SERVERS_JSON`：

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
    "username": "screen-room",
    "credential": "your-turn-password"
  }
]
```

浏览器会从 `/api/config` 读取这些配置。启用 TURN 后，如果两端可以直连，视频仍会优先直连；只有直连失败或策略设为 `relay` 时才会明显消耗 TURN 服务器带宽。

## 功能

- 房主创建 6 位数字房间号
- 房间密码校验
- 观众加入/离开提示
- 浏览器屏幕共享
- WebRTC 点对点投屏
- 可配置 STUN/TURN 中继
- 本地预览和观看端播放器

## 开发版说明

- 房间数据保存在 Node 进程内存中，重启服务会清空。
- 屏幕捕获 API 在正式部署时需要 HTTPS，`localhost` 开发环境可直接使用。
- 跨复杂网络访问时建议配置 TURN 服务，否则部分网络环境可能无法建立 WebRTC 连接；TURN 会消耗中继服务器带宽。
- 后续正式化事项见 `TODO.md`。
