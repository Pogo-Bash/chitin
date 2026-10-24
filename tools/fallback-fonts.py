#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only
# Copyright (c) 2026 [OWNER NAME]
# Required Notice: Copyright (c) 2026 [OWNER NAME] ([PROJECT URL])
#
# Builds the engine's system fallback fonts (docs/fonts.md): downloads the Noto fonts below from the Noto
# project's own repositories (SIL Open Font License 1.1), each pinned by commit and sha256, into
# $CHITIN_EXT/fallback-fonts/src, then cuts them into Unicode-range subsets (WOFF2) in
# $CHITIN_EXT/fallback-fonts/out with a binary manifest (fallback.bin) the engine reads at start. The engine
# fetches a subset only when text needs a code point no loaded font has.
#
#   $CHITIN_EXT/venv/bin/python -I tools/fallback-fonts.py        # needs fontTools + brotli in that venv
#
# Downloads are data: nothing in them is run. A sha256 mismatch stops the script.
import hashlib, os, shutil, struct, subprocess, sys, urllib.request
from fontTools.ttLib import TTFont
from fontTools import subset

EXT = os.environ.get('CHITIN_EXT') or os.path.expanduser('~/dev/chitin-ext')
ROOT = os.path.join(EXT, 'fallback-fonts')
SRC = os.path.join(ROOT, 'src')
OUT = os.path.join(ROOT, 'out')

NOTO = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/957448b6168f09dca2c8005449e9b6f3fd2dd207/fonts'
CJK = 'https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans'
EMOJI = 'https://raw.githubusercontent.com/googlefonts/noto-emoji/8998f5dd683424a73e2314a8c1f1e359c19e8742/fonts'

# Flags in the manifest.
F_EMOJI, F_CJK = 1, 2
# CJK language tags (BCP 47 primary forms the engine matches against the document's lang and the locale).
LANG = {'SC': 'zh-Hans', 'TC': 'zh-Hant', 'JP': 'ja', 'KR': 'ko'}

def noto(name):
    return (name + '-Regular.ttf', f'{NOTO}/{name}/unhinted/ttf/{name}-Regular.ttf')

# (file, url, unused, flags, lang); the sha256 pins are in tools/fallback-fonts.sha256. Order is the fallback order for a code point several fonts cover.
FONTS = [
    (*noto('NotoSansArabic'), '', 0, ''),
    (*noto('NotoSansHebrew'), '', 0, ''),
    (*noto('NotoSansSyriac'), '', 0, ''),
    (*noto('NotoSansThaana'), '', 0, ''),
    (*noto('NotoSansDevanagari'), '', 0, ''),
    (*noto('NotoSansBengali'), '', 0, ''),
    (*noto('NotoSansGurmukhi'), '', 0, ''),
    (*noto('NotoSansGujarati'), '', 0, ''),
    (*noto('NotoSansOriya'), '', 0, ''),
    (*noto('NotoSansTamil'), '', 0, ''),
    (*noto('NotoSansTelugu'), '', 0, ''),
    (*noto('NotoSansKannada'), '', 0, ''),
    (*noto('NotoSansMalayalam'), '', 0, ''),
    (*noto('NotoSansSinhala'), '', 0, ''),
    (*noto('NotoSerifTibetan'), '', 0, ''),
    (*noto('NotoSansThai'), '', 0, ''),
    (*noto('NotoSansLao'), '', 0, ''),
    (*noto('NotoSansKhmer'), '', 0, ''),
    (*noto('NotoSansMyanmar'), '', 0, ''),
    (*noto('NotoSansGeorgian'), '', 0, ''),
    (*noto('NotoSansArmenian'), '', 0, ''),
    (*noto('NotoSansEthiopic'), '', 0, ''),
    ('NotoSansSC-Regular.otf', f'{CJK}/SubsetOTF/SC/NotoSansSC-Regular.otf', '', F_CJK, 'SC'),
    ('NotoSansTC-Regular.otf', f'{CJK}/SubsetOTF/TC/NotoSansTC-Regular.otf', '', F_CJK, 'TC'),
    ('NotoSansJP-Regular.otf', f'{CJK}/SubsetOTF/JP/NotoSansJP-Regular.otf', '', F_CJK, 'JP'),
    ('NotoSansKR-Regular.otf', f'{CJK}/SubsetOTF/KR/NotoSansKR-Regular.otf', '', F_CJK, 'KR'),
    (*noto('NotoSansMath'), '', 0, ''),
    (*noto('NotoSansSymbols'), '', 0, ''),
    (*noto('NotoSansSymbols2'), '', 0, ''),
    ('Noto-COLRv1.ttf', f'{EMOJI}/Noto-COLRv1.ttf', '', F_EMOJI, ''),
]
LICENSES = [
    ('OFL-notofonts.txt', f'{NOTO}/LICENSE'),
    ('OFL-noto-cjk.txt', f'{CJK}/LICENSE'),
    ('OFL-noto-emoji.txt', f'{EMOJI}/LICENSE'),
]
PINS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fallback-fonts.sha256')

def load_pins():
    pins = {}
    if os.path.exists(PINS_FILE):
        for line in open(PINS_FILE):
            if line.strip() and not line.startswith('#'):
                digest, name = line.split()
                pins[name] = digest
    return pins

def fetch(name, url, pins):
    path = os.path.join(SRC, name)
    if not os.path.exists(path):
        print('fetching', url, file=sys.stderr)
        tmp = path + '.part'
        with urllib.request.urlopen(url) as r, open(tmp, 'wb') as f:
            f.write(r.read())
        os.replace(tmp, path)
    digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    if name in pins and pins[name] != digest:
        sys.exit(f'{name}: sha256 {digest}, pinned {pins[name]}')
    return path, digest

def cjk_common(lang):
    # The everyday characters first: each national standard's first level (GB 2312 level 1, Big5 level 1,
    # JIS X 0208 level 1, KS X 1001 Hangul), so a page in the language mostly needs the first few subsets.
    out = []
    def two(codec, rows, cols):
        for a in rows:
            for b in cols:
                try:
                    out.extend(ord(c) for c in bytes([a, b]).decode(codec))
                except UnicodeDecodeError:
                    pass
    if lang == 'SC': two('gb2312', range(0xB0, 0xD8), range(0xA1, 0xFF))
    elif lang == 'TC': two('big5', range(0xA4, 0xC7), list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)))
    elif lang == 'JP': two('euc_jp', range(0xB0, 0xD0), range(0xA1, 0xFF))
    elif lang == 'KR': two('euc_kr', range(0xB0, 0xC9), range(0xA1, 0xFF))
    return out

def chunks_for(cps, flags, lang):
    cps = sorted(cps)
    if flags & F_CJK:
        cpset = set(cps)
        # Punctuation, kana, bopomofo, jamo, fullwidth forms: one subset every CJK page needs.
        basic = [c for c in cps if c < 0x3400 or 0xFF00 <= c <= 0xFFEF]
        common = [c for c in dict.fromkeys(cjk_common(lang)) if c in cpset and c not in set(basic)]
        rest = [c for c in cps if c not in set(basic) and c not in set(common)]
        out = [basic]
        out += [sorted(common[i:i + 500]) for i in range(0, len(common), 500)]
        out += [rest[i:i + 1000] for i in range(0, len(rest), 1000)]
        return [c for c in out if c]
    if flags & F_EMOJI:
        # Flags (regional indicators and tag sequences) apart from the rest; sequences inside a subset keep working.
        flag = [c for c in cps if 0x1F1E6 <= c <= 0x1F1FF or 0xE0020 <= c <= 0xE007F or c == 0x1F3F4]
        return [c for c in ([c for c in cps if c not in set(flag)], flag) if c]
    return [cps]

def runs(cps):
    out = []
    for c in cps:
        if out and out[-1][1] == c:
            out[-1][1] = c + 1
        else:
            out.append([c, c + 1])
    return out

def varint(n):
    b = bytearray()
    while True:
        if n < 0x80:
            b.append(n)
            return bytes(b)
        b.append((n & 0x7F) | 0x80)
        n >>= 7

def main():
    os.makedirs(SRC, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    pins = load_pins()
    base = set()
    for name in ('NotoSans-Regular.ttf', 'NotoSerif-Regular.ttf', 'NotoSansMono-Regular.ttf'):
        base |= set(TTFont(os.path.join(EXT, 'fonts', name)).getBestCmap())
    manifest = bytearray(b'CHFB' + struct.pack('<II', 1, len(FONTS)))
    record = []
    total = 0
    for name, url, _, flags, lang in FONTS:
        path, digest = fetch(name, url, pins)
        font = TTFont(path)
        cmap = font.getBestCmap()
        family = font['name'].getDebugName(1)
        version = font['name'].getDebugName(5)
        cps = [c for c in cmap if c not in base and c > 0x20]
        stem = os.path.splitext(name)[0]
        chunks = chunks_for(cps, flags, LANG.get(lang, '') and lang)
        langtag = LANG.get(lang, '').encode()
        fam = family.encode()
        manifest += struct.pack('<B', flags) + varint(len(fam)) + fam + varint(len(langtag)) + langtag + varint(len(chunks))
        for i, chunk in enumerate(chunks):
            file = f'{stem}-{i}.woff2'
            out = os.path.join(OUT, file)
            if not os.path.exists(out):
                opts = subset.Options()
                opts.flavor = 'woff2'
                opts.layout_features = ['*']
                opts.name_IDs = ['*']
                opts.notdef_outline = True
                opts.drop_tables += ['DSIG']
                sub = subset.Subsetter(opts)
                f = TTFont(path)
                sub.populate(unicodes=chunk)
                sub.subset(f)
                f.flavor = 'woff2'
                f.save(out)
            size = os.path.getsize(out)
            total += size
            fb = file.encode()
            rs = runs(chunk)
            manifest += varint(len(fb)) + fb + varint(size) + varint(len(rs))
            prev = 0
            for a, b in rs:
                manifest += varint(a - prev) + varint(b - a)
                prev = b
        record.append((name, url, version, digest, len(chunks)))
        print(f'{name}: {family} ({version}), {len(cps)} code points, {len(chunks)} subsets', file=sys.stderr)
    for name, url in LICENSES:
        fetch(name, url, {})
        shutil.copyfile(os.path.join(SRC, name), os.path.join(OUT, name))
    open(os.path.join(OUT, 'fallback.bin'), 'wb').write(manifest)
    with open(PINS_FILE + '.new', 'w') as f:
        f.write('# sha256 of each downloaded fallback font (tools/fallback-fonts.py)\n')
        for name, url, version, digest, n in record:
            f.write(f'{digest} {name}\n')
    if not os.path.exists(PINS_FILE):
        os.replace(PINS_FILE + '.new', PINS_FILE)
    else:
        os.remove(PINS_FILE + '.new')
    with open(os.path.join(ROOT, 'sources.tsv'), 'w') as f:
        for r in record:
            f.write('\t'.join(map(str, r)) + '\n')
    print(f'manifest {len(manifest)} bytes, subsets {total} bytes in {OUT}', file=sys.stderr)

main()
