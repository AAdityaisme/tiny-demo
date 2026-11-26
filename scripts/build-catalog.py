"""Builds data/themes.json from the Shopify Theme Store listings of the four Tiny theme studios."""
import json, re, html, sys, urllib.request

STUDIOS = {
    "Pixel Union": ["empire", "atlantic", "tailor", "editions", "startup", "grid"],
    "Archetype Themes": ["impulse", "motion", "streamline", "expanse"],
    "Clean Canvas": ["beautify", "symmetry", "enterprise", "mode", "alchemy", "showcase", "masonry", "expression", "boost", "canopy"],
    "Out of the Sandbox": ["flex", "turbo", "superstore", "vino", "parallax", "responsive", "retina", "launch", "pacific"],
}
UA = {"User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36"}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")

def text(t):
    t = re.sub(r"<script.*?</script>|<style.*?</style>|<svg.*?</svg>", "", t, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))

def shot(page, name):
    m = re.search(r'<img[^>]+alt="Theme screenshot that previews ' + re.escape(name) + r'"[^>]+src="([^"]+)"', page) or \
        re.search(r'<img[^>]+src="([^"]+)"[^>]+alt="Theme screenshot that previews ' + re.escape(name) + r'"', page)
    return m.group(1).split("?")[0] + "?width=800" if m else None

FEATURE_GROUPS = ["Cart and checkout", "Customer accounts and sign-in", "Marketing and conversion", "Merchandising", "Product discovery"]

out = []
for studio, slugs in STUDIOS.items():
    for slug in slugs:
        try:
            final, page = get(f"https://themes.shopify.com/themes/{slug}")
        except Exception as e:
            print("MISS", slug, e, file=sys.stderr); continue
        txt = text(page)
        name_m = re.search(r'<meta property="og:title" content="([^"]+)"', page)
        img_m = re.search(r'<meta property="og:image" content="([^"]+)"', page)
        by = re.search(r"by\s*<a[^>]*>([^<]+)</a>", page)
        if not by or by.group(1).strip().lower().replace(" ", "") not in studio.lower().replace(" ", ""):
            print("SKIP (not by studio)", slug, by.group(1) if by else None, file=sys.stderr); continue
        name = slug.capitalize()
        m = re.search(re.escape(name) + r" \$(\d+) USD (.*?) by " + re.escape(by.group(1).strip()), txt)
        price = int(m.group(1)) if m else None
        tagline = m.group(2).strip() if m else ""
        rating = re.search(r"\$\d+ USD • (\d+)%", txt)
        cat = re.search(r"(\w+ \([\d\-+, ]+\)) Catalog size", txt)
        inds = re.findall(r"([A-Z][\w ,&]+?) Industry", txt[:600])
        feats_txt = txt[txt.find("WHAT'S INCLUDED"):]
        feats = []
        if feats_txt:
            seg = feats_txt[:2500]
            for g in FEATURE_GROUPS: seg = seg.replace(g, "|")
            seg = seg.replace("WHAT'S INCLUDED Features", "")
            feats = sorted(set(w.strip() for w in re.split(r"\|", seg)[1:5] for w in []))
        feat_block = re.search(r"WHAT'S INCLUDED Features .*?(Cart and checkout.*?)(?: Cart and checkout )", txt)
        feature_list = []
        if feat_block:
            s = feat_block.group(1)
            for g in FEATURE_GROUPS: s = s.replace(g, "\n")
            feature_list = [f for f in s.split("\n") if f.strip()]
        highlights = re.findall(r"by " + re.escape(by.group(1).strip()) + r" (.*?) More for your store", txt)
        out.append({
            "slug": slug, "name": name, "studio": studio, "price": price, "tagline": tagline,
            "rating": int(rating.group(1)) if rating else None,
            "catalogSize": cat.group(1) if cat else None,
            "industries": inds, "highlights": (highlights[0][:600] if highlights else ""),
            "features": " ".join(feature_list)[:900],
            "url": f"https://themes.shopify.com/themes/{slug}", "image": shot(page, name) or (img_m.group(1) if img_m else None),
        })
        print("ok", studio, name, price, "|", tagline[:60], file=sys.stderr)

json.dump(out, open("data/themes.json", "w"), indent=1)
# The Out of the Sandbox themes sold off the Theme Store (Flex, Turbo, Superstore, Vino, Launch, Pacific) were added
# from outofthesandbox.com/products.json on 2026-11-26. lib/themes.ts is data/themes.json wrapped as a TS export.
print(len(out), "themes", file=sys.stderr)
