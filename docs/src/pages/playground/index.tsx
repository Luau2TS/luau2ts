import type { ReactNode } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Layout from '@theme/Layout';

export default function PlaygroundPage(): ReactNode {
  return (
    <Layout
      title="Playground"
      description="Compile Luau to TypeScript live, with native and roblox-ts compat modes."
    >
      <BrowserOnly fallback={<div style={{ padding: '2rem' }}>Loading playground…</div>}>
        {() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const Playground = require('./Playground').default;
          return <Playground />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
