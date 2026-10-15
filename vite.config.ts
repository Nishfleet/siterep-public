import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import Beasties from "beasties";

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

export default defineConfig({
  plugins: [react(), tailwindcss(), inlineStylesheet()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
