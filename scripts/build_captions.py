#!/usr/bin/env python3
"""给 NAS 上的用户素材目录生成 captions.json（纯标准库）。

用法：
    python build_captions.py /mnt/user/appdata/ai-pose-gallery-zh/userdata

行为：
  - 扫描目录及 images/ 子目录里的图片
  - 若已有 captions.json，保留已有文字，只补新图片的空条目
  - 若图片旁有同名 .txt，自动填入作为文字
  - 输出 captions.json，可直接编辑其中的文字
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'}


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    root = Path(sys.argv[1])
    if not root.is_dir():
        print(f'目录不存在: {root}')
        return 1

    cap_file = root / 'captions.json'
    captions: dict[str, str] = {}
    if cap_file.is_file():
        try:
            loaded = json.loads(cap_file.read_text(encoding='utf-8'))
            if isinstance(loaded, dict):
                captions = {str(k): str(v) for k, v in loaded.items()}
        except Exception as e:
            print(f'已有 captions.json 解析失败，将重建: {e}')

    found = []
    for base in (root, root / 'images'):
        if not base.is_dir():
            continue
        for p in base.iterdir():
            if p.is_file() and p.suffix.lower() in EXTS:
                found.append(p)

    for p in sorted(found, key=lambda x: x.name):
        if captions.get(p.name):
            continue
        txt = p.with_suffix('.txt')
        captions[p.name] = txt.read_text(encoding='utf-8').strip() if txt.is_file() else ''

    cap_file.write_text(
        json.dumps(captions, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    print(f'扫描到 {len(found)} 张图片，写入 {cap_file}（{len(captions)} 条）')
    print('编辑 captions.json 里的空字符串即可加文字。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
