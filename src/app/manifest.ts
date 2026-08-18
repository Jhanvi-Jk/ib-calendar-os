import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "IB Calendar OS",
    short_name: "IB OS",
    description:
      "A planner for IB Diploma students that protects your sleep and does the scheduling for you.",
    start_url: "/calendar",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#5b5bd6",
    orientation: "portrait-primary",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      { name: "Today", url: "/calendar" },
      { name: "Tasks", url: "/tasks" },
      { name: "Review", url: "/review" },
    ],
  };
}
