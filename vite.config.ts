import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

const BOOTSTRAP_SCRIPT =
  '(()=>{const styleMeta=document.querySelector("meta[name=app-style]"),url=document.querySelector("meta[name=app-entry]").content;let styled=!styleMeta,painted=false,started=false;const go=()=>{if(started||!styled||!painted)return;started=true;requestAnimationFrame(()=>{setTimeout(()=>{import(url)},0)})};const mark=()=>{styled=true;go()};const seen=()=>{painted=true;go()};const check=()=>performance.getEntriesByName("first-contentful-paint").length>0;const start=()=>{if(check()||document.hidden)return seen();try{new PerformanceObserver((list,observer)=>{if(check()){observer.disconnect();seen()}}).observe({type:"paint",buffered:true})}catch(error){seen()}setTimeout(seen,2500)};if(styleMeta){const link=document.createElement("link");link.rel="stylesheet";link.href=styleMeta.content;link.onload=mark;link.onerror=mark;document.head.appendChild(link);setTimeout(mark,3000)}if(document.readyState==="complete")start();else window.addEventListener("load",start)})()';

function deferAppStylesheet(): Plugin {
  return {
    name: "defer-app-stylesheet",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const link = html.match(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
        if (!link) throw new Error("defer-app-stylesheet: the app stylesheet link is missing from index.html");
        return html.replace(link[0], () => `<meta name="app-style" content="${link[1]}">`);
      },
    },
  };
}

function inlineBootstrap(): Plugin {
  return {
    name: "inline-bootstrap",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        if (!bundle) return html;
        const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
        const entry = chunks.find((item) => item.isEntry);
        const mount = chunks.find((item) => item.isDynamicEntry && item.facadeModuleId?.endsWith("/src/mount.tsx"));
        if (!entry || !mount) throw new Error("inline-bootstrap: entry or mount chunk not found");
        const tag = `<script type="module" crossorigin src="/${entry.fileName}"></script>`;
        if (!html.includes(tag)) throw new Error("inline-bootstrap: entry script tag not found");
        return html.replace(tag, () => `<meta name="app-entry" content="/${mount.fileName}">\n    <script type="module">${BOOTSTRAP_SCRIPT}</script>`);
      },
    },
  };
}

export default defineConfig({
  plugins: [preact(), tailwindcss(), deferAppStylesheet(), inlineBootstrap()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
