import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // GEM CC packages
      "@gem/ui": path.resolve(__dirname, "src/gem/ui"),
      "@gem/types": path.resolve(__dirname, "src/gem/types"),
      "@gem/services": path.resolve(__dirname, "src/gem/services"),
      "@gem/hooks": path.resolve(__dirname, "src/gem/hooks"),
      // Next.js shims
      "next/navigation": path.resolve(__dirname, "src/gem/adapters/next-compat.jsx"),
      "next/link": path.resolve(__dirname, "src/gem/adapters/next-compat.jsx"),
      "next/font/google": path.resolve(__dirname, "src/gem/adapters/next-font-compat.js"),
      // Supabase shim
      "@supabase/ssr": path.resolve(__dirname, "src/gem/adapters/supabase-compat.js"),
      // Lexical
      lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
  // Jennie 2026-04-19 — tạm disable esbuild-transpile để bypass Win temp access-denied bug.
  // Source là modern JSX + TS rất nhẹ; output esnext không cần downlevel. Rollup + @vitejs/plugin-react
  // (babel) vẫn handle JSX/TS. Revert khi fix được root cause filesystem.
  // 2026-04-26 — REVERTED `optimizeDeps.disabled: true` + `commonjsOptions.ignore: react|scheduler`.
  // Cả 2 cùng skip CJS-to-ESM transform cho react packages → bundle giữ nguyên
  // `require("./cjs/react-jsx-runtime.production.js")` → browser fail
  // "Uncaught ReferenceError: require is not defined" → trang trắng.
  // Win temp lock cần fix qua antivirus exclude / OneDrive ignore, KHÔNG bypass CJS transform.
  build: {
    target: "esnext",
    minify: false,
    // ignoreDynamicRequires: bỏ esbuild dynamic-require scanner → dùng regex thay thế
    // KHÁC commonjsOptions.ignore (ignore = skip transform hoàn toàn → require() còn lại → browser crash)
    // ignoreDynamicRequires chỉ skip bước esbuild analysis, vẫn transform CJS→ESM bình thường
    commonjsOptions: {
      ignoreDynamicRequires: true,
    },
  },
  esbuild: false,
});
