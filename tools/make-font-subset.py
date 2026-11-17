# 生成内置中文字体子集：ASCII + 全角符号 + 中文标点 + GB2312 一级汉字（常用 3755 字）
# 输出 WOFF（zlib），无需 brotli
import os
import sys
from fontTools import subset

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, '_fonts', 'NotoSansSC-Regular.otf')
OUT = os.path.join(BASE, '_fonts', 'noto-sc-subset.woff')
TXT = os.path.join(BASE, '_fonts', 'charset.txt')

chars = set()
for c in range(0x20, 0x7F):
    chars.add(chr(c))
for c in range(0xFF01, 0xFF5F):
    chars.add(chr(c))

for ch in '，。、；：？！“”‘’（）【】《》〈〉…—～·「」『』〔〕％＃＠＆＊／＼｜':
    chars.add(ch)

for b1 in range(0xB0, 0xD8):
    for b2 in range(0xA1, 0xFF):
        try:
            chars.add(bytes([b1, b2]).decode('gb2312'))
        except UnicodeDecodeError:
            pass

text = ''.join(sorted(chars))
with open(TXT, 'w', encoding='utf-8') as f:
    f.write(text)
print('charset size:', len(chars))

args = [
    SRC,
    '--text-file=' + TXT,
    '--flavor=woff',
    '--output-file=' + OUT,
    '--layout-features=*',
    '--name-IDs=*',
    '--no-hinting',
]
subset.main(args)

print('woff bytes:', os.path.getsize(OUT))
