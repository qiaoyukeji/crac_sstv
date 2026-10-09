# 在手机 / 平板上使用麦克风（SSTV RX 实时采集）

> **一句话结论**：手机浏览器里点「开始录音」失败，几乎都不是浏览器不行，而是**页面地址不是「安全上下文」**。`web/serve.py` 已经内置了一套完整的本地 HTTPS 方案，装一次根证书即可永久解决，全程离线。

---

## 1. 为什么会失败

Web 规范规定：`navigator.mediaDevices.getUserMedia()` **只在安全上下文（secure context）下被暴露**。安全上下文的判据是：

| 地址形态 | 是否安全上下文 | 麦克风 |
|---------|:---:|:---:|
| `https://…`（证书受信任） | ✅ | ✅ |
| `http://localhost` / `http://127.0.0.1` | ✅（回环地址被特殊豁免） | ✅ |
| `http://<局域网IP>:8000` | ❌ | ❌ |
| `file:///…/index.html` | ❌ | ❌ |

所以当手机访问 `http://192.168.3.185:8000` 时，**`navigator.mediaDevices` 是 `undefined`** —— 代码里那句"浏览器不支持麦克风采集"就是这么来的，但它把真实原因说错了。

好消息是：**这不是手机的毛病，装一张本地证书就能彻底解决。**

---

## 2. 五种方案对比

| 方案 | 适用场景 | 需要装证书 | 能否用麦克风 | 推荐度 |
|------|---------|:---:|:---:|:---:|
| **A. 本地可信 HTTPS** | 同一局域网（Android + iOS + 桌面） | ✅ 一次 | ✅ | ⭐⭐⭐⭐⭐ |
| **D. cloudflared 隧道** | **不在同一网段 / 外网远程访问** | ❌ 免装 | ✅ | ⭐⭐⭐⭐⭐ |
| **B. Chrome 非安全来源白名单** | 仅 Android Chrome / 桌面 Chrome | ❌ | ✅ | ⭐⭐⭐ |
| **C. 系统录音机录制后导入** | 全平台 | ❌ | ➖ 间接实现 | ⭐⭐⭐⭐（兜底） |
| **E. WorkBuddy「发布为应用」** | 只读浏览 / 长期分享 | ❌ | ✅（发布后是 HTTPS） | ⭐⭐⭐ |

> **怎么选**：在同一个 WiFi 下 → 用 **A**；人在外面、和电脑不在一个网段 → 用 **D**（见下一节，一条命令搞定，还免装证书）。

---

## 3. 方案 D：cloudflared 隧道（跨网段 / 远程访问）

**场景**：你人在外面，笔记本在家里/公司，两者不在同一网段，局域网 IP 根本连不上。

**原理**：`cloudflared` 在你的电脑和 Cloudflare 边缘之间建一条出站隧道，Cloudflare 分配一个**公网 HTTPS 域名**指回你本机的服务。因为出口是**出站连接**，所以**不需要公网 IP、不需要在路由器上做端口映射、也不受运营商 NAT 限制**。

**额外好处**：域名自带**受信任的 TLS 证书**，`https://` 天然就是安全上下文 —— **手机麦克风直接可用，无需安装任何根证书**（对比方案 A 要装证书，这里省掉了）。

### 3.1 一条命令启动

```bash
bash web/tools/tunnel.sh
```

脚本会自动：确保本地 8000 服务在跑 → 建立隧道 → 打印公网地址。

### 3.2 手动启动（等价命令）

```bash
# 注意两点：origin 用 127.0.0.1；用 --config 指定独立配置
/d/ruanjian/unzip/cloudflared/cloudflared tunnel \
  --config web/tools/cloudflared-sstv.yml \
  --url http://127.0.0.1:8000 \
  --protocol http2
```

输出里会出现一行 `https://<随机词>-<随机词>.trycloudflare.com`，在手机或任何电脑上打开即可。

### 3.3 两个必须避开的坑

这两个都是实际排查出来的，不是理论问题：

| 现象 | 真实原因 | 解决 |
|------|---------|------|
| 公网返回 **HTTP 530**，页面提示错误码 **1033**（Argo Tunnel error） | origin 写了 `localhost`。cloudflared 会把 `localhost` 优先解析为 **IPv6 `::1`**，而 `python -m http.server --bind 0.0.0.0` **只监听 IPv4**，回源连接被拒 | origin 一律写 **`127.0.0.1`** |
| 公网返回 **HTTP 404**（`bytes=0`，且 cloudflared 日志里**没有任何回源记录**） | cloudflared 默认加载 `~/.cloudflared/config.yml`，那份配置属于**别的项目**，其 `ingress` 兜底规则是 `http_status:404`，把本隧道的请求全挡了 | 加 **`--config web/tools/cloudflared-sstv.yml`** 指定独立配置，不继承无关 ingress |

> 判断技巧：**530/1033 = 连不上回源**（网络层）；**404 = 连上了但路由规则不匹配**（配置层）。看 cloudflared 日志有没有回源记录，能一眼区分。

### 3.4 想要固定域名（可选）

快速隧道的域名是随机且临时的，进程重启就换。你已登录 Cloudflare 账号（`~/.cloudflared/cert.pem` 是一枚有效的 Argo Tunnel Token），可以建命名隧道拿到**固定域名**：

```bash
CF=/d/ruanjian/unzip/cloudflared/cloudflared
$CF tunnel create sstv-studio                       # 生成隧道 UUID + 凭据 json
$CF tunnel route dns sstv-studio sstv.qiaoyukeji.com # 自动加一条 CNAME
```

然后把 `web/tools/cloudflared-sstv.yml` 末尾注释掉的 `tunnel` / `credentials-file` / `ingress` 三段取消注释并填入 UUID 与主机名，之后用：

```bash
bash web/tools/tunnel.sh --named
```

> ⚠️ 这一步会**在你的 Cloudflare DNS 里新增一条记录**（`sstv.qiaoyukeji.com`），需要你确认后再做。
>
> 顺带一提：你 `~/.cloudflared/config.yml` 里现有那条隧道（`11305018-…`，指向 `love_timeline.qiaoyukeji.com → localhost:3000`）**凭据文件已丢失**，现在跑不起来。要么重建凭据，要么把它从 `config.yml` 里删掉。

### 3.5 安全提醒

隧道开启期间，**任何拿到这个网址的人都能打开你的应用**（用的是 Cloudflare 的公共域名，没有身份校验）。缓解办法：

- 用完就 Ctrl+C 关掉隧道（本项目是一次性调试，不是常驻服务）
- 需要长期开放时，在 Cloudflare Zero Trust 里给该域名加 **Access 策略**（邮箱验证 / OTP）
- 本应用本身不采集、不上传任何数据，风险面仅限于「别人能看到这个工具界面」

---

## 4. 方案 A：本地可信 HTTPS（推荐）

### 3.1 启动服务

在项目根目录执行一条命令，HTTP 与 HTTPS 会同时启动，证书缺失时自动生成：

```bash
python web/serve.py
```

输出形如：

```
  ① 本机（可用麦克风，推荐日常使用）
     https://localhost:8443

  ② 手机 / 平板（装好根证书后用这个，可用麦克风）
     https://192.168.3.185:8443

  ③ 首次安装根证书用（HTTP，麦克风不可用）
     Android : http://192.168.3.185:8000/sstv-ca.crt
     iOS     : http://192.168.3.185:8000/sstv-ca.mobileconfig
```

常用参数：

```bash
python web/serve.py --https-port 9443   # 换端口
python web/serve.py --no-http           # 只起 HTTPS
python web/serve.py --regen             # 强制重新生成证书（换网络/换 IP 后用）
```

> 用项目根目录的 `python` 启动即可；本机若没有 `cryptography` 库，`gen_cert.py` 会自动回退到 `openssl` 命令行（Git for Windows 自带）。

### 3.2 Android 安装根证书

1. 用手机浏览器（Chrome）打开：`http://<本机IP>:8000/sstv-ca.crt`
2. 系统会提示安装证书，按照引导走：
   **设置 → 安全 → 更多安全设置 → 加密与凭据 → 从存储设备安装 → CA 证书**
3. 选择刚下载的 `sstv-ca.crt`，系统会弹出"您的数据不会被监控"的警告 —— 这是系统对**所有**用户证书的通用提示，确认继续。
4. 用 `https://<本机IP>:8443` 打开应用。

> ⚠️ 两个前提：
> 1. Android 要求**先设置锁屏密码/PIN** 才允许安装 CA 证书。
> 2. 各厂商菜单路径略有不同（小米：设置 → 密码与安全 → 系统安全 → 加密与凭据；华为：设置 → 安全 → 更多安全设置 → 加密和凭据），但关键词都是「**凭据 / CA 证书 / 从存储设备安装**」。
>
> Chrome 会信任用户安装的 CA，因此装完即可访问 HTTPS。若个别机型/版本仍然报"您的连接不是私密连接"，直接用**方案 B** 更省事。

### 3.3 iOS 安装根证书（关键在第 4 步）

1. 用 **Safari** 打开：`http://<本机IP>:8000/sstv-ca.mobileconfig`
   （必须是 Safari，Chrome for iOS 无法安装描述文件）
2. 提示"此网站正尝试下载一个配置描述文件" → **允许**
3. **安装描述文件**：设置 → 通用 → VPN与设备管理 → 已下载的描述文件 → 点右上角「安装」→ 输入锁屏密码 → 再次「安装」
4. **开启完全信任**（⚠️ 最容易漏掉的一步）：
   **设置 → 通用 → 关于本机 → 证书信任设置 → 找到「SSTV Studio Local Root CA」→ 打开开关**
5. 回到 Safari，用 `https://<本机IP>:8443` 打开应用。

> 只做第 3 步不做第 4 步的话，Safari 依然认为证书不可信 → 依然不是安全上下文 → 麦克风依然被拦。**第 4 步是成败关键。**
>
> 另外 iOS Safari 要求麦克风请求由**用户手势**触发，本项目已把请求绑在「开始录音」按钮的点击上，符合要求。

### 3.4 Windows / macOS 本机

桌面端其实不需要折腾证书 —— 直接用 `http://localhost:8000` 就已经是安全上下文，麦克风可用。

若想用 `https://localhost:8443` 且不要浏览器警告，把 `certs/ca.crt` 导入系统信任根：

- **Windows**：双击 `certs/ca.crt` → 安装证书 → 本地计算机 → 将所有的证书都放入下列存储 → **受信任的根证书颁发机构**
- **macOS**：双击导入"钥匙串访问"→ 系统钥匙串 → 找到该证书 → 显示简介 → 信任 → 始终信任

> 在 Windows 上用 `curl` 或部分客户端测试时，若报 `schannel: the revocation status is unknown`，那是 Windows 对私有 CA 无法查 CRL 导致的**吊销检查**告警，证书链本身是正常的（`openssl s_client` 会返回 `Verify return code: 0 (ok)`）。浏览器不受影响。

### 3.5 怎么确认成功了

最简单的方法是**看应用自己**：切到 RX → 麦克风，如果顶部的黄色诊断框消失了、「开始录音」按钮可点，就说明环境正常。

也可以在浏览器里进一步确认：

- 地址栏没有"不安全"标记，是 `https://`
- 打开控制台执行 `window.isSecureContext` → 应返回 `true`
- 执行 `typeof navigator.mediaDevices` → 应是 `object`（不是 `undefined`）

### 3.6 注意事项

- **换了网络（IP 变了）后 HTTPS 打不开**：证书的 SAN 里写死了 IP。重新生成即可：
  ```bash
  python web/tools/gen_cert.py --force
  ```
  然后重启 `serve.py`。手机上可能需要重新安装一次证书。
- **服务器证书有效期 820 天**，到期重新生成即可。这是刻意的：iOS 13+ 硬性拒绝有效期超过 825 天的服务器证书。

---

## 5. 方案 B：Android Chrome / 桌面 Chrome 免证书白名单

不想装证书时，可以让 Chrome 把某个 `http://` 来源**当作**安全来源：

1. Chrome 地址栏输入 `chrome://flags`
2. 搜索 `unsafely-treat-insecure-origin-as-secure`
3. 在输入框中填入完整来源，例如 `http://192.168.3.185:8000`
4. 右侧下拉改为 **Enabled**
5. **完全退出并重启 Chrome**（不是只关标签页）

之后访问 `http://192.168.3.185:8000`，`isSecureContext` 会变成 `true`，麦克风可用。

> 限制：只在配置过的那台设备、那个浏览器、那个来源上生效；Edge / 其他浏览器有同名设置项。iOS Safari **没有**这个开关，iPhone 只能走方案 A 或 C。

---

## 6. 方案 C：系统录音机 + 文件导入（永远可用的兜底）

完全绕开浏览器麦克风限制：

1. 用手机自带的「录音机」App 录下电台的 SSTV 音频（对准扬声器，或直接从电台音频输出）
2. 把录音文件传到手机浏览器能访问的位置
3. 回到应用 → RX → **文件** → 选择该音频 → 解码 → 导出 PNG

这条路径在 `file://`、`http://`、`https://` 下**都**可用，不依赖任何权限。缺点是只能离线回放，不能实时看画面一行行长出来。

---

## 7. 故障排查

| 现象 | 根本原因 | 处理 |
|------|---------|------|
| 麦克风面板提示「非安全上下文…」 | 用的是 `http://` + 局域网 IP | 换 `https://<IP>:8443` 并装根证书（方案 A） |
| HTTPS 打开显示"您的连接不是私密连接" | 证书没装，或未被信任 | Android 重装 CA；iOS 检查"证书信任设置"是否开启 |
| iOS 装了描述文件仍然警告 | 漏了"开启完全信任" | 设置 → 通用 → 关于本机 → 证书信任设置 |
| 点开始录音提示「权限被拒绝」 | 之前误点了「阻止」 | 地址栏站点设置里改回"允许"并刷新；iOS 另需 设置 → Safari → 麦克风 → 允许 |
| 提示「麦克风被其它程序占用」 | 被其它 App / 标签页独占 | 关闭其它录音应用、结束通话后重试 |
| 提示「未检测到可用的麦克风设备」 | 系统未报告输入设备 | 检查系统声音设置是否禁用了输入设备 |
| 换网络后 `https://` 打不开 | 证书 SAN 不含新 IP | `python web/tools/gen_cert.py --force` 重新生成 |
| 手机根本连不上本机 | AP 客户端隔离 / 不同 SSID / 防火墙 | 见 `README.md` §4.1 的排查清单 |
| 本机 `curl` 测试报吊销状态未知 | Windows 无法为私有 CA 查 CRL | 无害；加 `--ssl-revoke-best-effort`，或用浏览器验证 |

---

## 8. 安全说明

- 证书材料位于项目根的 `certs/` 目录，**已加入 `.gitignore`，不会进入版本库**。
- `certs/ca.key` 是这个本地 CA 的私钥。它只在本机存在，**不要外传**。若怀疑泄露，应从所有设备删除该证书、删除 `certs/` 后重新生成。
- 这套证书**只用于局域网内本机服务的 HTTPS**，与任何外部 CA 无关，也不需要联网校验。
- 卸载方式：
  - **Android**：设置 → 安全 → 加密与凭据 → 受信任的凭据 → 用户 → 选择该证书 → 删除
  - **iOS**：设置 → 通用 → VPN与设备管理 → 删除"SSTV Studio 本地 HTTPS"描述文件

---

## 9. 文件清单

| 文件 | 作用 |
|------|------|
| `web/serve.py` | HTTP(8000) + HTTPS(8443) 静态服务，证书缺失时自动生成；提供 `/sstv-ca.crt`、`/sstv-ca.der`、`/sstv-ca.mobileconfig` 三条证书下载路由 |
| `web/tools/gen_cert.py` | 生成本地 CA 与服务器证书；SAN 自动覆盖本机全部内网 IP；优先用 `cryptography`，缺失时回退 `openssl` |
| `certs/ca.crt` | 根证书（PEM）—— Android 装这个 |
| `certs/ca.der` | 根证书（DER）——部分 Android 版本只认这个 |
| `certs/sstv-ca.mobileconfig` | iOS 配置描述文件，Safari 点开即装 |
| `certs/server.crt` / `server.key` | 服务器证书与私钥（820 天有效期） |
| `certs/ca.key` | 根证书私钥，**仅本机，勿外传** |
| `web/tools/tunnel.sh` | 跨网段公网访问一键脚本：确保本地服务在跑 → 建 cloudflared 隧道 → 打印公网地址；已固化「origin 用 127.0.0.1」「--config 独立配置」两个坑 |
| `web/tools/cloudflared-sstv.yml` | 隧道的独立配置，避免加载 `~/.cloudflared/config.yml`（属于其他项目，会带来 404） |
| `web/test/e2e_remote_securectx.cjs` | 用真实浏览器验证「该地址是否为安全上下文、麦克风能否调用」，可对任意 URL 跑 |

### 重新生成

```bash
# 用带 cryptography 的解释器（推荐）
python web/tools/gen_cert.py --force

# 指定输出目录 / CN
python web/tools/gen_cert.py --out D:\certs --cn sstv.local --force
```
