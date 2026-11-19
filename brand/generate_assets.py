#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小说工厂 · 品牌素材生成器
设计语言：深青渐变 + 展开书卷 + 文曲星芒（创作灵感 / 中国神话意象）
产出：
  - 应用图标：Android adaptive foreground/background + 各密度 legacy 图标 + PWA 192/512
  - 启动页：各 density + 横竖屏 splash
  - 引导页插画：3 张 SVG（供前端 onboarding 使用，纯 SVG 无需光栅）
所有图形用 SVG 矢量定义，cairosvg 光栅化，保证多尺寸一致、无 emoji、单一焦点。
"""
import os, math
import cairosvg

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
WEB = os.path.join(ROOT, "src", "web")

TEAL_D = "#0B3233"   # 深
TEAL_M = "#0D3A3B"   # 主
TEAL_L = "#1A6E6B"   # 亮
MINT = "#8FD4C6"     # 薄荷点缀
GOLD = "#E7B45B"     # 星芒金
PAPER = "#F5F7F4"    # 纸白

# ---------- 应用图标：adaptive foreground（透明底，图形居中安全区 66/108） ----------
# viewBox 108x108，主体控制在中心 ~66x66（21..87），圆形遮罩下不裁切
FG_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <defs>
    <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCEAE6"/>
    </linearGradient>
    <linearGradient id="st" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{GOLD}"/><stop offset="1" stop-color="#F3D79A"/>
    </linearGradient>
  </defs>
  <!-- 全部元素收进中心安全圆（半径≈30，圆心54,54），圆形/圆角遮罩下均不裁切 -->
  <!-- 展开的书卷：左右两页，书脊在中央 -->
  <path d="M54 68 C45 62 34 61 27 64 L27 43 C34 40 45 41 54 47 Z" fill="url(#pg)"/>
  <path d="M54 68 C63 62 74 61 81 64 L81 43 C74 40 63 41 54 47 Z" fill="url(#pg)"/>
  <path d="M54 47 L54 68" stroke="{TEAL_L}" stroke-width="1.8" opacity=".55"/>
  <!-- 书页文字线 -->
  <g stroke="{TEAL_L}" stroke-width="2" stroke-linecap="round" opacity=".45">
    <path d="M32 50 H48"/><path d="M32 55 H48"/><path d="M32 60 H45"/>
    <path d="M60 50 H76"/><path d="M60 55 H76"/><path d="M60 60 H73"/>
  </g>
  <!-- 文曲星芒：从书脊升起，四角星 + 小星（均在安全区内） -->
  <path d="M54 26 L57.3 35 L66 38 L57.3 41 L54 50 L50.7 41 L42 38 L50.7 35 Z" fill="url(#st)"/>
  <circle cx="72" cy="33" r="2" fill="{MINT}"/>
  <circle cx="37" cy="35" r="1.6" fill="{MINT}" opacity=".85"/>
</svg>'''

# ---------- adaptive background：深青渐变 ----------
BG_SVG = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0" stop-color="{TEAL_L}"/><stop offset="1" stop-color="{TEAL_D}"/>
    </radialGradient>
  </defs>
  <rect width="108" height="108" fill="url(#bg)"/>
</svg>'''

# ---------- legacy / PWA 完整图标（带圆角底 + 微妙光晕） ----------
def full_icon_svg(size=512, round_mask=False):
    # 真·圆形版用于 ic_launcher_round；方形版用于 legacy / PWA
    clip = ('<clipPath id="rr"><circle cx="256" cy="256" r="248"/></clipPath>'
            if round_mask else
            '<clipPath id="rr"><rect x="16" y="16" width="480" height="480" rx="108"/></clipPath>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="36%" r="78%">
      <stop offset="0" stop-color="{TEAL_L}"/><stop offset=".62" stop-color="{TEAL_M}"/><stop offset="1" stop-color="{TEAL_D}"/>
    </radialGradient>
    <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCEAE6"/>
    </linearGradient>
    <linearGradient id="st" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{GOLD}"/><stop offset="1" stop-color="#F3D79A"/>
    </linearGradient>
    {clip}
  </defs>
  <g clip-path="url(#rr)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <!-- 光晕 -->
    <circle cx="256" cy="210" r="150" fill="{MINT}" opacity=".07"/>
    <!-- 书卷（放大到居中视觉重心） -->
    <g transform="translate(256 268) scale(3.05) translate(-54 -55)">
      <path d="M54 70 C45 64 33 63 24 66 L24 40 C33 37 45 38 54 44 Z" fill="url(#pg)"/>
      <path d="M54 70 C63 64 75 63 84 66 L84 40 C75 37 63 38 54 44 Z" fill="url(#pg)"/>
      <path d="M54 44 L54 70" stroke="{TEAL_L}" stroke-width="1.8" opacity=".55"/>
      <g stroke="{TEAL_L}" stroke-width="2" stroke-linecap="round" opacity=".45">
        <path d="M30 47 H47"/><path d="M30 53 H47"/><path d="M30 59 H44"/>
        <path d="M61 47 H78"/><path d="M61 53 H78"/><path d="M61 59 H75"/>
      </g>
      <path d="M54 18 L57.6 31 L70 34.5 L57.6 38 L54 50.5 L50.4 38 L38 34.5 L50.4 31 Z" fill="url(#st)"/>
      <circle cx="74" cy="24" r="2.2" fill="{MINT}"/>
      <circle cx="34" cy="27" r="1.7" fill="{MINT}" opacity=".85"/>
    </g>
  </g>
</svg>'''

# ---------- 启动页 Splash（竖屏/横屏，居中 logo + 应用名 + 副标题） ----------
def splash_svg(w, h, horizontal=False):
    cx = w / 2
    if horizontal:
        scale = h / 900
        logo_y = h * 0.34
        title_y = h * 0.66
        sub_y = h * 0.79
    else:
        scale = w / 720
        logo_y = h * 0.44
        title_y = h * 0.70
        sub_y = h * 0.77
    ls = 190 * scale  # logo size（放大提升存在感）
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="80%">
      <stop offset="0" stop-color="{TEAL_L}"/><stop offset=".6" stop-color="{TEAL_M}"/><stop offset="1" stop-color="{TEAL_D}"/>
    </radialGradient>
    <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCEAE6"/>
    </linearGradient>
    <linearGradient id="st" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{GOLD}"/><stop offset="1" stop-color="#F3D79A"/>
    </linearGradient>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#bg)"/>
  <circle cx="{cx}" cy="{logo_y}" r="{ls*0.95}" fill="{MINT}" opacity=".06"/>
  <!-- logo 图形（去背景圆角，仅主体） -->
  <g transform="translate({cx} {logo_y}) scale({ls/108}) translate(-54 -55)">
    <path d="M54 70 C45 64 33 63 24 66 L24 40 C33 37 45 38 54 44 Z" fill="url(#pg)"/>
    <path d="M54 70 C63 64 75 63 84 66 L84 40 C75 37 63 38 54 44 Z" fill="url(#pg)"/>
    <path d="M54 44 L54 70" stroke="{TEAL_L}" stroke-width="1.8" opacity=".5"/>
    <g stroke="{TEAL_L}" stroke-width="2" stroke-linecap="round" opacity=".42">
      <path d="M30 47 H47"/><path d="M30 53 H47"/><path d="M30 59 H44"/>
      <path d="M61 47 H78"/><path d="M61 53 H78"/><path d="M61 59 H75"/>
    </g>
    <path d="M54 18 L57.6 31 L70 34.5 L57.6 38 L54 50.5 L50.4 38 L38 34.5 L50.4 31 Z" fill="url(#st)"/>
    <circle cx="74" cy="24" r="2.2" fill="{MINT}"/>
    <circle cx="34" cy="27" r="1.7" fill="{MINT}" opacity=".85"/>
  </g>
  <text x="{cx}" y="{title_y}" fill="#FFFFFF" font-family="Noto Sans CJK SC, sans-serif" font-size="{34*scale}" font-weight="700" text-anchor="middle" letter-spacing="{6*scale}">小说工厂</text>
  <text x="{cx}" y="{sub_y}" fill="{MINT}" font-family="Noto Sans CJK SC, sans-serif" font-size="{15*scale}" text-anchor="middle" letter-spacing="{3*scale}" opacity=".9">全自动创作平台</text>
  <text x="{cx}" y="{h - 26*scale}" fill="{MINT}" font-family="sans-serif" font-size="{11*scale}" text-anchor="middle" opacity=".45">v2.2.0</text>
</svg>'''

def save_svg(svg, path):
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg)

def raster(svg, path, w=None, h=None):
    kw = {}
    if w and h: kw = dict(output_width=w, output_height=h)
    elif w: kw = dict(output_width=w)
    cairosvg.svg2png(bytestring=svg.encode("utf-8"), write_to=path, **kw)

# ============ 1. 应用图标 ============
save_svg(FG_SVG, os.path.join(HERE, "ic_launcher_foreground.svg"))
save_svg(BG_SVG, os.path.join(HERE, "ic_launcher_background.svg"))
save_svg(full_icon_svg(), os.path.join(HERE, "ic_launcher_full.svg"))

# adaptive foreground：各密度（icon 尺寸 = 108dp * density）
DENSITY = {"mdpi":1, "hdpi":1.5, "xhdpi":2, "xxhdpi":3, "xxxhdpi":4}
for den, mul in DENSITY.items():
    px = int(108 * mul)
    d = os.path.join(RES, f"mipmap-{den}")
    os.makedirs(d, exist_ok=True)
    raster(FG_SVG, os.path.join(d, "ic_launcher_foreground.png"), px, px)
    raster(full_icon_svg(), os.path.join(d, "ic_launcher.png"), px, px)
    raster(full_icon_svg(round_mask=True), os.path.join(d, "ic_launcher_round.png"), px, px)

# PWA / web 图标
full = full_icon_svg()
raster(full, os.path.join(WEB, "icon-192.png"), 192, 192)
raster(full, os.path.join(WEB, "icon-512.png"), 512, 512)
raster(full, os.path.join(HERE, "app-logo.png"), 512, 512)

# ============ 2. 启动页 ============
# 通用 drawable（480x320 基准）与 port/land 各密度
SLASH = {
    "drawable": (480, 320, True),
    "drawable-port-mdpi": (480, 800, False),
    "drawable-port-hdpi": (720, 1200, False),
    "drawable-port-xhdpi": (960, 1600, False),
    "drawable-port-xxhdpi": (1440, 2400, False),
    "drawable-port-xxxhdpi": (1920, 3200, False),
    "drawable-land-mdpi": (800, 480, True),
    "drawable-land-hdpi": (1200, 720, True),
    "drawable-land-xhdpi": (1600, 960, True),
    "drawable-land-xxhdpi": (2400, 1440, True),
    "drawable-land-xxxhdpi": (3200, 1920, True),
}
for folder, (w, h, horiz) in SLASH.items():
    d = os.path.join(RES, folder)
    os.makedirs(d, exist_ok=True)
    raster(splash_svg(w, h, horiz), os.path.join(d, "splash.png"), w, h)

print("✅ 品牌素材生成完成：应用图标(adaptive+legacy+PWA)、启动页(各密度横竖屏)")
print("   图标源文件:", HERE)
