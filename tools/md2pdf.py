# -*- coding: utf-8 -*-
"""Markdown → A4 打印版 HTML → PDF（复用本机 Chrome，无第三方服务）

用法:
    python tools/md2pdf.py 团队长期协作部署指南.md
    python tools/md2pdf.py 某文档.md --sub "副标题" --out 某文档.pdf
"""
import io
import os
import re
import subprocess
import sys

import markdown

CHROME_CANDIDATES = [
    os.environ.get('CHROME', ''),
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
]

CSS = """
@page { size: A4; margin: 17mm 14mm 15mm; }
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
       font-size: 9.6pt; line-height: 1.78; color: #1b1d22; }
h1 { page-break-before: always; page-break-after: avoid;
     font-size: 15pt; font-weight: 600; color: #1a3a5c;
     border-bottom: 1px solid #d8dee7; padding-bottom: 4pt; margin: 0 0 8pt; }
h2 { page-break-after: avoid; font-size: 12.5pt; font-weight: 600;
     color: #1a3a5c; margin: 14pt 0 6pt; }
h3 { page-break-after: avoid; font-size: 10.8pt; font-weight: 600; margin: 11pt 0 5pt; }
p  { margin: 0 0 6pt; }
ul, ol { margin: 0 0 7pt; padding-left: 15pt; }
li { margin-bottom: 3pt; }
strong { font-weight: 600; }
code { font-family: Consolas, "Courier New", monospace; font-size: 8.5pt;
       background: #f2f4f7; padding: 0.5pt 3pt; border-radius: 2pt; }
pre { background: #f6f7f9; border: 1px solid #e3e6ea; border-radius: 4pt;
      padding: 7pt 9pt; margin: 0 0 9pt; page-break-inside: avoid;
      white-space: pre-wrap; word-break: break-all; }
pre code { background: none; padding: 0; font-size: 8.3pt; }
blockquote { page-break-inside: avoid; margin: 0 0 9pt; padding: 6pt 10pt;
             background: #f4f7fa; border-left: 2.5pt solid #7f9ec2; color: #33465f; }
blockquote p { margin: 0; }
table { width: 100%; border-collapse: collapse; font-size: 8.3pt;
        page-break-inside: auto; margin: 0 0 10pt; }
thead { display: table-header-group; }
th { background: #eef2f7; font-weight: 600; text-align: left; }
th, td { border: 0.5pt solid #cbd3dd; padding: 3.5pt 5pt; vertical-align: top; }
tr { page-break-inside: avoid; }
hr { border: 0; border-top: 0.5pt solid #dde2e8; margin: 10pt 0; }
a { color: #1a5fb4; text-decoration: none; }
details { margin: 0 0 8pt; }
summary { color: #1a5fb4; cursor: default; }
.cover { page-break-after: always; page-break-inside: avoid;
         border: 1.2pt solid #1a3a5c; padding: 34mm 16mm 30mm; text-align: center; }
.cover h1 { page-break-before: avoid; page-break-after: avoid;
            border: 0; font-size: 23pt; font-weight: 600; color: #1a3a5c;
            margin: 0 0 10pt; padding: 0; }
.cover .sub { font-size: 10.5pt; color: #4a5568; line-height: 1.95; }
.cover .tag { margin-top: 16mm; font-size: 9pt; color: #8a90a0; line-height: 1.8; }
"""


def find_chrome():
    for p in CHROME_CANDIDATES:
        if p and os.path.exists(p):
            return p
    return None


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    md_path = args[0]
    sub_title = ''
    out_pdf = ''
    i = 1
    while i < len(args):
        if args[i] == '--sub' and i + 1 < len(args):
            sub_title = args[i + 1]; i += 2
        elif args[i] == '--out' and i + 1 < len(args):
            out_pdf = args[i + 1]; i += 2
        else:
            print('未知参数：' + args[i]); sys.exit(1)

    src = io.open(md_path, 'r', encoding='utf-8').read()
    m = re.search(r'^#\s+(.+?)\s*$', src, re.M)
    title = m.group(1) if m else os.path.splitext(os.path.basename(md_path))[0]
    body_md = src[m.end():] if m else src

    body = markdown.markdown(body_md, extensions=['tables', 'fenced_code', 'sane_lists', 'nl2br'])
    html = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>{t}</title><style>{css}</style></head>
<body>
<div class="cover"><h1>{t}</h1>
<div class="sub">{sub}</div>
<div class="tag">M²Studio 协作白板 · 长期团队协作部署</div></div>
{body}
</body></html>""".format(t=title, sub=sub_title or '照着做即可 · 3–5 人跨地区 · 长期自建', css=CSS, body=body)

    base = os.path.splitext(md_path)[0]
    html_path = base + '.html'
    io.open(html_path, 'w', encoding='utf-8', newline='\n').write(html)
    print('html ->', html_path, len(html), 'chars')

    pdf_path = out_pdf or (base + '.pdf')
    chrome = find_chrome()
    if not chrome:
        print('找不到 Chrome/Edge，HTML 已生成，可手动用浏览器打印为 PDF')
        return
    url = 'file:///' + os.path.abspath(html_path).replace('\\', '/')
    cmd = [chrome, '--headless=new', '--disable-gpu', '--no-sandbox',
           '--no-pdf-header-footer', '--print-to-pdf=' + os.path.abspath(pdf_path), url]
    r = subprocess.run(cmd, capture_output=True)
    if not os.path.exists(pdf_path):
        print('PDF 生成失败：', r.stderr.decode('utf-8', 'ignore')[:400])
        sys.exit(1)
    print('pdf  ->', pdf_path, os.path.getsize(pdf_path), 'bytes')


if __name__ == '__main__':
    main()
