// Build-time flags Vite puts on import.meta.env.

interface ImportMetaEnv {
  /** "1" builds the hosted demo: no keys needed, calls go through /api (src/core/demo.ts). */
  readonly VITE_ORBIT_DEMO?: string;
}
