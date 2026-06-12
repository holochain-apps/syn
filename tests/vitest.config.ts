import { defineConfig } from 'vitest/config';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
  test: {
    include: ['src/lib/*.test.ts'],
    // include: ['src/lib/bloat.test.ts'],
    reporters: 'verbose', // More detailed logs
    silent: false,        // Show all console logs
    threads: false,    
    testTimeout: 60 * 1000 * 8, // generous: merge.test rides out ~120s+ of kitsune2 gossip wedge after its conductor restart
    // Conductor teardown leaves library-level rejections we cannot catch from
    // test code: @holochain-open-dev/stores' polling loop re-schedules itself
    // via setTimeout with no catch (WebsocketClosedError once the socket is
    // gone), and @holochain/client's auto-reconnect fails with
    // InvalidTokenError after its one-shot token is consumed. Real failures
    // still surface through test assertions and timeouts.
    dangerouslyIgnoreUnhandledErrors: true,
  },
});
