# README figure source

This optional renderer uses [Stageshow](https://github.com/benjitaylor/skills/tree/main/stageshow), adapted from its `static-card` and `overlap` examples. The composition uses actual app captures. It is not a recorded interaction or evidence of a new model run. Captured text and values stay as recorded. `ReadmeCapture.tsx` is shared with the README figures of my other projects, so it also holds their entries; only the `observable` entry is used here.

To reproduce it, load the Stageshow kit, copy this folder into `examples/readme-observable`, and copy the inputs below into `playground/public/readme-captures/`. Run the kit's local Vite preview and open `?capture=readme-observable&still=1`. Add `&compact=1` for the compact design. The app itself does not import this renderer.

Inputs, relative to this repository:

- `docs/assets/experiment-log-expanded.png` → `lab-log.png`

The Stageshow-derived source retains its MIT notice in `LICENSE.stageshow.txt`. The app captures and third-party content retain their own terms.

The current README uses plain app captures and the labelled room GIF. The old rendered figures are excluded because they showed assets removed from the app. Regenerate any future figure from the current captures.
