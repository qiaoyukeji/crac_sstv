#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_cert.py — 为 SSTV Studio 生成本地自签证书（CA + 服务器证书）。

为什么需要它
------------
浏览器只在「安全上下文」下暴露 getUserMedia。http:// + 局域网 IP 不是安全上下文，
所以手机通过局域网访问时无法使用麦克风。解决方式之一就是让本机以 https 提供服务，
并让手机信任这张自签证书 —— 全程不联网、不依赖任何外部 CA。

产物（默认写入 <项目>/certs/）
------------------------------
  ca.crt            根证书 PEM    —— 安装到手机（Android 用这个）
  ca.der            根证书 DER    —— 部分 Android 版本只认 .crt/.der
  ca.key            根证书私钥    —— 留在这台机器上，切勿外传
  server.crt        服务器证书 PEM（SAN 覆盖本机所有内网 IP）
  server.key        服务器私钥
  sstv-ca.mobileconfig   iOS 配置描述文件（Safari 点开即可安装根证书）

兼容性要点（踩过的坑，都已在代码里规避）
----------------------------------------
* iOS 13+ 拒绝有效期超过 825 天的服务器证书 -> 这里签 820 天。
* iOS 13+ 要求服务器证书必须带 SAN，且签名算法为 SHA-256 -> 已满足。
* iOS 要求 EKU 含 serverAuth；浏览器校验主机名，所以 SAN 必须包含访问时用的 IP。
* Android 7+ 不再信任用户安装的 CA 给"应用"，但 Chrome 浏览器本身会信任 -> 够用。

用法
----
    python gen_cert.py                 # 生成到 <项目>/certs/
    python gen_cert.py --force         # 覆盖已有证书
    python gen_cert.py --out D:\\x      # 指定输出目录
"""

from __future__ import annotations

import argparse
import base64
import datetime
import ipaddress
import os
import socket
import sys
import uuid

# --------------------------------------------------------------------- utils --


def out(*a):
    print(*a, flush=True)


def project_root() -> str:
    """gen_cert.py 位于 <项目>/web/tools/ 下，往上三层即项目根。"""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, os.pardir, os.pardir))


def local_ipv4() -> list[str]:
    """枚举本机所有非回环 IPv4 地址（不联网，纯本地探测）。"""
    ips: set[str] = set()
    # 1) 默认路由出口地址：连一个不存在的地址来让内核挑出主网卡（UDP 不会真的发包）
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
    # 2) 主机名解析出的地址
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    ips.discard("0.0.0.0")
    return sorted(ip for ip in ips if not ip.startswith("127."))


def build_mobileconfig(ca_der: bytes, common_name: str) -> str:
    """生成 iOS 配置描述文件（内嵌根证书的 DER base64）。"""
    b64 = base64.b64encode(ca_der).decode("ascii")
    # 每 68 字符换行，符合 plist <data> 的习惯写法
    b64_wrapped = "\n".join(b64[i:i + 68] for i in range(0, len(b64), 68))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>ca.crt</string>
      <key>PayloadContent</key>
      <data>
{b64_wrapped}
      </data>
      <key>PayloadDescription</key>
      <string>信任 SSTV Studio 的本地 HTTPS 证书，仅用于局域网内访问。</string>
      <key>PayloadDisplayName</key>
      <string>SSTV Studio 本地根证书</string>
      <key>PayloadIdentifier</key>
      <string>local.sstvstudio.ca.{uuid.uuid4()}</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>{uuid.uuid4()}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>SSTV Studio 本地根证书（用于在手机上启用麦克风录音）</string>
  <key>PayloadDisplayName</key>
  <string>SSTV Studio 本地 HTTPS</string>
  <key>PayloadIdentifier</key>
  <string>local.sstvstudio.profile.{uuid.uuid4()}</string>
  <key>PayloadOrganization</key>
  <string>SSTV Studio</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>{uuid.uuid4()}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
"""


# ------------------------------------------------------- 主路径：cryptography --


def gen_with_cryptography(outdir: str, common_name: str, ips: list[str], days_server: int) -> None:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)

    # ---- 根证书（CA）----
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    ca_name = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SSTV Studio Local CA"),
        x509.NameAttribute(NameOID.COMMON_NAME, "SSTV Studio Local Root CA"),
    ])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=False,
                key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )

    # ---- 服务器证书 ----
    srv_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    san: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.DNSName(socket.gethostname()),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        x509.IPAddress(ipaddress.ip_address("::1")),
    ]
    for ip in ips:
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            san.append(x509.DNSName(ip))

    srv_cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([
            x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SSTV Studio"),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ]))
        .issuer_name(ca_name)
        .public_key(srv_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=days_server))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=False,
                key_encipherment=True, data_encipherment=False,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )

    def write(path: str, data: bytes) -> None:
        with open(path, "wb") as fh:
            fh.write(data)
        out("  ✓ %s (%d bytes)" % (os.path.basename(path), len(data)))

    write(os.path.join(outdir, "ca.key"), ca_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    ca_pem = ca_cert.public_bytes(serialization.Encoding.PEM)
    write(os.path.join(outdir, "ca.crt"), ca_pem)
    write(os.path.join(outdir, "ca.der"), ca_cert.public_bytes(serialization.Encoding.DER))
    write(os.path.join(outdir, "server.key"), srv_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    write(os.path.join(outdir, "server.crt"), srv_cert.public_bytes(serialization.Encoding.PEM))
    write(os.path.join(outdir, "sstv-ca.mobileconfig"),
          build_mobileconfig(ca_cert.public_bytes(serialization.Encoding.DER), common_name).encode("utf-8"))


# ------------------------------------------------------ 兜底路径：openssl CLI --


def find_openssl() -> str | None:
    import shutil
    found = shutil.which("openssl")
    if found:
        return found
    for cand in (
        r"C:\Program Files\Git\usr\bin\openssl.exe",
        r"C:\Program Files\Git\mingw64\bin\openssl.exe",
        r"C:\Program Files (x86)\Git\usr\bin\openssl.exe",
        "/usr/bin/openssl",
        "/usr/local/bin/openssl",
    ):
        if os.path.isfile(cand):
            return cand
    return None


def gen_with_openssl(outdir: str, common_name: str, ips: list[str], days_server: int) -> None:
    import subprocess
    import tempfile

    ossl = find_openssl()
    if not ossl:
        raise SystemExit(
            "找不到 openssl，也没有可用的 cryptography 库。\n"
            "请任选其一：\n"
            "  a) 用带 cryptography 的解释器运行：\n"
            "     <venv>/Scripts/python.exe gen_cert.py\n"
            "  b) 安装 Git for Windows（自带 openssl）后重试。"
        )

    san_parts = ["DNS:localhost", "DNS:%s" % socket.gethostname(), "IP:127.0.0.1", "IP:::1"]
    san_parts += ["IP:%s" % ip for ip in ips]
    san = ",".join(san_parts)

    with tempfile.TemporaryDirectory() as tmp:
        cnf = os.path.join(tmp, "openssl.cnf")
        with open(cnf, "w", encoding="utf-8") as fh:
            fh.write(
                "[req]\ndistinguished_name=dn\nx509_extensions=v3_ca\nprompt=no\n"
                "\n[dn]\nCN=SSTV Studio Local Root CA\nO=SSTV Studio Local CA\nC=CN\n"
                "\n[v3_ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\n"
                "keyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n"
                "\n[v3_srv]\nbasicConstraints=critical,CA:FALSE\n"
                "keyUsage=critical,digitalSignature,keyEncipherment\n"
                "extendedKeyUsage=serverAuth\nsubjectAltName=%s\n" % san
            )

        def run(*args):
            r = subprocess.run([ossl] + list(args), capture_output=True,
                               text=True, cwd=outdir)
            if r.returncode != 0:
                raise SystemExit("openssl 调用失败:\n%s\n%s" % (" ".join(args), r.stderr))

        ca_key = os.path.join(outdir, "ca.key")
        ca_crt = os.path.join(outdir, "ca.crt")
        srv_key = os.path.join(outdir, "server.key")
        srv_csr = os.path.join(tmp, "server.csr")
        srv_crt = os.path.join(outdir, "server.crt")

        run("genrsa", "-out", ca_key, "3072")
        run("req", "-x509", "-new", "-key", ca_key, "-sha256",
            "-days", "3650", "-out", ca_crt, "-config", cnf)
        run("genrsa", "-out", srv_key, "2048")
        run("req", "-new", "-key", srv_key, "-out", srv_csr, "-config", cnf,
            "-subj", "/C=CN/O=SSTV Studio/CN=%s" % common_name)
        run("x509", "-req", "-in", srv_csr, "-CA", ca_crt, "-CAkey", ca_key,
            "-CAcreateserial", "-out", srv_crt, "-days", str(days_server),
            "-sha256", "-extfile", cnf, "-extensions", "v3_srv")
        run("x509", "-in", ca_crt, "-outform", "DER", "-out", os.path.join(outdir, "ca.der"))

    # mobileconfig 需要 DER，用标准库再生成一次
    with open(os.path.join(outdir, "ca.der"), "rb") as fh:
        der = fh.read()
    with open(os.path.join(outdir, "sstv-ca.mobileconfig"), "w", encoding="utf-8") as fh:
        fh.write(build_mobileconfig(der, common_name))
    out("  ✓ sstv-ca.mobileconfig (openssl 路径生成)")


# ---------------------------------------------------------------------- main --


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="为 SSTV Studio 生成本地自签证书")
    ap.add_argument("--out", default=os.path.join(project_root(), "certs"),
                    help="输出目录（默认 <项目>/certs）")
    ap.add_argument("--cn", default=None, help="服务器证书 CN（默认取主机名）")
    ap.add_argument("--server-days", type=int, default=820,
                    help="服务器证书有效期天数（iOS 上限 825，默认 820）")
    ap.add_argument("--force", action="store_true", help="已存在时覆盖")
    args = ap.parse_args()

    cn = args.cn or socket.gethostname()
    outdir = os.path.abspath(args.out)
    os.makedirs(outdir, exist_ok=True)

    existing = os.path.join(outdir, "server.crt")
    if os.path.isfile(existing) and not args.force:
        out("证书已存在：%s" % existing)
        out("如需重新生成，请加 --force。")
        return 0

    if args.server_days > 825:
        out("提示：服务器证书有效期已限制为 825 天（iOS 13+ 的硬性上限）。")
        args.server_days = 825

    ips = local_ipv4()
    out("正在生成本地 CA 与服务器证书…")
    out("  输出目录 : %s" % outdir)
    out("  证书 CN  : %s" % cn)
    out("  纳入 SAN : localhost, %s, 127.0.0.1, ::1" % socket.gethostname())
    for ip in ips:
        out("             %s" % ip)
    if not ips:
        out("  ⚠ 未探测到内网 IPv4 地址，手机将无法通过局域网访问（请检查网络连接）")
    out("")

    try:
        gen_with_cryptography(outdir, cn, ips, args.server_days)
        out("\n使用 cryptography 库生成完成。")
    except ImportError:
        out("未安装 cryptography，改用 openssl 命令行…")
        gen_with_openssl(outdir, cn, ips, args.server_days)
        out("\n使用 openssl 生成完成。")

    out("")
    out("下一步：")
    out("  1) 启动服务：python web/serve.py")
    out("  2) 手机安装根证书：")
    out("     Android -> 浏览器打开 http://<本机IP>:8000/sstv-ca.crt")
    out("     iOS     -> 浏览器打开 http://<本机IP>:8000/sstv-ca.mobileconfig")
    out("                再在「设置 → 通用 → 关于本机 → 证书信任设置」中开启完全信任")
    out("  3) 用 https://<本机IP>:8443 打开应用，即可使用麦克风")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
