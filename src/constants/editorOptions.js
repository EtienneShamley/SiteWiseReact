export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map(
  (n) => ({ label: String(n), value: `${n}px` })
);

export const FONT_FAMILIES = [
  { label: "Inter", value: "Inter, sans-serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Aptos", value: "Aptos, sans-serif" },
  { label: "Calibri", value: "Calibri, sans-serif" },
  { label: "Helvetica", value: "Helvetica, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Verdana", value: "Verdana, sans-serif" },
  { label: "Tahoma", value: "Tahoma, sans-serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
  { label: "Roboto", value: "Roboto, sans-serif" },
];
