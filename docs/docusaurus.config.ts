import type { Config, PluginOptions } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

/** Custom plugin: short-circuit the Node-only imports the WASM glue
 *  references (`node:module`, `node:fs`, `node:path`, etc.). The
 *  Emscripten glue only reads these when running under Node; the browser
 *  branch never touches them. Webpack's strict resolver needs both
 *  `resolve.fallback: false` for bare names AND a
 *  NormalModuleReplacementPlugin for the `node:` scheme since
 *  resolve.fallback doesn't intercept that.
 *
 *  This is the same shim used in the rbx-web Docusaurus site for the
 *  same Luau WASM parser. */
function nodeShimPlugin(): PluginOptions {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const shimPath = path.resolve(__dirname, 'src', 'empty-shim.js');
  return {
    name: 'luau2ts-node-shim',
    configureWebpack() {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const webpack = require('webpack');
      return {
        resolve: {
          fallback: {
            module: false,
            fs: false,
            path: false,
            url: false,
            crypto: false,
          },
        },
        plugins: [
          new webpack.NormalModuleReplacementPlugin(
            /^node:(module|fs|path|url|crypto)$/,
            (resource: { request: string }) => {
              resource.request = shimPath;
            },
          ),
        ],
      };
    },
  } as unknown as PluginOptions;
}

const config: Config = {
  title: 'luau2ts',
  tagline: 'A Luau-to-TypeScript compiler for Roblox.',
  favicon: 'img/logo.png',

  url: 'https://luau2ts.dev',
  baseUrl: '/',

  organizationName: 'luau2ts',
  projectName: 'luau2ts',

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: [() => nodeShimPlugin()],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/luau2ts/luau2ts/tree/main/docs/',
          routeBasePath: 'docs',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    navbar: {
      title: 'luau2ts',
      logo: {
        alt: 'luau2ts logo',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'mainSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/playground',
          label: 'Playground',
          position: 'left',
        },
        {
          href: 'https://github.com/luau2ts/luau2ts',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Quick start', to: '/docs/quick-start' },
            { label: 'Setup guide', to: '/docs/setup-guide' },
            { label: 'CLI usage', to: '/docs/usage' },
            { label: 'API', to: '/docs/api/compile-options' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: 'https://github.com/luau2ts/luau2ts' },
            { label: 'npm', href: 'https://www.npmjs.com/package/luau2ts' },
            { label: 'Issues', href: 'https://github.com/luau2ts/luau2ts/issues' },
          ],
        },
        {
          title: 'Related',
          items: [
            { label: 'roblox-ts', href: 'https://roblox-ts.com' },
            { label: 'Rojo', href: 'https://rojo.space' },
            { label: 'Luau', href: 'https://luau.org' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} luau2ts. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['lua', 'typescript', 'bash', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
