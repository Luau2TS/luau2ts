import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <img
          src="img/logo.png"
          alt="luau2ts"
          style={{ width: 160, height: 160, marginBottom: '1.5rem' }}
        />
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link className="button button--secondary button--lg" to="/docs/">
            Get started →
          </Link>
          <Link
            className="button button--outline button--lg"
            to="/playground"
            style={{ marginLeft: '0.75rem' }}
          >
            Try it live
          </Link>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={siteConfig.title}
      description="Compile Luau to TypeScript for Roblox. Drop-in compatible with roblox-ts."
    >
      <HomepageHeader />
      <main className={styles.main}>
        <section className={styles.section}>
          <div className="container">
            <Heading as="h2">Why?</Heading>
            <p>
              <a href="https://roblox-ts.com">roblox-ts</a> compiles TypeScript to
              Luau. <code>luau2ts</code> is the mirror: it compiles{' '}
              <strong>Luau to TypeScript</strong>. Migrate an existing Luau codebase
              to TS, run authored Luau through TS-native tooling, or round-trip with
              roblox-ts.
            </p>
          </div>
        </section>

        <section className={styles.section}>
          <div className="container">
            <Heading as="h2">Install</Heading>
            <pre>
              <code>npm install -g luau2ts</code>
            </pre>
            <p>Then:</p>
            <pre>
              <code>{`luau2ts foo.luau                     # → stdout
luau2ts foo.luau -o foo.ts           # → file
luau2ts src/ -o out/                 # → directory tree
luau2ts -p default.project.json -o out/   # → Rojo project`}</code>
            </pre>
          </div>
        </section>

        <section className={styles.section}>
          <div className="container">
            <Heading as="h2">Compatibility</Heading>
            <p>
              Ships two emit modes: <code>rbxts</code> for the{' '}
              <code>@rbxts/*</code> ecosystem, and <code>native</code> for runtimes
              that mirror Roblox's Luau API. 100% Luau conformance against the
              upstream test suite. Source maps included.
            </p>
            <p>
              <Link to="/docs/">Read the docs →</Link>
            </p>
          </div>
        </section>
      </main>
    </Layout>
  );
}
