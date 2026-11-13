import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Relative asset URLs, so the same build works at a domain root (Vercel)
  // and under a project sub-path (for example GitHub Pages).
  base: './',
  plugins: [tailwindcss()],
})
