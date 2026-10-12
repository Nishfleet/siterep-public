# Launch video source

HyperFrames (Apache-2.0, pinned 0.8.149) composition for the Site Rep launch video. Script and claim sources: `SCRIPT.md`.

- Install once: `npm ci` (lockfile pins hyperframes 0.8.149 and its dependencies). `assets/gsap.min.js` is GSAP 3.14.2, vendored from jsDelivr (GreenSock standard licence).
- Check: `npm run check`
- Render: `npm run render` (1920x1080 mp4, one render at a time)
- Music: `assets/music.mp3` is not committed. "Inspired" by Kevin MacLeod (incompetech.com), CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ . Download it from https://incompetech.com/music/royalty-free/mp3-royaltyfree/Inspired.mp3 into `assets/`. Credit line when posting: `Music: "Inspired" by Kevin MacLeod (incompetech.com), CC BY 4.0`.
- Delete: remove this folder. Nothing else references it.
