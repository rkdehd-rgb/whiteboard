# -*- coding: utf-8 -*-
"""Markdown -> HTML（A4 打印版），供 Edge headless 打印成 PDF"""
import io
import os
import re
import sys

import markdown

BASE = r'C:\Users\AJ\WorkBuddy\2026-09-16-15-08-29'
MD = os.path.join(BASE, '协作白板服务器搭建说明.md')
HTML = os.path.join(BASE, '协作白板服务器搭建说明.html')

with io.open(MD, 'r', encoding='utf-8') as f:
    src = f.read()

# 首个一级标题做封面标题，正文从其后开始
m = re.search(r'^#\s+(.+?)\s*$', src, re.M)
cover_title = m.group(1) if m else '说明文档'
body_md = src[m.end():] if m else src

body = markdown.markdown(
    body_md,
    extensions=['tables', 'fenced_code', 'sane_lists', 'nl2br']
)

CSS = """
@page { size: A4; margin: 17mm 14mm 15mm; }
* { box-sizing: border-box; }
body {
  font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
  font-size: 9.6pt; line-height: 1.75; color: #1b1d22;
}
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
code { font-family: Consolas, "Courier New", monospace; font-size: 8.6pt;
       background: #f2f4f7; padding: 0.5pt 3pt; border-radius: 2pt; }
pre { background: #f6f7f9; border: 1px solid #e3e6ea; border-radius: 4pt;
      padding: 7pt 9pt; margin: 0 0 9pt; page-break-inside: avoid;
      white-space: pre-wrap; word-break: break-all; }
pre code { background: none; padding: 0; font-size: 8.4pt; }
blockquote { page-break-inside: avoid; margin: 0 0 9pt; padding: 6pt 10pt;
             background: #f4f7fa; border-left: 2.5pt solid #7f9ec2; color: #33465f; }
blockquote p { margin: 0; }
table { width: 100%; border-collapse: collapse; font-size: 8.4pt;
        page-break-inside: auto; margin: 0 0 10pt; }
thead { display: table-header-group; }
th { background: #eef2f7; font-weight: 600; text-align: left; }
th, td { border: 0.5pt solid #cbd3dd; padding: 3.5pt 5pt; vertical-align: top; }
tr { page-break-inside: avoid; }
hr { border: 0; border-top: 0.5pt solid #dde2e8; margin: 10pt 0; }
a { color: #1a5fb4; text-decoration: none; }

.cover { page-break-after: always; page-break-inside: avoid;
         border: 1.2pt solid #1a3a5c; padding: 34mm 16mm 30mm; text-align: center; }
.cover h1 { page-break-before: avoid; page-break-after: avoid;
            border: 0; font-size: 24pt; font-weight: 600; color: #1a3a5c;
            margin: 0 0 10pt; padding: 0; }
.cover .sub { font-size: 11pt; color: #4a5568; line-height: 1.9; }
.cover .tag { margin-top: 16mm; font-size: 9pt; color: #8a90a0; }
"""

html = u"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<div class="cover">
  <h1>{title}</h1>
  <div class="sub">零基础可照做 · 局域网多人实时协作 · 内容自动保存在本机</div>
  <div class="tag">配套文件：whiteboard.html · relay-server.js · 启动中继.bat</div>
</div>
{body}
</body>
</html>
""".format(title=cover_title, css=CSS, body=body)

with io.open(HTML, 'w', encoding='utf-8') as f:
    f.write(html)

print('html ->', HTML)
print('chars:', len(html))
