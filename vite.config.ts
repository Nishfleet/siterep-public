import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import Beasties from "beasties";

const BOOTSTRAP_SCRIPT =
  'window.addEventListener("load",()=>{requestAnimationFrame(()=>{setTimeout(()=>{import(document.querySelector("meta[name=app-entry]").content)},0)})})';

function inlineStylesheet(): Plugin {
  return {
    name: "inline-stylesheet",
    apply: "build",
    enforce: "post",
    async transformIndexHtml(html, { bundle }) {
      if (!bundle) return html;
      const beasties = new Beasties({ path: "/", publicPath: "/", inlineThreshold: 400_000, pruneSource: false, logLevel: "warn" });
      beasties.readFile = (file: string) => {
        const asset = bundle[file.replace(/^\/+/, "")];
        if (asset?.type !== "asset") throw new Error(`stylesheet ${file} is not in the bundle`);
        return String(asset.source);
      };
      const inlined = await beasties.process(html);
      for (const [name, asset] of Object.entries(bundle)) {
        if (asset.type === "asset" && name.endsWith(".css") && !inlined.includes(name)) delete bundle[name];
      }
      return inlined;
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
  plugins: [react(), tailwindcss(), inlineStylesheet(), inlineBootstrap()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
