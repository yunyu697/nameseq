"""生成应用图标（纯几何绘制 + 超采样抗锯齿），避免引入额外设计依赖。"""

from pathlib import Path
from PIL import Image, ImageDraw

SS = 8
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BLUE = (24, 95, 165, 255)
WHITE = (255, 255, 255, 255)


def make(size: int) -> Image.Image:
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BLUE)

    def rect(x0, y0, x1, y1, radius_frac=0.03):
        d.rounded_rectangle(
            [int(x0 * S), int(y0 * S), int(x1 * S), int(y1 * S)],
            radius=max(1, int(S * radius_frac)),
            fill=WHITE,
        )

    # 两行"文件名"，一长一短，暗示批量
    rect(0.20, 0.275, 0.62, 0.345)
    rect(0.20, 0.405, 0.48, 0.475)

    # 第三行做成箭头，表示"改名/转换"
    rect(0.20, 0.565, 0.52, 0.635)
    d.polygon(
        [
            (int(0.50 * S), int(0.485 * S)),
            (int(0.50 * S), int(0.715 * S)),
            (int(0.80 * S), int(0.600 * S)),
        ],
        fill=WHITE,
    )

    return img.resize((size, size), Image.LANCZOS)


targets = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square150x150Logo.png": 150,
    "StoreLogo.png": 50,
}

for name, size in targets.items():
    make(size).save(OUT / name)

ico_base = make(256)
ico_base.save(
    OUT / "icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

print("icons written to", OUT)
for p in sorted(OUT.iterdir()):
    print(" ", p.name, p.stat().st_size, "bytes")
