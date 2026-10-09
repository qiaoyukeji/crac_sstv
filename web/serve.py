#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
serve.py — SSTV Studio 本地服务器（同时提供 HTTP 与 HTTPS）。

为什么要有 HTTPS 版本
---------------------
浏览器只在「安全上下文」下暴露 getUserMedia。判据是：
  * https:// 且证书被信任，或
  * http://localhost / http://127.0.0.1（回环地址被特殊豁免）
而 http://<局域网IP> 不在豁免之列 —— 所以手机通过局域网打开时，
navigator.mediaDevices 直接是 undefined，麦克风必然失败。

本脚本同时起两个监听：
  * HTTPS :8443   —— 手机装上根证书后访问它，即可解锁麦克风
  * HTTP  :8000   —— 用于首次下载根证书；也方便纯文件解码（不需要麦克风）时随手用

只用标准库（http.server + ssl），任何 Python 3.8+ 都能直接跑。

用法
----
    python web/serve.py                     # https:8443 + http:8000
    python web/serve.py --https-port 9443
    python web/serve.py --no-http           # 只起 HTTPS
    python web/serve.py --regen             # 强制重新生成证书
"""

from __future__ import annotations

import argparse
import http.server
import os
import socket
import socketserver
import ssl
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.abspath(os.path.join(HERE, os.pardir))
CERT_DIR = os.path.join(PROJECT, "certs")
GEN_CERT = os.path.join(HERE, "tools", "gen_cert.py")


def out(*a):
    print(*a, flush=True)


def local_ipv4() -> list[str]:
    ips: set[str] = set()
    for probe in ("8.8.8.8", "1.1.1.1"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.connect((probe, 53))
                ips.add(s.getsockname()[0])
            finally:
                s.close()
        except OSError:
            pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    ips.discard("0.0.0.0")
    return sorted(ip for ip in ips if not ip.startswith("127."))


# --------------------------------------------------------------- HTTP handler --


class SSTVHandler(http.server.SimpleHTTPRequestHandler):
    """静态文件服务 + 根证书下载路由。"""

    # 由 main() 注入
    cert_dir: str = CERT_DIR

    # ---- 证书下载：让手机一键安装，避免手工拷文件 ----

    def _serve_file(self, path: str, ctype: str, download_name: str | None = None) -> None:
        if not os.path.isfile(path):
            self.send_error(404, "certificate not generated yet")
            return
        with open(path, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if download_name:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % download_name)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        route = self.path.split("?", 1)[0]
        if route in ("/sstv-ca.crt", "/ca.crt"):
            return self._serve_file(
                os.path.join(self.cert_dir, "ca.crt"),
                "application/x-x509-ca-cert", "sstv-ca.crt")
        if route in ("/sstv-ca.der", "/ca.der"):
            return self._serve_file(
                os.path.join(self.cert_dir, "ca.der"),
                "application/x-x509-ca-cert", "sstv-ca.der")
        if route in ("/sstv-ca.mobileconfig",):
            return self._serve_file(
                os.path.join(self.cert_dir, "sstv-ca.mobileconfig"),
                "application/x-apple-aspen-config", "sstv-ca.mobileconfig")
        return super().do_GET()

    # ---- 开发期禁用缓存，避免改了文件浏览器还吃旧的 ----

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # 默认日志太吵；只保留非 200 的，方便排查
        try:
            status = str(args[1]) if len(args) > 1 else ""
        except Exception:
            status = ""
        if status and not status.startswith("2"):
            sys.stderr.write("  ! %s %s\n" % (self.address_string(), fmt % args))


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def make_server(port: int, handler_cls, bind: str) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((bind, port), handler_cls)


# ------------------------------------------------------------------ cert prep --


def ensure_certs(regen: bool) -> bool:
    crt = os.path.join(CERT_DIR, "server.crt")
    key = os.path.join(CERT_DIR, "server.key")
    if regen or not (os.path.isfile(crt) and os.path.isfile(key)):
        out("证书不存在或要求重新生成，正在调用 gen_cert.py …")
        r = subprocess.run([sys.executable, GEN_CERT, "--out", CERT_DIR] +
                           (["--force"] if regen else []))
        if r.returncode != 0:
            return False
    return os.path.isfile(crt) and os.path.isfile(key)


# ----------------------------------------------------------------------- main --


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="SSTV Studio 本地服务器（HTTP + HTTPS）")
    ap.add_argument("--bind", default="0.0.0.0", help="监听地址（默认 0.0.0.0，即所有网卡）")
    ap.add_argument("--https-port", type=int, default=8443)
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--no-http", action="store_true", help="只启动 HTTPS")
    ap.add_argument("--regen", action="store_true", help="强制重新生成证书")
    args = ap.parse_args()

    handler = lambda *a, **kw: SSTVHandler(*a, directory=HERE, **kw)  # noqa: E731
    SSTVHandler.cert_dir = CERT_DIR

    ips = local_ipv4()
    servers = []

    # ---------------- HTTPS ----------------
    if not ensure_certs(args.regen):
        out("")
        out("⚠ 证书准备失败，本次仅启动 HTTP（手机端将无法使用麦克风）。")
        out("  可手动执行：python \"%s\"" % GEN_CERT)
    else:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(os.path.join(CERT_DIR, "server.crt"),
                            os.path.join(CERT_DIR, "server.key"))
        try:
            ctx.set_ciphers("ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:!aNULL:!MD5")
        except ssl.SSLError:
            pass
        try:
            https_srv = make_server(args.https_port, handler, args.bind)
            https_srv.socket = ctx.wrap_socket(https_srv.socket, server_side=True)
            servers.append(("https", https_srv))
        except OSError as e:
            out("⚠ 无法在 %s:%d 启动 HTTPS：%s" % (args.bind, args.https_port, e))

    # ---------------- HTTP ----------------
    if not args.no_http:
        try:
            servers.append(("http", make_server(args.http_port, handler, args.bind)))
        except OSError as e:
            out("⚠ 无法在 %s:%d 启动 HTTP：%s" % (args.bind, args.http_port, e))

    if not servers:
        out("没有任何监听成功，退出。")
        return 1

    # ---------------- 启动 ----------------
    threads = []
    for _, srv in servers:
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        threads.append(t)

    line = "─" * 64
    out(line)
    out("  SSTV Studio 已启动（本地离线，无任何外部请求）")
    out(line)

    https_srv = next((s for k, s in servers if k == "https"), None)
    http_srv = next((s for k, s in servers if k == "http"), None)

    if https_srv:
        out("")
        out("  ① 本机（可用麦克风，推荐日常使用）")
        out("     https://localhost:%d" % args.https_port)
        if not http_srv:
            out("     http://localhost:%d" % args.https_port)
        out("")
        out("  ② 手机 / 平板（装好根证书后用这个，可用麦克风）")
        for ip in ips:
            out("     https://%s:%d" % (ip, args.https_port))
        if not ips:
            out("     （未探测到内网 IPv4，请确认已连上 Wi-Fi）")

    if http_srv:
        out("")
        out("  ③ 首次安装根证书用（HTTP，麦克风不可用）")
        if ips:
            first = ips[0]
            out("     Android : http://%s:%d/sstv-ca.crt" % (first, args.http_port))
            out("     iOS     : http://%s:%d/sstv-ca.mobileconfig" % (first, args.http_port))
        else:
            out("     http://<本机IP>:%d/sstv-ca.crt" % args.http_port)
        out("")
        out("  ④ 无需麦克风的场景（仅文件解码/编码）")
        for ip in ips:
            out("     http://%s:%d" % (ip, args.http_port))

    out("")
    out(line)
    if https_srv:
        out("  证书安装提示")
        out(line)
        out("  Android：浏览器打开上面的 .crt 链接 → 系统会引导安装")
        out("           设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书")
        out("  iOS    ：Safari 打开 .mobileconfig → 允许下载描述文件")
        out("           设置 → 通用 → VPN与设备管理 → 安装该描述文件")
        out("           设置 → 通用 → 关于本机 → 证书信任设置 → 打开该证书的完全信任")
        out("")
        out("  装完证书请务必访问 https:// 地址；用 http:// 打开时页面顶部")
        out("  会明确提示「非安全上下文」，麦克风按钮会被禁用。")
    out(line)
    out("  Ctrl+C 结束服务")
    out(line)

    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        out("\n正在停止…")
        for _, srv in servers:
            srv.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
