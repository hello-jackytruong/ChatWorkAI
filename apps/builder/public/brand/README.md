# ChatWorkAI brand assets

The horizontal logo and rabbit mark are extracted from the supplied
`ChatWork_AI_logo_design_6e3738a7.jpg`. The twelve illustrations in `mascots/`
are cropped from the two supplied six-panel JPEG sheets. The original artwork
is retained; the pale background and ground shadows are removed. White areas
inside the illustrations remain opaque. No generated redraw is used.

- `logo.png` / `logo.webp`: color wordmark for light surfaces, cropped to keep
  only the lettering without the leading rabbit mark.
- `logo-light.png` / `logo-light.webp`: horizontal logo with the dark end of the
  lettering lightened for dark surfaces, with the same wordmark-only crop.
- `icon.png` / `icon.webp`: transparent square rabbit mark.
- `mascots/{security,maintenance,analytics,error,search,achievement,welcome,thinking,coding,success,info,delivery}.{png,webp}`:
  individually cropped illustrations with transparent padding.
- PNGs are lossless interchange files; WebPs are lossless web alternatives.
  All outputs are sRGB and omit source metadata.

The existing SVG URLs remain compatible: `logo_black.svg` is the horizontal
logo for light surfaces; `logo_white.svg` is the version for dark surfaces.
`logo.svg`, `icon_black.svg`, and `icon_white.svg` contain the square color
mark. `icon_bg.svg` adds a light background. These SVGs embed lossless WebP data to work
as standalone browser images: they are raster containers, **not traced vector
artwork**. Wordmark PNG/WebP files and embedded logo images are 754 × 145 px;
embedded icons are 256 px. Prefer the WebP files for new web uses. The rabbit
mark remains available separately in the icon and favicon assets.

`favicon/` contains a multi-size ICO (16/32/48/64), SVG, 96 px browser PNG,
180 px Apple touch icon, and 192/512 px manifest icons. Installation icons use
an opaque light background and centered artwork with padding for masking.
The manifest refers to the actual exported filenames.

Platform and tenant logo URLs continue to resolve through the existing
branding settings. Custom tenant-uploaded branding is unaffected.
