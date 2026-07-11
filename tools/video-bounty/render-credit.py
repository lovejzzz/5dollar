from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text", required=True)
    parser.add_argument("--font", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--font-size", type=int, default=28)
    args = parser.parse_args()

    font = ImageFont.truetype(args.font, args.font_size)
    probe = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    probe_draw = ImageDraw.Draw(probe)
    bounds = probe_draw.textbbox((0, 0), args.text, font=font)
    text_width = bounds[2] - bounds[0]
    text_height = bounds[3] - bounds[1]
    horizontal_padding = 20
    vertical_padding = 14
    width = text_width + horizontal_padding * 2
    height = text_height + vertical_padding * 2

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=12, fill=(0, 0, 0, 105))
    draw.text(
        (horizontal_padding, vertical_padding - bounds[1]),
        args.text,
        font=font,
        fill=(255, 255, 255, 232),
    )
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output)


if __name__ == "__main__":
    main()
