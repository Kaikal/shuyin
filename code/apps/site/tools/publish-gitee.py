#!/usr/bin/env python3
"""把 dist/release/ 里的安装包发到 Gitee Releases（官网下载源）。

为什么不用 Gitee 的 raw 地址：raw 匿名下载有大小上限，实测 4.8MB 的 IPA 能下、
10.3MB 的 dmg 直接 403。Releases 附件没有这个问题，而且路径和 GitHub 同构：
    https://gitee.com/<owner>/<repo>/releases/download/<tag>/<file>

用法（在仓库根目录）：
    python code/apps/site/tools/publish-gitee.py            # 上传缺的
    python code/apps/site/tools/publish-gitee.py --dry-run  # 只看要传什么

token 来源：优先环境变量 GITEE_TOKEN，否则从 git 凭据管理器取（git credential fill）。
需要该仓库的写权限。

按文件名里的版本号自动分组：shuyin-android-0.6.111.apk → tag v0.6.111，
shuyin-windows-0.5.25.exe → tag v0.5.25。同一个 tag 下的包共用一个 Release，
不会因为「桌面三件套版本号相同」而互相覆盖。
"""
from __future__ import annotations

import json
import os
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

OWNER = "ghpgitee"
REPO = "shuyin-update"
COMMITISH = "master"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "../../../.."))
REL_DIR = os.path.join(ROOT, "dist", "release")

# shuyin-android-0.6.111.apk / shuyin-macos-0.5.25.dmg / shuyin-windows-0.5.25.exe
NAME_RE = re.compile(r"^shuyin-[a-z]+-(\d+\.\d+\.\d+)\.(apk|exe|ipa|dmg)$")

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE


def get_token() -> str:
    tok = os.environ.get("GITEE_TOKEN", "").strip()
    if tok:
        return tok
    out = subprocess.run(
        ["git", "credential", "fill"],
        input=b"protocol=https\nhost=gitee.com\n\n",
        capture_output=True,
    ).stdout.decode("utf-8", "replace")
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1].strip()
    sys.exit("✗ 取不到 Gitee 凭据：设 GITEE_TOKEN 环境变量，或先 git login gitee.com")


def api(tok: str, path: str, method: str = "GET", payload=None):
    url = f"https://gitee.com/api/v5{path}"
    data = None
    headers = {"Authorization": f"token {tok}"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json;charset=UTF-8"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        body = r.read().decode("utf-8", "replace")
        return json.loads(body or "{}")


def upload(tok: str, release_id: int, path: str):
    fname = os.path.basename(path)
    boundary = "----shuyin" + uuid.uuid4().hex
    with open(path, "rb") as f:
        blob = f.read()
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    body = head + blob + f"\r\n--{boundary}--\r\n".encode()

    # 附件端点只认 query 里的 access_token，Authorization 头不保证生效
    url = (
        f"https://gitee.com/api/v5/repos/{OWNER}/{REPO}/releases/{release_id}/attach_files"
        f"?access_token={urllib.parse.quote(tok)}"
    )
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, context=ctx, timeout=900) as r:
        return json.loads(r.read().decode("utf-8", "replace") or "{}")


def main() -> None:
    dry = "--dry-run" in sys.argv
    if not os.path.isdir(REL_DIR):
        sys.exit(f"✗ 找不到 {REL_DIR}，先跑 node code/apps/site/build-site.mjs")

    groups: dict[str, list[str]] = {}
    for name in sorted(os.listdir(REL_DIR)):
        m = NAME_RE.match(name)
        if not m:
            continue
        groups.setdefault(m.group(1), []).append(os.path.join(REL_DIR, name))

    if not groups:
        sys.exit(f"✗ {REL_DIR} 里没有可发布的包（名字要形如 shuyin-android-1.2.3.apk）")

    print("待发布：")
    for ver, files in groups.items():
        print(f"  v{ver}")
        for f in files:
            print(f"    {os.path.basename(f)}  {os.path.getsize(f)/1048576:.1f}MB")

    if dry:
        print("\n--dry-run：什么都没传")
        return

    tok = get_token()
    existing = {r["tag_name"]: r for r in api(tok, f"/repos/{OWNER}/{REPO}/releases")}
    failed = 0

    for ver, files in groups.items():
        tag = f"v{ver}"
        rel = existing.get(tag)
        if not rel:
            rel = api(tok, f"/repos/{OWNER}/{REPO}/releases", "POST", {
                "tag_name": tag,
                "name": f"疏音 {ver} 安装包",
                "body": f"疏音 {tag} 安装包（官网直链）",
                "target_commitish": COMMITISH,
            })
            print(f"+ release {tag} id={rel['id']}")
            time.sleep(1)

        have = {a.get("name") for a in (rel.get("assets") or []) if isinstance(a, dict)}
        for path in files:
            fn = os.path.basename(path)
            if fn in have:
                print(f"  = {fn} 已存在，跳过")
                continue
            t0 = time.time()
            try:
                a = upload(tok, rel["id"], path)
                print(f"  ✓ {fn} {os.path.getsize(path)/1048576:.1f}MB {time.time()-t0:.0f}s")
                print(f"    {a.get('browser_download_url')}")
            except urllib.error.HTTPError as e:
                failed += 1
                print(f"  ✗ {fn} HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}")
            except Exception as e:  # 连接被重置在 Gitee 上偶发，重跑一次就好
                failed += 1
                print(f"  ✗ {fn} {type(e).__name__}: {e}")

    print("\n完成" + (f"，{failed} 个失败（重跑本脚本只会补传缺的）" if failed else ""))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
