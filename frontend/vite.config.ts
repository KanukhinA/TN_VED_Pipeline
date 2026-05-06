import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("xlsx")) {
              return "vendor-xlsx";
            }
            if (id.includes("react-dom") || id.includes("react-router") || id.includes("/react/")) {
              return "vendor-react";
            }
            return "vendor";
          }
          if (id.includes("tnVedChildren.generated")) {
            return "data-tn-ved-children";
          }
        },
      },
    },
    // Единственный крупный чанк — сгенерированное дерево ТН ВЭД (`tnVedChildren.generated.ts`).
    chunkSizeWarningLimit: 4500,
  },
});

