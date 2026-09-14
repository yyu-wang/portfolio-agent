import { defineConfig } from 'vite';
import { sseMockPlugin } from './src/mock/sse-mock';

export default defineConfig({
  plugins: [sseMockPlugin()],
  server: { port: 5173 },
});
