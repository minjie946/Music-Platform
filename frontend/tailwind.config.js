/** @type {import('tailwindcss').Config} */

// Theme tokens (dark). The app uses Tailwind's single gray scale plus a custom
// `brand` scale across ~870 utility usages, so the design system is expressed by
// remapping these scales rather than rewriting every class.
//
// Prototype "Music Studio v1" palette (4-tier background):
// Surfaces:  base #0E0E13 (950) → card/sidebar #111116 (900) → topbar #0B0B0F · modal #1A1A24
// Borders:   default #24242C (gray-800, ≈white/10) · strong #303039 (gray-700, ≈white/10-15)
// Text:      primary #F2F3F7 · secondary #A8AEBF · placeholder #6C7384 · disabled #4A4A55
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutral scale (dark theme): 950 = darkest base, 50 = lightest text.
        // Prototype 4-tier surfaces: base #0E0E13 (950) → card/sidebar #111116 (900).
        // gray-800/700 are used mostly for borders; set to near-white-gray solids
        // that read as the prototype's white/10 hairlines on the dark ground.
        gray: {
          50: "#F8FAFC",
          100: "#F2F3F7", // 正文 / primary text
          200: "#E4E7EF",
          300: "#C4CAD8",
          400: "#A8AEBF", // 次要 / secondary text
          500: "#6C7384", // 占位 / placeholder + subtle hover border
          600: "#4A4A55", // 禁用 / disabled text + emphasized border
          700: "#303039", // 边框（强）/ input & interactive border ≈ white/10-15
          800: "#24242C", // 边框（默认）/ dividers & elevated surfaces ≈ white/10
          900: "#111116", // 卡片 / 侧栏 surface (L2)
          950: "#0E0E13", // 底 / base background (L1)
        },
        // Brand indigo-violet — only for primary action / selected / brand.
        // Prototype: default #5B54E6 (600) · hover #6C65E8 (500, lighter).
        // 500 is now lighter than 600 so hover:bg-brand-500 gives the prototype's
        // lighten-on-hover behavior.
        brand: {
          50: "#F4F3FE",
          100: "#ECEAFD",
          200: "#D7D3FB",
          300: "#B9B2F7", // light accent text on dark
          400: "#9D93F4",
          500: "#6C65E8", // hover / accent (lighter than default)
          600: "#5B54E6", // default brand / resting primary button
          700: "#4A3DD0", // pressed
          800: "#3A2FA8",
          900: "#262073",
          950: "#171347",
        },
        // Semantic — desaturated, each with a deep tint for alert backgrounds.
        // 成功 #3DD68C
        emerald: {
          50: "#ECFBF3",
          100: "#D2F5E1",
          200: "#A7ECC6",
          300: "#74E2A8",
          400: "#54DD98",
          500: "#3DD68C",
          600: "#2FB877",
          700: "#259460",
          800: "#1B6E49",
          900: "#123A2A",
          950: "#0B2419",
        },
        // 警告 #F5A524
        amber: {
          50: "#FEF6E7",
          100: "#FDE9C2",
          200: "#FAD68A",
          300: "#F8C254",
          400: "#F6B339",
          500: "#F5A524",
          600: "#D9881A",
          700: "#A66512",
          800: "#6E430C",
          900: "#462D08",
          950: "#2C1C05",
        },
        // 危险 #F0556B（比纯红柔和）
        red: {
          50: "#FDECEE",
          100: "#FBD2D8",
          200: "#F7AAB4",
          300: "#F58A98",
          400: "#F26F82",
          500: "#F0556B",
          600: "#D63E55",
          700: "#A62E41",
          800: "#6E1F2C",
          900: "#46161F",
          950: "#2C0D14",
        },
        // 信息 #4AA8F0 (blue/sky aliased to the same anchor)
        blue: {
          50: "#EAF4FE",
          100: "#C9E4FC",
          200: "#9CCDF8",
          300: "#71B8F4",
          400: "#5BB0F2",
          500: "#4AA8F0",
          600: "#2F8AD6",
          700: "#246AA6",
          800: "#1B4E78",
          900: "#12324C",
          950: "#0B2034",
        },
        sky: {
          50: "#EAF4FE",
          100: "#C9E4FC",
          200: "#9CCDF8",
          300: "#71B8F4",
          400: "#5BB0F2",
          500: "#4AA8F0",
          600: "#2F8AD6",
          700: "#246AA6",
          800: "#1B4E78",
          900: "#12324C",
          950: "#0B2034",
        },
      },
      backgroundImage: {
        "brand-logo": "linear-gradient(135deg, #5B54E6 0%, #9B6CF0 50%, #E168B0 100%)",
      },
    },
  },
  plugins: [],
};
