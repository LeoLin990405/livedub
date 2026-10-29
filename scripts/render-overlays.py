#!/usr/bin/env python3
"""livedub 的离屏图层渲染（Pillow）：演示视频幻灯片 + 双语字幕 PNG。

为什么用 Python：本机 ffmpeg 未编译 libass/libfreetype（无 drawtext/subtitles 滤镜），
所以用 Pillow 渲染透明 PNG，再用 ffmpeg overlay 滤镜合成。

用法:
  render-overlays.py slides    --spec spec.json --out dir
  render-overlays.py subtitles --srt out.srt --out dir [--width 1280] [--height 720]

输出:
  slides:    slide_01.png ... + slides.json
  subtitles: sub_0001.png ... + subtitles.json（含 startMs/endMs/file）
"""

import argparse
import json
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

FONT_EN = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_EN_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_ZH = "/System/Library/Fonts/PingFang.ttc"

BG_TOP = (11, 16, 32)
BG_BOTTOM = (18, 28, 52)
ACCENT = (94, 234, 212)
TEXT = (236, 242, 255)
TEXT_DIM = (148, 163, 184)
CARD = (15, 23, 42)


def load_font(path, size, index=0):
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        for fallback in (FONT_ZH, FONT_EN):
            try:
                return ImageFont.truetype(fallback, size, index=0)
            except Exception:
                continue
    return ImageFont.load_default()


def gradient_bg(w, h):
    img = Image.new("RGB", (w, h), BG_TOP)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOTTOM[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOTTOM[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOTTOM[2] * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def wrap_text(draw, text, font, max_width):
    words = text.split(" ")
    lines, cur = [], ""
    for word in words:
        candidate = (cur + " " + word).strip()
        if draw.textlength(candidate, font=font) <= max_width or not cur:
            cur = candidate
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def render_slide(spec, out_path):
    w = int(spec.get("width", 1280))
    h = int(spec.get("height", 720))
    img = gradient_bg(w, h).convert("RGBA")
    draw = ImageDraw.Draw(img, "RGBA")

    # 左侧强调竖条 + 顶部标签
    draw.rounded_rectangle([72, 84, 84, 300], radius=6, fill=ACCENT)
    tag_font = load_font(FONT_EN_BOLD, 22)
    draw.text((110, 84), str(spec.get("eyebrow", "LIVEDUB DEMO LECTURE")).upper(), font=tag_font, fill=ACCENT)

    title_font = load_font(FONT_EN_BOLD, 56)
    y = 130
    for line in wrap_text(draw, spec.get("title", ""), title_font, w - 220):
        draw.text((110, y), line, font=title_font, fill=TEXT)
        y += 66

    if spec.get("subtitle"):
        sub_font = load_font(FONT_ZH, 26)
        draw.text((110, y + 6), spec["subtitle"], font=sub_font, fill=TEXT_DIM)
        y += 56

    body_font = load_font(FONT_EN, 30)
    y = max(y + 40, 330)
    for bullet in spec.get("bullets", []):
        draw.ellipse([112, y + 12, 124, y + 24], fill=ACCENT)
        for line in wrap_text(draw, bullet, body_font, w - 260):
            draw.text((140, y), line, font=body_font, fill=TEXT)
            y += 40
        y += 18

    footer_font = load_font(FONT_EN, 20)
    draw.text((110, h - 66), spec.get("footer", "livedub · real-time lecture interpretation"), font=footer_font, fill=TEXT_DIM)
    page = spec.get("page")
    if page:
        label = f"{page:02d}"
        tw = draw.textlength(label, font=footer_font)
        draw.text((w - 110 - tw, h - 66), label, font=footer_font, fill=TEXT_DIM)
    img.convert("RGB").save(out_path)


def parse_srt(path):
    text = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    blocks = re.split(r"\n\s*\n", text.strip())
    cues = []
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip()]
        if len(lines) < 2:
            continue
        timing = next((ln for ln in lines if "-->" in ln), None)
        if not timing:
            continue
        idx = lines.index(timing)
        start, end = [s.strip() for s in timing.split("-->")]
        cues.append(
            {
                "startMs": srt_time_to_ms(start),
                "endMs": srt_time_to_ms(end),
                "lines": lines[idx + 1 :],
            }
        )
    return cues


def srt_time_to_ms(value):
    m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)", value)
    if not m:
        return 0
    hh, mm, ss, ms = m.groups()
    return ((int(hh) * 60 + int(mm)) * 60 + int(ss)) * 1000 + int(ms.ljust(3, "0")[:3])


def rounded(draw, box, radius, fill):
    x0, y0, x1, y1 = box
    r = min(radius, (x1 - x0) // 2, (y1 - y0) // 2)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=fill)


def render_subtitle(cue, out_path, width=1280, height=720):
    """双语字幕：底部渐变压暗 + 高不透明度圆角卡片（英文小灰行 + 中文大白行），避免与画面文字打架。"""
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img, "RGBA")
    en_font = load_font(FONT_EN, 22)
    zh_font = load_font(FONT_ZH, 36, index=0)
    lines = cue["lines"]
    zh_lines = [ln for ln in lines if re.search(r"[\u4e00-\u9fff]", ln)]
    en_lines = [ln for ln in lines if not re.search(r"[\u4e00-\u9fff]", ln)]
    if not zh_lines:
        zh_lines, en_lines = en_lines, []

    # 底部整幅压暗，保证任何幻灯片背景下字幕都可读
    scrim_top = int(height * 0.60)
    for y in range(scrim_top, height):
        t = (y - scrim_top) / max(1, height - scrim_top)
        alpha = int(150 * (t ** 1.5))
        draw.line([(0, y), (width, y)], fill=(4, 7, 18, alpha))

    pad_x, pad_y, gap = 30, 16, 6
    max_text_w = width - 180
    en_wrapped, zh_wrapped = [], []
    for ln in en_lines:
        en_wrapped += wrap_text(draw, ln, en_font, max_text_w)
    for ln in zh_lines:
        cur = ""
        for ch in ln:
            if draw.textlength(cur + ch, font=zh_font) > max_text_w:
                zh_wrapped.append(cur)
                cur = ch
            else:
                cur += ch
        if cur:
            zh_wrapped.append(cur)

    def line_h(font):
        return font.size + 5

    en_h = sum(line_h(en_font) for _ in en_wrapped) + (gap if en_wrapped and zh_wrapped else 0)
    zh_h = sum(line_h(zh_font) for _ in zh_wrapped)
    box_w = width - 130
    box_h = en_h + zh_h + pad_y * 2
    x0 = (width - box_w) // 2
    y0 = height - box_h - 8
    # 卡片：高不透明度 + 顶部强调线
    rounded(draw, [x0, y0, x0 + box_w, y0 + box_h], 16, (8, 12, 26, 242))
    draw.rectangle([x0 + 18, y0 + 1, x0 + box_w - 18, y0 + 3], fill=(*ACCENT, 235))

    y = y0 + pad_y
    for ln in en_wrapped:
        tw = draw.textlength(ln, font=en_font)
        draw.text(((width - tw) / 2, y), ln, font=en_font, fill=TEXT_DIM)
        y += line_h(en_font)
    if en_wrapped and zh_wrapped:
        y += gap
    for ln in zh_wrapped:
        tw = draw.textlength(ln, font=zh_font)
        draw.text(((width - tw) / 2, y), ln, font=zh_font, fill=TEXT)
        y += line_h(zh_font)
    img.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["slides", "subtitles"])
    ap.add_argument("--spec")
    ap.add_argument("--srt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    if args.mode == "slides":
        spec = json.load(open(args.spec, encoding="utf-8"))
        pages = []
        for i, slide in enumerate(spec.get("slides", []), start=1):
            slide.setdefault("width", spec.get("width", args.width))
            slide.setdefault("height", spec.get("height", args.height))
            slide.setdefault("page", i)
            slide.setdefault("eyebrow", spec.get("eyebrow", "LIVEDUB DEMO LECTURE"))
            slide.setdefault("footer", spec.get("footer", "livedub · real-time lecture interpretation"))
            path = os.path.join(args.out, f"slide_{i:02d}.png")
            render_slide(slide, path)
            pages.append({"file": os.path.basename(path), "index": i})
        json.dump({"slides": pages}, open(os.path.join(args.out, "slides.json"), "w"), indent=2)
        print(json.dumps({"ok": True, "slides": len(pages), "out": args.out}))
        return

    cues = parse_srt(args.srt)
    manifest = []
    for i, cue in enumerate(cues, start=1):
        name = f"sub_{i:04d}.png"
        render_subtitle(cue, os.path.join(args.out, name), width=args.width, height=args.height)
        manifest.append({"file": name, "startMs": cue["startMs"], "endMs": cue["endMs"]})
    json.dump({"cues": manifest}, open(os.path.join(args.out, "subtitles.json"), "w"), indent=2)
    print(json.dumps({"ok": True, "cues": len(manifest), "out": args.out}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # 便于 Node 侧读到明确错误
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
