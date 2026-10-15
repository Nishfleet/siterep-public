# Launch video source

HyperFrames (Apache-2.0, pinned 0.8.149) composition for the Site Rep launch video. Script and claim sources: `SCRIPT.md`.

- Install once: `npm ci` (lockfile pins hyperframes 0.8.149 and its dependencies). `assets/gsap.min.js` is GSAP 3.14.2, vendored from `https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js` (GreenSock standard licence), sha256 `c174bfce53a729418d57a8ad8625e7247c793a22fef8e2851e3cfa3de9cd8280`, byte-identical to that URL when checked on 2026-10-15.
- Check: `npm run check`
- Render: `npm run render` (1920x1080 mp4, one render at a time)
- Music: `assets/music.mp3` is not committed. "Inspired" by Kevin MacLeod (incompetech.com), CC BY 4.0 https://creativecommons.org/licenses/by/4.0/ . Download it from https://incompetech.com/music/royalty-free/mp3-royaltyfree/Inspired.mp3 into `assets/`. Credit line when posting: `Music: "Inspired" by Kevin MacLeod (incompetech.com), CC BY 4.0`.
- Delete: remove this folder. Nothing else references it.
