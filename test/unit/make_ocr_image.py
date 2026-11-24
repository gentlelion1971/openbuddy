# Makes a PNG with known printed text for the OCR unit test.
# Usage: python3 make_ocr_image.py <output-path>
# All code, comments, log messages and docs in this project are English only.

import sys

from PIL import Image, ImageDraw, ImageFont

out_path = sys.argv[1]
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 44)
img = Image.new("RGB", (900, 300), "white")
draw = ImageDraw.Draw(img)
draw.text((30, 30), "Swim Practice", fill="black", font=font)
draw.text((30, 110), "Monday 6:00 PM", fill="black", font=font)
draw.text((30, 190), "Pool B", fill="black", font=font)
img.save(out_path, "PNG")
