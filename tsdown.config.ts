/**
 * Two artifacts from one package: the Node host plugin (plain ESM, emitted by
 * tsc) and the browser client bundle built here.
 *
 * The client bundle speaks the DSH module-loader protocol: the file calls
 * `window.__ModuleLoader__.load({ id, factory })` and resolves its externals
 * through the injected `require`, which is the loader's module table. Only
 * table entries may stay external — a value import of any other DSH package
 * would be a second copy of that package's runtime, so the gate below refuses
 * it. Cross-plugin collaboration goes through cordis services instead.
 */

import type { UserConfig } from 'tsdown'

const ID = 'dsh-plugin-audiolib'

/** Module-table entries the loader's `require` can answer. */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Refuse a value import of any DSH package outside the module table. */
function purityGate(): NonNullable<UserConfig['plugins']>[number] {
  return {
    name: 'audiolib-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the module table — `
        + 'collaborate through cordis services instead of importing it',
      )
    },
  }
}

export default [{
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [purityGate()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}] satisfies UserConfig[]
