# Recording the room

How `docs/assets/lab-motion.gif` was made, so it can be redone from the actual app.

1. Serve the frontend locally: `npm ci && npx vite --port 5173 --host 127.0.0.1`. With no `POSTGRES_URL` or API behind it, the app runs its own local animation and the panel reads "Simulation: no experiment connected".
2. Capture frames with Playwright's headless Chromium using software WebGL. Software rendering is slow (seconds per frame), so `record-frames.cjs` pauses the page's virtual time and advances it by one frame interval per captured frame; every frame is fully rendered and motion stays smooth whatever the machine's speed. Only the page viewport is captured, no browser chrome, no audio:
   `node docs/capture/record-frames.cjs http://127.0.0.1:5173/ 240 10 ./frames 10000 1280 720`
   (240 frames at 10 fps = 24 s, after a 10 s warm-up for the models to load). `playwright` must be resolvable by Node.
3. Encode: `docs/capture/encode-gif.sh ./frames 10 880 docs/assets/lab-motion.gif` (ffmpeg two-pass palette, 128 colours, Lanczos scaling to 880 px, infinite loop; `COLORS=64` was tried and came out larger because of dithering noise).

What the loop shows is the frontend alone. A connected capture (stored experiment state from Postgres, the sprites path with its token and the operator secret) is a separate recording against a configured run; it is not simulated here.
