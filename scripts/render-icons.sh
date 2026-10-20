#!/bin/zsh
# Renders icons/icon.svg to every PNG the app uses. Needs Google Chrome and Python Pillow.
set -e
cd "${0:A:h}/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=1024,1024 --screenshot="$PWD/icons/icon-1024.png" "file://$PWD/icons/icon.svg" 2>/dev/null
python3 - <<'PY'
from PIL import Image, ImageDraw
src = Image.open('icons/icon-1024.png').convert('RGB')
for size, name in [(512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'apple-touch-icon.png')]:
    src.resize((size, size), Image.LANCZOS).save(f'icons/{name}')
# Maskable: same art, a touch smaller on the same green so nothing meets the safe-zone edge.
bg = Image.new('RGB', (512, 512), (29, 97, 72))
bg.paste(src.resize((512, 512), Image.LANCZOS))
art = src.resize((440, 440), Image.LANCZOS)
bg.paste(art, (36, 36))
bg.save('icons/icon-maskable-512.png')
# Notification badge: white tick on transparent (Android uses the alpha only).
b = Image.new('RGBA', (96, 96), (0, 0, 0, 0)); d = ImageDraw.Draw(b)
d.line([(22, 50), (40, 68), (76, 26)], fill=(255, 255, 255, 255), width=11, joint='curve')
b.save('icons/badge-96.png')
PY
echo icons rendered
