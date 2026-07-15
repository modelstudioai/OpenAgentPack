/**
 * Dev-only entry for embedding webui inside a host page (e.g. 百炼控制台)
 * that bypasses our index.html.
 *
 * Why: @vitejs/plugin-react injects the React Refresh preamble into index.html.
 * When the host page directly loads /src/main.tsx, the preamble never runs and
 * every .tsx module throws "can't detect preamble".
 *
 * This file is plain .ts (no JSX), so it does NOT get the preamble check.
 * We install the preamble globals manually, then dynamic-import the real entry.
 *
 * Tell the host gateway to load:
 *   http://localhost:5173/src/dev-bootstrap.ts
 * instead of /src/main.tsx.
 */

// @ts-expect-error - virtual module provided by @vitejs/plugin-react in dev
import RefreshRuntime from "/@react-refresh";

RefreshRuntime.injectIntoGlobalHook(window);
(window as unknown as { $RefreshReg$: () => void }).$RefreshReg$ = () => {};
(window as unknown as { $RefreshSig$: () => (t: unknown) => unknown }).$RefreshSig$ = () => (type) => type;
(window as unknown as { __vite_plugin_react_preamble_installed__: boolean }).__vite_plugin_react_preamble_installed__ =
	true;

// Now it's safe to load the real entry
await import("./main.tsx");
