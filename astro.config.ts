import { defineConfig } from "astro/config";
import icon from "astro-icon";

export default defineConfig({
  integrations: [
    icon({
      include: {
        "material-symbols": [
          "arrow-back",
          "zoom-out",
          "zoom-in",
          "download",
          "chevron-left",
          "chevron-right",
          "menu-book",
          "fullscreen",
          "fullscreen-exit",
          "devices",
        ],
      },
    }),
  ],
  devToolbar: {
    enabled: false,
  },
});
