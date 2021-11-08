import { createFilter } from '@rollup/pluginutils'
import { SFCBlock, TemplateCompileOptions } from '@vue/component-compiler-utils'
import fs from 'fs'
import { Plugin, ViteDevServer } from 'vite'
import { handleHotUpdate } from './hmr'
import { transformVueJsx } from './jsxTransform'
import { transformMain } from './main'
import { transformStyle } from './style'
import { normalizeComponentCode } from './utils/componentNormalizer'
import { getDescriptor } from './utils/descriptorCache'
import { parseVueRequest } from './utils/query'
import { vueHotReloadCode } from './utils/vueHotReload'

export const vueComponentNormalizer = '\0/vite/vueComponentNormalizer'
export const vueHotReload = '\0/vite/vueHotReload'

// extend the descriptor so we can store the scopeId on it
declare module '@vue/component-compiler-utils' {
  interface SFCDescriptor {
    id: string
  }
}

export interface VueViteOptions {
  include?: string | RegExp | (string | RegExp)[]
  exclude?: string | RegExp | (string | RegExp)[]
  /**
   * The options for `@vue/component-compiler-utils`.
   */
  vueTemplateOptions?: Partial<TemplateCompileOptions>
  /**
   * The options for jsx transform
   * @default false
   */
  jsx?: boolean
  /**
   * The options for `@vue/babel-preset-jsx`
   */
  jsxOptions?: Record<string, any>
  /**
   * The options for esbuld to transform script code
   */
  target?: string
}

export interface ResolvedOptions extends VueViteOptions {
  root: string
  devServer?: ViteDevServer
  isProduction: boolean
  target?: string
}

export function createVue1Plugin(rawOptions: VueViteOptions = {}): Plugin {
  const options: ResolvedOptions = {
    isProduction: process.env.NODE_ENV === 'production',
    ...rawOptions,
    root: process.cwd(),
  }

  const filter = createFilter(options.include || /\.vue1$/, options.exclude)

  return {
    name: 'vite-plugin-vue1',

    config(config) {
      if (options.jsx) {
        return {
          esbuild: {
            include: /\.ts$/,
            exclude: /\.(tsx|jsx)$/,
          },
        }
      }
    },

    handleHotUpdate(ctx) {
      if (!filter(ctx.file)) {
        return
      }
      return handleHotUpdate(ctx, options)
    },

    configResolved(config) {
      options.isProduction = config.isProduction
      options.root = config.root
    },

    configureServer(server) {
      options.devServer = server
    },

    async resolveId(id) {
      if (id === vueComponentNormalizer || id === vueHotReload) {
        return id
      }
      // serve subpart requests (*?vue1) as virtual modules
      if (parseVueRequest(id).query.vue1) {
        return id
      }
    },

    load(id) {
      if (id === vueComponentNormalizer) {
        return normalizeComponentCode
      }

      if (id === vueHotReload) {
        return vueHotReloadCode
      }

      const { filename, query } = parseVueRequest(id)
      // select corresponding block for subpart virtual modules
      if (query.vue1) {
        if (query.src) {
          return fs.readFileSync(filename, 'utf-8')
        }
        const descriptor = getDescriptor(filename)!
        let block: SFCBlock | null | undefined

        if (query.type === 'script') {
          block = descriptor.script!
        } else if (query.type === 'template') {
          block = descriptor.template!
        } else if (query.type === 'style') {
          block = descriptor.styles[query.index!]
        } else if (query.index != null) {
          block = descriptor.customBlocks[query.index]
        }
        if (block) {
          return {
            code: block.content,
            map: block.map as any,
          }
        }
      }
    },

    async transform(code, id) {
      const { filename, query } = parseVueRequest(id)

      if (/\.(tsx|jsx)$/.test(id)) {
        return transformVueJsx(code, id, options.jsxOptions)
      }

      if ((!query.vue1 && !filter(filename)) || query.raw) {
        return
      }

      if (!query.vue1) {
        // main request
        return await transformMain(code, filename, options, this)
      }

      const descriptor = getDescriptor(query.from || filename)!
      // sub block request
      if (query.type === 'template') {
        const escaped = code
          .replace(/(\r\n|\n|\r)/gm, '')
          .replaceAll("'", "\\'")
        return {
          code: `export default '${escaped}';`,
          map: null,
        }
      }
      if (query.type === 'style') {
        return await transformStyle(
          code,
          filename,
          descriptor,
          Number(query.index),
          this
        )
      }
    },
  }
}
