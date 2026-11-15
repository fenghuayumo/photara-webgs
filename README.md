# Photara WebGS

A WebGPU Gaussian Splatting viewer and embeddable renderer following Photara's 3DGS / 3DGUT conventions. Built with native ES Modules and WGSL, with no third-party runtime dependencies.

**Website: [https://fenghuayumo.github.io/photara-webgs/](https://fenghuayumo.github.io/photara-webgs/)**

[Quick Start](#quick-start) · [Embedding](#embedding) · [Development and Testing](#development-and-testing) · [Deployment](#deployment) · [Documentation](#documentation)

## Features

- Load PLY, SOG v2, and SOG-XT files, including separate SOG / SOG-XT metadata and images via URL.
- Render 3DGS and 3DGUT with pinhole, orthographic, fisheye, and equirectangular cameras.
- Explore scenes with orbit controls, free flight, double-click focusing, or calibrated cameras.
- Use full sorted rendering by default, with optional stochastic rendering and denoising during movement.
- Integrate the `<photara-viewer>` Web Component or use the standalone rendering API.
- Switch between English and Chinese. The initial language follows the browser preference; manual selections are saved locally.
- Parse locally selected or dropped models in the browser without uploading them. Rendering runs on demand and pauses when idle or hidden.

## Requirements

- **Node.js 20+** for local development; CI uses Node.js 22.
- A browser with **WebGPU** support and an available GPU adapter.
- Access through **HTTPS or localhost**. Opening `index.html` directly from the filesystem is not supported.
- SOG image decoding additionally requires OffscreenCanvas / WebGL2 inside a Worker.

There is no WebGL rendering fallback. Available device memory and GPU limits determine the maximum practical model size.

## Quick Start

```sh
git clone https://github.com/fenghuayumo/photara-webgs.git
cd photara-webgs
npm run dev
```

Open [http://localhost:4173](http://localhost:4173), select or drop a `.ply`, `.sog`, or `.sog-xt` file, or load the synthetic demo. No dependency installation is needed to start the development server.

### Camera Controls

| Input | Orbit mode | Free-flight mode |
| --- | --- | --- |
| Left-button / one-finger drag | Rotate around the focus point | Look around |
| Right-button / two-finger drag | Pan | Pan |
| Scroll wheel / pinch | Move toward or away from the focus point | Move along the viewing direction |
| WASD / Q, E | Enter free-flight mode | Move forward, left, back, right / down, up |
| Shift / Alt | — | Move at 10× / 0.1× speed |
| Double-click a model | Center and set the focus point | Center and return to orbit mode |
| V / R | Switch modes / reset the view | Switch modes / reset the view |

Keyboard controls are active only when the canvas has focus.

## Embedding

Copy the entire `src/` directory into your website, preserving the relative paths of shaders, workers, and stylesheets:

```html
<script type="module" src="./photara-webgs/src/index.js"></script>
<photara-viewer src="./assets/scene.ply"></photara-viewer>
```

The component isolates its styles using Shadow DOM. Add the `demo` attribute to display synthetic data. See [examples/embed.html](examples/embed.html) for a complete example.

```js
await customElements.whenDefined('photara-viewer');
const viewer = document.querySelector('photara-viewer');
viewer.addEventListener('model-load', event => console.log(event.detail));
viewer.addEventListener('viewer-error', event => console.error(event.detail));
await viewer.load('./assets/scene.sog');
```

`load()` also accepts `File`, `Blob`, and `ArrayBuffer`. An input `ArrayBuffer` is transferred to the Worker, detaching the original buffer. Updating `src` cancels the previous load; removing the component releases its Worker and GPU resources.

Remote model servers must allow CORS. Your Content Security Policy must permit same-origin module workers, shader fetches, and stylesheets. See the [technical reference](docs/technical-reference.md) for the rendering API, camera configuration, and format options.

## Development and Testing

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local development server on port 4173 |
| `npm run build` | Build the static website into `dist/` |
| `npm test` | Run core tests without third-party dependencies |
| `npm run test:gpu` | Run browser-based WebGPU regression tests |
| `npm run test:sog` | Test SOG decoding, Worker loading, and GPU rendering |
| `npm run test:sog-xt` | Test SOG-XT compatibility and rendering |

Browser tests require Playwright and Chromium:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:gpu
```

Set `BROWSER_EXECUTABLE` to use a specific browser executable, or `PLAYWRIGHT_MODULE_PATH` to use an existing Playwright package. See the [technical reference](docs/technical-reference.md) and [fixture notes](tests/fixtures/sog/README.md) for model fixtures and test prerequisites. Test output is written to the Git-ignored `test-results/` directory. The GPU test server uses port 4174.

### Project Structure

```text
.github/workflows/  GitHub Pages deployment workflow
src/               Viewer, loaders, GPU renderer, and WGSL shaders
examples/          Embedding example and calibrated camera
scripts/           Development server, build, testing, and benchmarking tools
tests/             Core tests, browser regressions, and fixtures
docs/              Technical reference, performance reports, and limitations
index.html         Viewer homepage
```

## Deployment

### GitHub Pages

The repository includes a [GitHub Actions deployment workflow](.github/workflows/pages.yml).

1. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
2. Push to `master`, or manually run **Deploy GitHub Pages** from the Actions tab.
3. The workflow runs core tests, builds the static site, and deploys `dist/`.
4. Once deployment succeeds, visit the [Photara WebGS website](https://fenghuayumo.github.io/photara-webgs/). If a custom domain is configured, use the URL shown in Pages settings and the deployment output.

GitHub Pages for private repositories requires an eligible account plan. The build includes only website assets, excluding local models and test reports. Visitors open their own model files.

### Other Static Hosts

```sh
npm run build
```

Publish the contents of `dist/` to a static host with HTTPS. Preserve the directory structure and serve JavaScript modules with the appropriate MIME type.

## Documentation

The following technical documents are currently written in Chinese.

- [Technical reference and validation records](docs/technical-reference.md): API examples, camera conventions, format semantics, rendering pipeline, and historical validation.
- [Real-scene comparisons](docs/real-scene-comparison.md) and [large office-scene benchmarks](docs/office-cleaned-benchmark.md).
- [GUT pipeline optimization](docs/1023-gut-optimization.md), [GPU memory](docs/1023-memory-optimization.md), [CPU loading](docs/1023-sog-loading.md), and [spatial blocks](docs/1023-spatial-blocks.md).
- [Stochastic rendering](docs/stochastic-rendering.md), [spatiotemporal reconstruction](docs/stochastic-reconstruction.md), [SVGF + TAA](docs/svgf-taa.md), and [Neural Lite denoising](docs/neural-denoising.md).
- [Planned improvements](docs/next-improvements.md).

## Known Limitations

- Parameters, coordinates, and Gaussian responses follow C++ Studio conventions, but pixel-identical output is not guaranteed. Some real GUT scenes still show noticeable differences.
- Training, depth/normal output, animation, mesh compositing, independent placement of multiple models, LOD, and streaming are not supported.
- SOG compatibility has explicit format limits. Large real-world SOG-XT performance has not yet been validated; see the technical reference.
- Interactive acceleration can introduce noise, softened details, and ghosting, and does not guarantee a speedup in every scene. Exact screenshots continue to use full sorted rendering.

## Feedback and Contributions

Report bugs and suggestions through [GitHub Issues](https://github.com/fenghuayumo/photara-webgs/issues). For rendering issues, include your browser and GPU, model format, reproduction steps, and screenshots or error messages. Run the relevant tests after making changes; GPU and format changes should also pass the corresponding browser regressions.

## License

This repository does not currently include a `LICENSE` file. Contact the maintainer to confirm permission before reusing or distributing the code.
