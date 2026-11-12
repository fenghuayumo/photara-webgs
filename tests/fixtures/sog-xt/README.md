# SOG-XT native compatibility fixtures

These are synthetic 17-Gaussian scenes, not user reconstruction data.
Generated against the local Studio sources at revision b8f2969, using
`build/photara/Release/photara_splat_formats_test.exe` on 2026-11-12.
Relevant sources: `photara/src/splat/formats_sog_xt.cpp`, `formats.cpp`.

- `degree0` through `degree3`: Studio native version-2 exports and the PLY files
  produced by decoding those exports. 8×8 grids deliberately contain padding;
  odd degrees use the antialiased flag.
- `v1-degree1`: the degree-1 export with version-1 coefficient-major quantizer
  ranges, decoded independently by Studio to its paired PLY.
- `reference.sog-xt`: degree-3 images with ordinary block YAML, no format,
  version, count or degree, and no quantizer levels. This exercises the
  reference code-extrema normalization. Its paired PLY was decoded by Studio.
- `unbundled`: degree-3 images and JSON-as-YAML native metadata; reference YAML
  provides a second metadata variant pointing to the same sibling images.

Regenerate with `python scripts/generate-sog-xt-fixtures.py --native EXE_PATH`.
The generator does not need NumPy or Pillow; PyYAML is used
only to emit ordinary block YAML. The native executable needs its usual DLLs.
The browser tests compare all numeric attributes and SH against native PLY,
then verify packed GPU palette rendering across lenses.
